import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { resolve, sep } from "node:path";
import { computeTreeFingerprint } from "./unit-progress.ts";
import { classifyCommit, type GateOutcome } from "./commit-gate.ts";
import { classifyStagedDiff } from "./staged-diff-guard.ts";
import { classifyBaselineDiff } from "./contract-guard-core.ts";
import type { ImplementerReport } from "./implementer-report.ts";
import type { Behavior, TaskContract } from "./state.ts";

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
 * @returns The classified commit attempt.
 */
export async function commitAndGate(
  pi: ExtensionAPI,
  cwd: string,
  subject: string,
  behavior: Behavior,
  task: TaskContract,
  attempt: number,
  baselineHead?: string,
): Promise<CommitAttempt> {
  const timeoutMs = getCommitTimeoutMs();
  const headBefore = await readGitHead(pi, cwd);
  let commitOutput = "";
  let commitExitCode = 1;
  let timedOut = false;
  try {
    await pi.exec("git", ["add", "--all"], { cwd });
    // Authoritative allowlist guard: name-status measured against the /implement
    // baseline (falling back to HEAD). On a violation the commit is never
    // invoked — the loop halts with a contract-guard outcome.
    const baselineRef = baselineHead ?? "HEAD";
    const nameStatusRes = await runBaselineNameStatus(pi, cwd, baselineRef);
    const allowlist = classifyBaselineDiff({
      nameStatus: nameStatusRes,
      files: task.files,
      baselineRef,
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
          investigation: staged.investigation,
          violations: staged.violations,
        },
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
  if (!timedOut && headBefore !== null && headAfter !== null && headAfter !== headBefore) {
    return { outcome: null, subject };
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
  if (outcome.kind === "landed") return { outcome: null, subject };
  return { outcome };
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
