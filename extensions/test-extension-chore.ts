// ─── Test-extension chore commit (T9) ────────────────────────────────────────
// The sole orchestrator-authored chore commit: the regenerated test extension.
// Path-limited (`git commit --only -- <path>`): other staged work — e.g. left
// over by a halted unit attempt — never blocks it and is never swept in.

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { TEST_EXTENSION_PATH } from "./contract-guard-core.ts";
import { getCommitTimeoutMs, readGitHead } from "./git-ops.ts";

/** Subject of the sole orchestrator-authored chore commit: the regenerated test extension. */
export const TEST_EXTENSION_CHORE_SUBJECT = "chore: regenerate test extension";

/** Outcome of the test-extension chore commit (T9). */
export interface ChoreCommitResult {
  /**
   * "landed" = committed alone; "skipped" = the generated file is unchanged
   * relative to HEAD; "failed" = the commit ran but HEAD did not move, or a
   * git step failed.
   */
  kind: "landed" | "skipped" | "failed";
  /** Investigation text for the failure halt (empty when landed/skipped). */
  investigation: string;
}

/**
 * Whether the chore path is staged with changes relative to HEAD.
 *
 * Runs `git diff --cached --name-only HEAD -- <path>`: the path counts as
 * changed only when the output lists it exactly. Other staged paths are
 * never consulted.
 *
 * @param pi        - ExtensionAPI reference.
 * @param cwd       - Repository working directory.
 * @param chorePath - Repo-relative chore path.
 * @returns True when changed, false when unchanged, or the failure text.
 */
async function choreChanged(
  pi: ExtensionAPI,
  cwd: string,
  chorePath: string,
): Promise<boolean | string> {
  const res = await pi.exec(
    "git",
    ["diff", "--cached", "--name-only", "HEAD", "--", chorePath],
    { cwd },
  );
  if (res.code !== 0) {
    return (
      `git diff --cached --name-only HEAD -- ${chorePath} failed (exit ${res.code}):\n` +
      (res.stderr || res.stdout || "(no output)")
    );
  }
  return (res.stdout ?? "")
    .split("\n")
    .some((line) => line.trim() === chorePath);
}

/**
 * Commit the regenerated test extension as the SOLE chore commit (T9).
 *
 * Stages ONLY `chorePath` (never `git add --all`; staging also makes a
 * first-time untracked file known to git), then checks whether that path is
 * staged with changes relative to HEAD: unchanged -> skipped, whatever else
 * is staged. Otherwise runs
 * `git commit --only -m <subject> -- <chorePath>`, which commits just that
 * path and leaves every other staged path staged. The commit lands when HEAD
 * moves; a commit that leaves HEAD unmoved is reported as failed with its
 * exit code and output tail.
 *
 * @param pi        - ExtensionAPI reference (for exec access).
 * @param cwd       - Repository working directory.
 * @param chorePath - Repo-relative path of the generated test extension
 *                    (defaults to TEST_EXTENSION_PATH).
 * @returns The chore-commit outcome with the failure investigation.
 */
export async function commitTestExtensionChore(
  pi: ExtensionAPI,
  cwd: string,
  chorePath: string = TEST_EXTENSION_PATH,
): Promise<ChoreCommitResult> {
  const headBefore = await readGitHead(pi, cwd);
  try {
    const add = await pi.exec("git", ["add", "--", chorePath], { cwd });
    if (add.code !== 0) {
      return {
        kind: "failed",
        investigation:
          `git add -- ${chorePath} failed (exit ${add.code}):\n` +
          (add.stderr || add.stdout || "(no output)"),
      };
    }
    const changed = await choreChanged(pi, cwd, chorePath);
    if (typeof changed === "string") return { kind: "failed", investigation: changed };
    if (!changed) return { kind: "skipped", investigation: "" };
    const res = await pi.exec(
      "git",
      ["commit", "--only", "-m", TEST_EXTENSION_CHORE_SUBJECT, "--", chorePath],
      { cwd, timeout: getCommitTimeoutMs() },
    );
    const headAfter = await readGitHead(pi, cwd);
    if (headBefore !== null && headAfter !== null && headAfter !== headBefore) {
      return { kind: "landed", investigation: "" };
    }
    const output = [res.stdout ?? "", res.stderr ?? ""].filter(Boolean).join("\n");
    return {
      kind: "failed",
      investigation:
        `the chore commit did not land (exit ${res.code}) — the project's pre-commit ` +
        `hooks own verification and rejected it:\n${output || "(no output)"}`,
    };
  } catch (err) {
    return { kind: "failed", investigation: String((err as Error)?.message ?? err) };
  }
}
