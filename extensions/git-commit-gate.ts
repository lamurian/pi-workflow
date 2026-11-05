import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { classifyCommit, type GateOutcome } from "./commit-gate.ts";
import { classifyStagedDiff } from "./staged-diff-guard.ts";
import { TEST_EXTENSION_PATH, type DeclaredFile } from "./contract-guard-core.ts";
import { classifyBaselineDiff, planUnstage } from "./contract-guard-diff.ts";
import { deriveAllowlist } from "./contract-derive.ts";
import {
  filterOrchestratorOwned, NameStatusReadError, ownerlessHalt, readGuardNameStatus,
  runHeadStagedNameStatus, unstageContamination, withRemediation,
} from "./git-guard-diff.ts";
import {
  getCommitTimeoutMs, readChangedPaths, readDiffStat, readGitHead, readTreeState,
} from "./git-ops.ts";
import type { SlopGateRunner } from "./slop-gate.ts";
import type { ImplementerReport } from "./implementer-report.ts";
import type { Behavior, ContractV2, TaskContract } from "./state.ts";

/** Outcome of a commit attempt, classified by the HEAD gate. */
export interface CommitAttempt {
  outcome: Exclude<GateOutcome, { kind: "landed" }> | null;
  /** Best-effort subject when the commit landed. */
  subject?: string;
  /** Remediation note (T6): one line per auto-unstaged cross-task-contaminated path, naming
   *  the path, its owning task(s) and the `git restore --staged -- <path>` command — the work
   *  stays on disk. Absent when nothing was unstaged. */
  remediation?: string[];
  /** Slop-gate advisory notes (T5) from a landed commit, appended to the findings ledger. */
  slopNotes?: string[];
}

/**
 * Pick the conventional commit subject: the subagent's suggestion, or a generic
 * subject so a missing suggestion never blocks the commit step.
 * @param report - parsed report; @param behavior - the behavior being committed.
 * @returns A conventional commit subject line (no behavior id).
 */
export function pickCommitSubject(
  report: ImplementerReport,
  behavior: Behavior,
): string {
  const suggested = report.suggestedCommit?.trim();
  if (suggested) return suggested;
  return `feat: implement ${behavior.description}`.slice(0, 75);
}

/** Build the contract-guard halt from a baseline classification (T3: shared by the v2 teeth guard and the v1 staged guard; never commits). */
function guardHalt(result: ReturnType<typeof classifyBaselineDiff>): CommitAttempt {
  return { outcome: { kind: "contract-guard", investigation: result.investigation, violations: result.violations } };
}

/**
 * Read the WORKTREE name-status vs the baseline (T3 allowlist teeth), filtering a
 * chore-only change to the orchestrator-owned test extension via a WORKTREE-vs-HEAD
 * query (bug 1): a post-baseline chore commit drops the line, a unit edit keeps it.
 * @param pi - ExtensionAPI. @param cwd - working directory. @param ref - baseline ref.
 * @returns Raw worktree name-status output, or "" when git fails.
 */
async function readTeethNameStatus(pi: ExtensionAPI, cwd: string, ref: string): Promise<string> {
  let res = await pi.exec("git", ["diff", "--name-status", "--no-renames", ref], { cwd });
  if (res.code !== 0 && ref !== "HEAD") {
    res = await pi.exec("git", ["diff", "--name-status", "--no-renames", "HEAD"], { cwd });
  }
  const raw = res.code === 0 ? (res.stdout ?? "") : "";
  const isExt = (line: string) =>
    line.split("\t")[1]?.trim().replace(/^\.\//, "") === TEST_EXTENSION_PATH;
  if (!raw.split("\n").some(isExt)) return raw;
  const head = await pi.exec("git", ["diff", "--name-only", "HEAD", "--", TEST_EXTENSION_PATH], { cwd });
  if (head.code !== 0) return raw; // fail closed: keep the line
  const changed = (head.stdout ?? "").split("\n").map((l) => l.trim()).filter((l) => l === TEST_EXTENSION_PATH);
  return filterOrchestratorOwned(raw, changed);
}

/**
 * Stage the unit's scope and commit with the subject; classify via the HEAD gate.
 * Never passes --no-verify — the pre-commit hooks are the gate; the staged diff is
 * inspected first (undeclared or skip-touching test changes block without invoking
 * the hook). v2 sessions stage only owned paths (`git add -- <paths>`, never
 * `--all`), gate the allowlist on the WORKTREE teeth, and return no-changes without
 * committing when the owned staged set is empty on a dirty tree; v1 keeps stage-all.
 *
 * @param pi / cwd - ExtensionAPI and working directory. @param subject - commit subject.
 * @param behavior - the behavior being committed (for investigations).
 * @param task - contract (declared files + test-kind sourceFiles).
 * @param attempt - 1 = first attempt; >= 2 = fix retry (stricter guard).
 * @param baselineHead - HEAD at /implement start; staged diff measured against it.
 * @param contract - v2 per-task ownership (path-scoped staging, auto-unstaged
 *   contamination with `remediation`); absent = v1 session, plain files list.
 * @param slopRunner - optional slop gate (T5), run after the staged-diff guard and
 *   before `git commit`: a block returns slop-guard without committing; notes ride
 *   back as `slopNotes` when the commit lands. Absent = gate off for this session.
 * @returns The classified commit attempt (plus remediation/slopNotes when present).
 */
export async function commitAndGate(
  pi: ExtensionAPI,
  cwd: string,
  subject: string,
  behavior: Behavior,
  task: TaskContract,
  attempt: number,
  baselineHead?: string,
  contract?: ContractV2,
  slopRunner?: SlopGateRunner,
): Promise<CommitAttempt> {
  const timeoutMs = getCommitTimeoutMs();
  const headBefore = await readGitHead(pi, cwd);
  let commitOutput = "";
  let commitExitCode = 1;
  let timedOut = false;
  /** Remediation-note lines for cross-task contamination unstaged at commit (T6). */
  let remediation: string[] = [];
  /** Slop-gate advisory notes from an annotate verdict, carried to the findings ledger (T5). */
  let slopNotes: string[] = [];
  try {
    const baselineRef = baselineHead ?? "HEAD";
    const declared: readonly DeclaredFile[] = contract
      ? deriveAllowlist(contract)
      : task.files;
    let nameStatusRes: string;
    if (contract) {
      // T3 A3: allowlist gates the WORKTREE teeth vs the baseline — a never-staged
      // edit outside the allowlist halts (bug 1 filtered in readTeethNameStatus).
      const teeth = await readTeethNameStatus(pi, cwd, baselineRef);
      const allowlist = classifyBaselineDiff({
        nameStatus: teeth, files: declared, baselineRef, taskId: behavior.id,
      });
      if (allowlist.violations.length > 0) return guardHalt(allowlist);
      // T3 A1: stage only owned paths (sources then tests) via `git add -- <paths>`;
      // `git add --all` never runs in v2. The changed set comes from
      // `git status --short --untracked-files=all` so files inside a brand-new
      // directory match their declared paths (plain --short collapses the dir).
      const changed = new Set(await readChangedPaths(pi, cwd));
      const ownedPaths = declared
        .filter((e) => e.refs?.includes(behavior.id))
        .map((e) => e.path)
        .filter((path) => changed.has(path));
      if (ownedPaths.length > 0) await pi.exec("git", ["add", "--", ...ownedPaths], { cwd });
      // Staged set vs the baseline: feeds the A5 narrow and the test guard.
      nameStatusRes = await readGuardNameStatus(pi, cwd, baselineRef);
      // T3 A5: empty staged set + dirty teeth ⇒ no-changes without invoking git
      // commit; a fully clean tree falls through to classifyCommit's verdict.
      if (nameStatusRes.trim() === "" && teeth.trim() !== "") {
        return { outcome: { kind: "no-changes", investigation:
          `No changes detected for ${behavior.id}: the unit's owned staged set is empty — git commit was never invoked. ` +
          "Land actual file changes in the unit's owned paths; git status shows only foreign or undeclared work." } };
      }
      // T6/T2: auto-unstage cross-task contamination BEFORE gating — only a path in
      // `git diff --cached --name-status HEAD` is genuinely staged, so a file committed
      // since the baseline is never contamination. Paths declared but owned by OTHER
      // tasks leave the index via `git restore --staged -- <path>` (work stays on disk);
      // undeclared or ownerless staged paths halt and are never unstaged.
      const headNameStatus = await runHeadStagedNameStatus(pi, cwd);
      const plan = planUnstage(declared, headNameStatus, behavior.id);
      if (plan.undeclared.length > 0) {
        return { outcome: ownerlessHalt(plan.undeclared, headNameStatus, declared, "HEAD") };
      }
      const unstaged = await unstageContamination(pi, cwd, plan.contamination);
      if (!unstaged.ok) return { outcome: unstaged.halt }; // never commit with contamination staged
      remediation = unstaged.remediation;
      if (remediation.length > 0) {
        // Re-read so every later gate sees only the owned subset.
        nameStatusRes = await readGuardNameStatus(pi, cwd, baselineRef);
      }
    } else {
      // v1 sessions keep the legacy stage-all path with the plain files list.
      await pi.exec("git", ["add", "--all"], { cwd });
      nameStatusRes = await readGuardNameStatus(pi, cwd, baselineRef);
      const allowlist = classifyBaselineDiff({ nameStatus: nameStatusRes, files: declared, baselineRef });
      if (allowlist.violations.length > 0) return guardHalt(allowlist);
    }
    // Staged-diff tamper guard: inspect before committing (never invokes it).
    const unifiedRes = await pi.exec("git", ["diff", "--cached"], { cwd });
    const testKindSourceFiles = task.behaviors
      .filter((b) => b.kind === "test" && b.sourceFile)
      .map((b) => b.sourceFile!);
    const staged = classifyStagedDiff({
      nameStatus: nameStatusRes,
      declaredFiles: task.files.map((f) => f.path),
      testKindSourceFiles,
      attempt,
      unifiedDiff: unifiedRes.stdout ?? "",
    });
    if (staged.kind === "test-guard") {
      return {
        outcome: { kind: "test-guard", investigation: withRemediation(staged.investigation, remediation),
          violations: staged.violations },
        ...(remediation.length > 0 ? { remediation } : {}),
      };
    }
    // T5: the slop gate runs after the staged-diff guard (a test-guard verdict never
    // reaches it) and before git commit: a block never invokes git commit; notes
    // ride back as slopNotes when the commit lands.
    if (slopRunner) {
      const verdict = await slopRunner.run(pi);
      if (verdict.kind === "block") {
        return {
          outcome: {
            kind: "slop-guard",
            investigation: withRemediation(verdict.investigation, remediation),
            violations: verdict.violations,
          },
          ...(remediation.length > 0 ? { remediation } : {}),
        };
      }
      slopNotes = verdict.notes;
    }
    const res = await pi.exec("git", ["commit", "-m", subject], { cwd, timeout: timeoutMs });
    commitExitCode = res.code;
    commitOutput = [res.stdout ?? "", res.stderr ?? ""].filter(Boolean).join("\n");
  } catch (err) {
    if (err instanceof NameStatusReadError) {
      // Fail closed (T3): the staged set could never be read — halt, never commit.
      const investigation =
        `## Contract-guard: staged name-status read failed\n\n${err.message}\n\n` +
        "The staged set could not be read — failing closed: git commit was never invoked.";
      return { outcome: { kind: "contract-guard", violations: [err.message],
        investigation: withRemediation(investigation, remediation) },
        ...(remediation.length > 0 ? { remediation } : {}) };
    }
    const message = String((err as Error)?.message ?? err);
    commitOutput = message;
    timedOut = /timed out/i.test(message);
    commitExitCode = 1;
  }
  const headAfter = await readGitHead(pi, cwd);
  const carried = {
    ...(remediation.length > 0 ? { remediation } : {}),
    ...(slopNotes.length > 0 ? { slopNotes } : {}),
  };
  if (!timedOut && headBefore !== null && headAfter !== null && headAfter !== headBefore) {
    return { outcome: null, subject, ...carried };
  }
  // HEAD did not move: gather tree evidence for the investigation only now.
  const statusAfter = timedOut ? "" : await readTreeState(pi, cwd);
  const diffStat = timedOut ? "" : await readDiffStat(pi, cwd);
  const outcome = classifyCommit(behavior, {
    headBefore,
    headAfter,
    commitExitCode,
    commitOutput,
    timedOut,
    statusAfter,
    diffStat,
    timeoutMs,
  });
  if (outcome.kind === "landed") return { outcome: null, subject, ...carried };
  return { outcome: { ...outcome, investigation: withRemediation(outcome.investigation, remediation) }, ...carried };
}
