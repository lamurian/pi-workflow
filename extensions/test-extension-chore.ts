// ─── Test-extension chore commit (T9) ────────────────────────────────────────
// The sole orchestrator-authored chore commit: the regenerated test extension.

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { TEST_EXTENSION_PATH } from "./contract-guard-core.ts";
import { getCommitTimeoutMs, readGitHead } from "./git-ops.ts";

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
export function parseStagedPaths(nameStatus: string): string[] {
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
