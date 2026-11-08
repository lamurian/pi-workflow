// The sole orchestrator-authored chore commit: the regenerated test extension.
// Path-limited (`git commit --only -- <path>`): other staged work — e.g. left
// over by a halted unit attempt — never blocks it and is never swept in.

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { TEST_EXTENSION_PATH } from "./contract-guard-core.ts";
import { commitScopedPath } from "./scoped-commit.ts";

/** Subject of the sole orchestrator-authored chore commit: the regenerated test extension. */
export const TEST_EXTENSION_CHORE_SUBJECT = "chore: regenerate test extension";

/** Outcome of the test-extension chore commit (T9). */
export interface ChoreCommitResult {
  /** "landed" = committed alone; "skipped" = unchanged vs HEAD; "failed" otherwise. */
  kind: "landed" | "skipped" | "failed";
  /** Investigation text for the failure halt (empty when landed/skipped). */
  investigation: string;
}

/**
 * Commit the regenerated test extension as the SOLE chore commit (T9).
 *
 * @param pi        - ExtensionAPI reference (for exec access).
 * @param cwd       - Repository working directory.
 * @param chorePath - Repo-relative path of the generated test extension.
 * @returns The chore-commit outcome with the failure investigation.
 */
export async function commitTestExtensionChore(
  pi: ExtensionAPI,
  cwd: string,
  chorePath: string = TEST_EXTENSION_PATH,
): Promise<ChoreCommitResult> {
  return commitScopedPath(pi, cwd, chorePath, TEST_EXTENSION_CHORE_SUBJECT);
}
