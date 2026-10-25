// ─── Read-only git helpers ────────────────────────────────────────────────────
// HEAD, tree-state, diff-stat and commit-log reads plus the commit timeout
// budget. Commit-invoking code lives in git-commit-gate.ts (behavior commits)
// and test-extension-chore.ts (the sole chore commit).

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { resolve, sep } from "node:path";
import { computeTreeFingerprint } from "./unit-progress.ts";
import type { Behavior } from "./state.ts";

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
