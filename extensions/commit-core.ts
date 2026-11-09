// Shared commit core: every git commit is built (and run) here with --signoff,
// so no commit can land without the Signed-off-by trailer.

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { getCommitTimeoutMs } from "./git-ops.ts";

/** Maximum conventional-subject length (changelog/tooling convention). */
const SUBJECT_MAX = 75;

/**
 * Format a commit subject: keep only the first non-empty line, trim it, and
 * cap it at 75 characters. Blank leading lines (e.g. from a parsed report)
 * never become the subject; multi-line input is collapsed to one line.
 *
 * @param raw - Raw subject text, possibly multi-line or blank-padded.
 * @returns The normalized single-line subject ("" when no non-empty line exists).
 */
export function formatCommitSubject(raw: string): string {
  const first = raw.split("\n").find((line) => line.trim() !== "");
  return (first ?? "").trim().slice(0, SUBJECT_MAX);
}

/**
 * Build the git commit argv: `commit -m <subject>` (plus `-m <body>` when a
 * body is given) followed by `--signoff`, appending `--only -- <paths>` when
 * paths are given. The subject is normalized through formatCommitSubject; the
 * body is passed verbatim (it may be multi-line).
 *
 * @param subject - Commit subject (normalized: first non-empty line, 75 cap).
 * @param body    - Optional commit body, passed verbatim.
 * @param paths   - Optional paths; when non-empty the commit is path-limited
 *                  via `--only -- <paths>` so other staged work stays staged.
 * @returns The argv for `git`.
 */
export function buildCommitArgs(
  subject: string,
  body?: string,
  paths?: readonly string[],
): string[] {
  const args = ["commit", "-m", formatCommitSubject(subject)];
  if (body !== undefined && body.length > 0) args.push("-m", body);
  args.push("--signoff");
  if (paths !== undefined && paths.length > 0) args.push("--only", "--", ...paths);
  return args;
}

/**
 * Run a git commit built by buildCommitArgs (always signed off), under the
 * project's commit timeout budget.
 *
 * @param pi      - ExtensionAPI reference (exec access).
 * @param cwd     - Repository working directory.
 * @param subject - Commit subject (normalized by buildCommitArgs).
 * @param body    - Optional commit body, passed verbatim.
 * @param paths   - Optional path limit (`--only -- <paths>`).
 * @returns The raw exec result (stdout/stderr/code).
 */
export async function runCommit(
  pi: ExtensionAPI,
  cwd: string,
  subject: string,
  body?: string,
  paths?: readonly string[],
): Promise<Awaited<ReturnType<ExtensionAPI["exec"]>>> {
  return pi.exec("git", buildCommitArgs(subject, body, paths), {
    cwd,
    timeout: getCommitTimeoutMs(),
  });
}
