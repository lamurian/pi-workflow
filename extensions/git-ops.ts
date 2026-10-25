import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { resolve, sep } from "node:path";
import { computeTreeFingerprint } from "./unit-progress.ts";
import { classifyCommit, type GateOutcome } from "./commit-gate.ts";
import { classifyStagedDiff } from "./staged-diff-guard.ts";
import {
  classifyBaselineDiff,
  formatDeclaredList,
  planUnstage,
  TEST_EXTENSION_PATH,
  type DeclaredFile,
} from "./contract-guard-core.ts";
import { deriveAllowlist } from "./contract-derive.ts";
import type { ImplementerReport } from "./implementer-report.ts";
import type { Behavior, ContractV2, TaskContract } from "./state.ts";

// ─── Git helpers ───────────────────────────────────────────────────────────────

/**
 * Decide whether a behavior's sourceFile resolves outside the repo working tree.
 *
 * Behaviors whose sourceFile lives outside cwd (e.g. `../other-repo/x.go`) can
 * never produce an in-repo diff: the commit gate would reject them as
 * no-changes forever. Such behaviors are inferred never-commit — the loop
 * marks them done from the unit report without any git add/commit.
 *
 * @param behavior - The behavior (its sourceFile is resolved against cwd).
 * @param cwd      - The repository working directory.
 * @returns True when sourceFile resolves to a path outside cwd; false when
 *          the behavior has no sourceFile (keeps the commit path).
 */
export function isOutOfRepoBehavior(behavior: Behavior, cwd: string): boolean {
  if (!behavior.sourceFile) return false;
  const root = resolve(cwd);
  const target = resolve(root, behavior.sourceFile);
  if (target === root) return false;
  return !target.startsWith(root + sep);
}

/**
 * Read the current git HEAD hash for a working directory.
 *
 * Best-effort: returns null when git fails so callers can skip HEAD checks.
 *
 * @param pi  - ExtensionAPI reference (for exec access).
 * @param cwd - Working directory to resolve HEAD in.
 * @returns The HEAD hash, or null when unavailable.
 */
export async function readGitHead(
  pi: ExtensionAPI,
  cwd: string,
): Promise<string | null> {
  try {
    const result = await pi.exec("git", ["rev-parse", "HEAD"], { cwd });
    if (result.code !== 0) return null;
    const head = (result.stdout ?? "").trim();
    return head || null;
  } catch {
    return null;
  }
}

/**
 * Read a short git tree-state summary for handoffs and resume context.
 *
 * @param pi  - ExtensionAPI reference.
 * @param cwd - Working directory.
 * @returns `git status --short` output, "" when clean, "(unavailable)" on error.
 */
export async function readTreeState(
  pi: ExtensionAPI,
  cwd: string,
): Promise<string> {
  try {
    const res = await pi.exec("git", ["status", "--short"], { cwd });
    return (res.stdout ?? "").trim();
  } catch {
    return "(unavailable)";
  }
}

/**
 * Read the working-tree fingerprint used for partial-attempt progress
 * detection (T6): `git status --short` + `git diff --stat`, joined by
 * computeTreeFingerprint. Best-effort: failed commands contribute empty
 * strings, keeping the fingerprint stable across attempts.
 *
 * @param pi  - ExtensionAPI reference (for exec access).
 * @param cwd - Working directory.
 * @returns The joined tree fingerprint.
 */
export async function readTreeFingerprint(pi: ExtensionAPI, cwd: string): Promise<string> {
  const status = await readTreeState(pi, cwd);
  let diffStat = "";
  try {
    const res = await pi.exec("git", ["diff", "--stat"], { cwd });
    diffStat = (res.stdout ?? "").trim();
  } catch {
    diffStat = "";
  }
  return computeTreeFingerprint(status, diffStat);
}

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
 * Append the cross-task remediation note to a guard investigation.
 *
 * @param investigation - The base investigation text.
 * @param remediation   - Remediation-note lines (empty leaves the text as-is).
 * @returns The investigation with the remediation block appended.
 */
function withRemediation(investigation: string, remediation: string[]): string {
  if (remediation.length === 0) return investigation;
  return (
    investigation +
    "\n\nCross-task contamination auto-unstaged before gating (work stays on disk):\n" +
    remediation.map((line) => `  - ${line}`).join("\n")
  );
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
  const remediation: string[] = [];
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
    let nameStatusRes = await runBaselineNameStatus(pi, cwd, baselineRef);
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
        const violations = plan.undeclared.map(
          (path) =>
            `staged path with no owning task: ${path} — declared, but no task refs own it`,
        );
        const investigation = [
          `## Contract-guard: staged diff vs ${baselineRef}`,
          "",
          "Name-status:",
          ...nameStatusRes.split("\n").filter(Boolean).map((line) => `  ${line}`),
          "",
          `Declared files: ${formatDeclaredList(declared)}`,
          "",
          "Violations:",
          ...violations.map((v) => `  - ${v}`),
          "",
          "The contract's files list is authoritative — a contract change needs " +
            "/discuss -> /finalize.",
        ].join("\n");
        return { outcome: { kind: "contract-guard", violations, investigation } };
      }
      for (const contaminated of plan.contamination) {
        const res = await pi.exec(
          "git",
          ["restore", "--staged", "--", contaminated.path],
          { cwd },
        );
        if (res.code !== 0) {
          // Never proceed to the commit with contamination still staged.
          return {
            outcome: {
              kind: "contract-guard",
              violations: [
                `failed to unstage cross-task contamination: ${contaminated.path} ` +
                  `(owned by task ${contaminated.ownerTasks.join(", ")})`,
              ],
              investigation:
                `git restore --staged -- ${contaminated.path} failed (exit ${res.code}):\n` +
                (res.stderr || res.stdout || "(no output)"),
            },
          };
        }
        remediation.push(
          `unstaged ${contaminated.path} (owned by task ${contaminated.ownerTasks.join(", ")}) — ` +
            `git restore --staged -- ${contaminated.path}; the work stays on disk for its owning task`,
        );
      }
      if (remediation.length > 0) {
        // Re-read the staged diff so every later gate sees only the owned subset.
        nameStatusRes = await runBaselineNameStatus(pi, cwd, baselineRef);
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

// ─── Test-extension chore commit (T9) ────────────────────────────────────────

/** Subject of the sole orchestrator-authored chore commit: the regenerated test extension. */
export const TEST_EXTENSION_CHORE_SUBJECT = "chore: regenerate test extension";

/** Outcome of the test-extension chore commit (T9). */
export interface ChoreCommitResult {
  /**
   * "landed" = committed alone; "skipped" = the generated file is unchanged
   * (nothing staged for it); "aborted" = another staged path broke the
   * sole-path invariant (nothing committed); "failed" = the commit ran but
   * HEAD did not move, or a git step failed.
   */
  kind: "landed" | "skipped" | "aborted" | "failed";
  /** Staged paths other than the chore path (present only when aborted). */
  otherPaths: string[];
  /** Investigation text for the abort/failure halt (empty when landed/skipped). */
  investigation: string;
}

/**
 * Parse `git diff --cached --name-status` lines into repo-relative paths.
 *
 * Renames/copies split into their old (D) and new (A) paths so both are
 * checked against the sole-path invariant.
 *
 * @param nameStatus - Raw name-status output.
 * @returns The parsed paths (malformed lines are skipped).
 */
function parseStagedPaths(nameStatus: string): string[] {
  const paths: string[] = [];
  for (const line of nameStatus.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const fields = trimmed.split("\t");
    const status = fields[0]?.[0] ?? "";
    if (status === "R" || status === "C") {
      if (fields[1]) paths.push(fields[1]);
      if (fields[2]) paths.push(fields[2]);
    } else if (fields[1]) {
      paths.push(fields[1]);
    }
  }
  return paths;
}

/**
 * Commit the regenerated test extension as the SOLE chore commit (T9).
 *
 * Stages ONLY `chorePath` (never `git add --all`), then inspects the full
 * staged set (`git diff --cached --name-status`, index vs HEAD): any staged
 * path other than the chore path aborts the commit — nothing is committed
 * and the foreign paths are returned for the caller to halt with. When the
 * chore path itself is not in the staged set the generated file is unchanged
 * and the commit is skipped. Otherwise the commit runs with the fixed subject
 * and lands when HEAD moves; a commit that leaves HEAD unmoved is reported
 * as failed with its exit code and output tail.
 *
 * @param pi        - ExtensionAPI reference (for exec access).
 * @param cwd       - Repository working directory.
 * @param chorePath - Repo-relative path of the generated test extension
 *                    (defaults to TEST_EXTENSION_PATH).
 * @returns The chore-commit outcome with the abort/failure investigation.
 */
export async function commitTestExtensionChore(
  pi: ExtensionAPI,
  cwd: string,
  chorePath: string = TEST_EXTENSION_PATH,
): Promise<ChoreCommitResult> {
  const headBefore = await readGitHead(pi, cwd);
  try {
    // Stage ONLY the chore path: the chore commit must never absorb other work.
    const add = await pi.exec("git", ["add", "--", chorePath], { cwd });
    if (add.code !== 0) {
      return {
        kind: "failed",
        otherPaths: [],
        investigation:
          `git add -- ${chorePath} failed (exit ${add.code}):\n` +
          (add.stderr || add.stdout || "(no output)"),
      };
    }
    // The staged set exactly as `git commit` would land it (index vs HEAD).
    const staged = await pi.exec("git", ["diff", "--cached", "--name-status"], { cwd });
    const stagedPaths = parseStagedPaths(staged.code === 0 ? staged.stdout ?? "" : "");
    const otherPaths = stagedPaths.filter((path) => path !== chorePath);
    if (otherPaths.length > 0) {
      return {
        kind: "aborted",
        otherPaths,
        investigation: [
          `Sole-path chore commit aborted: ${otherPaths.length} other staged path(s) would be swept in:`,
          ...otherPaths.map((path) => `  - ${path}`),
          "",
          `The chore commit may contain only ${chorePath}. Commit or unstage the paths ` +
            "above (e.g. `git restore --staged -- <path>`), then re-run /implement.",
        ].join("\n"),
      };
    }
    if (!stagedPaths.includes(chorePath)) {
      return { kind: "skipped", otherPaths: [], investigation: "" }; // unchanged file
    }
    const res = await pi.exec("git", ["commit", "-m", TEST_EXTENSION_CHORE_SUBJECT], {
      cwd,
      timeout: getCommitTimeoutMs(),
    });
    const headAfter = await readGitHead(pi, cwd);
    if (headBefore !== null && headAfter !== null && headAfter !== headBefore) {
      return { kind: "landed", otherPaths: [], investigation: "" };
    }
    const output = [res.stdout ?? "", res.stderr ?? ""].filter(Boolean).join("\n");
    return {
      kind: "failed",
      otherPaths: [],
      investigation:
        `the chore commit did not land (exit ${res.code}) — the project's pre-commit ` +
        `hooks own verification and rejected it:\n${output || "(no output)"}`,
    };
  } catch (err) {
    return {
      kind: "failed",
      otherPaths: [],
      investigation: String((err as Error)?.message ?? err),
    };
  }
}

/**
 * Read `git diff --cached --name-status --no-renames <ref>` for the allowlist
 * and test-guard checks. Falls back to HEAD output on a failed diff so a bad
 * baseline never bricks the gate (hooks still gate the commit).
 *
 * @param pi  - ExtensionAPI reference.
 * @param cwd - Working directory.
 * @param ref - Baseline ref (baselineHead or "HEAD").
 * @returns Raw name-status output, or "" when git fails.
 */
async function runBaselineNameStatus(
  pi: ExtensionAPI,
  cwd: string,
  ref: string,
): Promise<string> {
  try {
    const res = await pi.exec(
      "git",
      ["diff", "--cached", "--name-status", "--no-renames", ref],
      { cwd },
    );
    if (res.code === 0) return res.stdout ?? "";
    if (ref !== "HEAD") {
      const fallback = await pi.exec(
        "git",
        ["diff", "--cached", "--name-status", "--no-renames", "HEAD"],
        { cwd },
      );
      if (fallback.code === 0) return fallback.stdout ?? "";
    }
    return "";
  } catch {
    return "";
  }
}

/**
 * Read `git diff --stat` for investigations.
 *
 * Best-effort: returns "" when the command fails.
 *
 * @param pi  - ExtensionAPI reference (for exec access).
 * @param cwd - Working directory.
 * @returns The diff-stat text, or "" on failure.
 */
export async function readDiffStat(pi: ExtensionAPI, cwd: string): Promise<string> {
  try {
    const res = await pi.exec("git", ["diff", "--stat"], { cwd });
    return (res.stdout ?? "").trim();
  } catch {
    return "";
  }
}

/**
 * Read the commit subjects landed since the /implement baseline (T8).
 *
 * Runs `git log <baselineHead>..HEAD --pretty=%s` so the halt report can
 * list cumulative commits across ALL runs of the task, not just the
 * current one. Best-effort: returns null when no baseline was recorded
 * (older sessions, git unavailable, or a failed log) so callers fall
 * back to the per-run landedCommits.
 *
 * @param pi          - ExtensionAPI reference.
 * @param cwd         - Working directory.
 * @param baselineHead - HEAD recorded when /implement started (optional).
 * @returns Commit subjects since the baseline, or null when unavailable.
 */
export async function readCommitsSinceBaseline(
  pi: ExtensionAPI,
  cwd: string,
  baselineHead: string | undefined,
): Promise<string[] | null> {
  if (!baselineHead) return null;
  try {
    const res = await pi.exec("git", ["log", `${baselineHead}..HEAD`, "--pretty=%s"], { cwd });
    if (res.code !== 0) return null;
    return (res.stdout ?? "")
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean);
  } catch {
    return null;
  }
}

// ─── Commit timeout budget ─────────────────────────────────────────────────────

/** Default git-commit budget: hooks run lint+format+test on cold caches. */
export const DEFAULT_COMMIT_TIMEOUT_MS = 300_000;

/**
 * Resolve the git-commit timeout budget, honoring PI_COMMIT_TIMEOUT_MS.
 *
 * @param env - Environment map (defaults to `process.env`); injectable for tests.
 * @returns The timeout in milliseconds (&gt; 0).
 */
export function getCommitTimeoutMs(
  env: Record<string, string | undefined> = process.env,
): number {
  const raw = env.PI_COMMIT_TIMEOUT_MS;
  if (raw) {
    const parsed = Number(raw);
    if (Number.isFinite(parsed) && parsed > 0) return parsed;
  }
  return DEFAULT_COMMIT_TIMEOUT_MS;
}
