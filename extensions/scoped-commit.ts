// Shared single-path commit mechanics: stage one path, skip when unchanged
// relative to HEAD, `git commit --only -m <subject> -- <path>`, verify HEAD moved.

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { getCommitTimeoutMs, readGitHead } from "./git-ops.ts";

/** Outcome of a scoped single-path commit. */
export interface ScopedCommitResult {
  kind: "landed" | "skipped" | "failed";
  /** Failure text including hook output (empty when landed/skipped). */
  investigation: string;
}

async function pathChanged(pi: ExtensionAPI, cwd: string, path: string): Promise<boolean | string> {
  const res = await pi.exec("git", ["diff", "--cached", "--name-only", "HEAD", "--", path], { cwd });
  if (res.code !== 0) {
    return (
      `git diff --cached --name-only HEAD -- ${path} failed (exit ${res.code}):\n` +
      (res.stderr || res.stdout || "(no output)")
    );
  }
  return (res.stdout ?? "").split("\n").some((line) => line.trim() === path);
}

/**
 * Commit exactly one path with the given subject, leaving other staged work staged.
 *
 * @param pi      - ExtensionAPI reference (exec access).
 * @param cwd     - Repository working directory.
 * @param path    - Repo-relative path to commit.
 * @param subject - Commit subject.
 * @returns landed / skipped (unchanged vs HEAD) / failed with investigation.
 */
export async function commitScopedPath(
  pi: ExtensionAPI,
  cwd: string,
  path: string,
  subject: string,
): Promise<ScopedCommitResult> {
  try {
    const headBefore = await readGitHead(pi, cwd);
    const add = await pi.exec("git", ["add", "--", path], { cwd });
    if (add.code !== 0) {
      return {
        kind: "failed",
        investigation: `git add -- ${path} failed (exit ${add.code}):\n` + (add.stderr || add.stdout || "(no output)"),
      };
    }
    const changed = await pathChanged(pi, cwd, path);
    if (typeof changed === "string") return { kind: "failed", investigation: changed };
    if (!changed) return { kind: "skipped", investigation: "" };
    const res = await pi.exec("git", ["commit", "--only", "-m", subject, "--", path], {
      cwd,
      timeout: getCommitTimeoutMs(),
    });
    const headAfter = await readGitHead(pi, cwd);
    if (headBefore !== null && headAfter !== null && headAfter !== headBefore) {
      return { kind: "landed", investigation: "" };
    }
    const output = [res.stdout ?? "", res.stderr ?? ""].filter(Boolean).join("\n");
    return {
      kind: "failed",
      investigation:
        `the commit did not land (exit ${res.code}) — the project's pre-commit ` +
        `hooks own verification and rejected it:\n${output || "(no output)"}`,
    };
  } catch (err) {
    return { kind: "failed", investigation: String((err as Error)?.message ?? err) };
  }
}
