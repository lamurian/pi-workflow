import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { classifyCommit, type GateOutcome } from "./commit-gate.ts";
import { classifyStagedDiff } from "./staged-diff-guard.ts";
import type { DeclaredFile } from "./contract-guard-core.ts";
import { classifyBaselineDiff, planUnstage } from "./contract-guard-diff.ts";
import { deriveAllowlist } from "./contract-derive.ts";
import {
  ownerlessHalt,
  readGuardNameStatus,
  unstageContamination,
  withRemediation,
} from "./git-guard-diff.ts";
import {
  getCommitTimeoutMs,
  readDiffStat,
  readGitHead,
  readTreeState,
} from "./git-ops.ts";
import type { ImplementerReport } from "./implementer-report.ts";
import type { Behavior, ContractV2, TaskContract } from "./state.ts";

// ─── Commit gate ───────────────────────────────────────────────────────────────

/** Outcome of a commit attempt, classified by the HEAD gate. */
export interface CommitAttempt {
  outcome: Exclude<GateOutcome, { kind: "landed" }> | null;
  /** Best-effort subject when the commit landed. */
  subject?: string;
  /**
   * Remediation note (T6): one line per auto-unstaged cross-task-contaminated
   * path, naming the path, its owning task(s) and the exact
   * `git restore --staged -- <path>` command — the work stays on disk for
   * its owning task. Absent when nothing was unstaged.
   */
  remediation?: string[];
}

/**
 * Pick the conventional commit subject for a unit.
 *
 * Prefers the subagent's suggestion; falls back to a generic subject so a
 * missing suggestion never blocks the commit step.
 *
 * @param report   - The unit's parsed report.
 * @param behavior - The behavior the unit implemented.
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

/**
 * Stage all changes and commit with the given subject; classify via HEAD gate.
 *
 * Never passes --no-verify: the project's pre-commit hooks are the gate.
 * Before committing, inspects the staged diff (git diff --cached) against
 * the tamper guard: undeclared test deletions, sourceFile deletions, and
 * retry-touching of undeclared tests block the commit without invoking it.
 *
 * @param pi       - ExtensionAPI reference.
 * @param cwd      - Working directory.
 * @param subject  - Conventional commit subject line.
 * @param behavior - The behavior being committed (for investigations).
 * @param task     - The task contract (declared files + test-kind sourceFiles).
 * @param attempt  - 1 = first commit attempt; >= 2 = fix retry (stricter guard).
 * @param baselineHead - HEAD recorded when /implement started; the staged diff
 *                       is measured against it (falls back to HEAD).
 * @param contract     - The v2 contract (T6): enables per-task ownership —
 *                       staged paths owned by other tasks are auto-unstaged
 *                       before gating and reported in `remediation`; absent
 *                       (v1 sessions) the plain files list gates unchanged.
 * @returns The classified commit attempt (with the remediation note when
 *          cross-task contamination was unstaged).
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
): Promise<CommitAttempt> {
  const timeoutMs = getCommitTimeoutMs();
  const headBefore = await readGitHead(pi, cwd);
  let commitOutput = "";
  let commitExitCode = 1;
  let timedOut = false;
  /** Remediation-note lines for cross-task contamination unstaged at commit (T6). */
  let remediation: string[] = [];
  try {
    await pi.exec("git", ["add", "--all"], { cwd });
    // Authoritative allowlist guard: name-status measured against the /implement
    // baseline (falling back to HEAD). On a violation the commit is never
    // invoked — the loop halts with a contract-guard outcome. v2 sessions gate
    // on the derived allowlist (refs enable per-task ownership; taskId makes a
    // staged D on another task's path a hard violation); v1 sessions keep the
    // plain files list without a task id.
    const baselineRef = baselineHead ?? "HEAD";
    const declared: readonly DeclaredFile[] = contract
      ? deriveAllowlist(contract)
      : task.files;
    // Chore-only changes to the orchestrator-owned test extension are filtered
    // out (bug 1): the start-of-run chore commit may postdate the baseline.
    let nameStatusRes = await readGuardNameStatus(pi, cwd, baselineRef);
    const allowlist = classifyBaselineDiff({
      nameStatus: nameStatusRes,
      files: declared,
      baselineRef,
      ...(contract ? { taskId: behavior.id } : {}),
    });
    if (allowlist.violations.length > 0) {
      return {
        outcome: {
          kind: "contract-guard",
          investigation: allowlist.investigation,
          violations: allowlist.violations,
        },
      };
    }
    // T6: auto-unstage cross-task contamination BEFORE gating. Staged paths
    // declared but owned by OTHER tasks leave the index via
    // `git restore --staged -- <path>` (the work stays on disk for the owning
    // task), the owned subset proceeds to the commit, and every unstage is
    // reported in the remediation note. Only truly undeclared/ownerless
    // staged paths halt the commit — they are never unstaged.
    if (contract) {
      const plan = planUnstage(declared, nameStatusRes, behavior.id);
      if (plan.undeclared.length > 0) {
        return { outcome: ownerlessHalt(plan.undeclared, nameStatusRes, declared, baselineRef) };
      }
      const unstaged = await unstageContamination(pi, cwd, plan.contamination);
      // Never proceed to the commit with contamination still staged.
      if (!unstaged.ok) return { outcome: unstaged.halt };
      remediation = unstaged.remediation;
      if (remediation.length > 0) {
        // Re-read the staged diff so every later gate sees only the owned subset.
        nameStatusRes = await readGuardNameStatus(pi, cwd, baselineRef);
      }
    }
    // Staged-diff tamper guard: inspect before committing. On a violation the
    // commit is never invoked — the loop halts with a test-guard outcome.
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
        outcome: {
          kind: "test-guard",
          investigation: withRemediation(staged.investigation, remediation),
          violations: staged.violations,
        },
        ...(remediation.length > 0 ? { remediation } : {}),
      };
    }
    const res = await pi.exec("git", ["commit", "-m", subject], { cwd, timeout: timeoutMs });
    commitExitCode = res.code;
    commitOutput = [res.stdout ?? "", res.stderr ?? ""].filter(Boolean).join("\n");
  } catch (err) {
    const message = String((err as Error)?.message ?? err);
    commitOutput = message;
    timedOut = /timed out/i.test(message);
    commitExitCode = 1;
  }
  const headAfter = await readGitHead(pi, cwd);
  const carried = remediation.length > 0 ? { remediation } : {};
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
  return {
    outcome: {
      ...outcome,
      investigation: withRemediation(outcome.investigation, remediation),
    },
    ...carried,
  };
}
