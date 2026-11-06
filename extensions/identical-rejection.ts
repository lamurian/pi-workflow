// Identical repeated hook rejections (T4): pure normalization of hook output
// and the same-output/unchanged-tree decision that halts the loop instead of
// burning another fix round on an unchanged failure. No I/O — the loop reads
// the hook output and tree fingerprint and passes them in.

/** One hook-rejected round's identity: raw hook output plus the tree fingerprint. */
export interface RejectionSnapshot {
  /** Raw hook output of the rejected commit (tail, as captured by the commit gate). */
  hookOutput: string;
  /** Tree fingerprint (`git status --short` + `git diff --stat`) at the rejection. */
  treeFingerprint: string;
}

/** ANSI CSI/OSC/two-character escape sequences embedded in colored hook output. */
const ANSI_ESCAPE =
  /\u001b(?:\[[0-9;:?]*[ -/]*[@-~]|\][^\u0007\u001b]*(?:\u0007|\u001b\\)|[@-Z\\-_])/g;

/** Parenthesized timing fragments: '(done in 5.12 seconds)' / '(0.14 seconds)'. */
const PAREN_TIMING = /\(\s*(?:done in\s*)?\d+(?:\.\d+)?\s*seconds?\s*\)/gi;

/** Bare timing fragments: 'done in 5.12 seconds' / '0.14 seconds'. */
const BARE_TIMING = /\b(?:done in\s*)?\d+(?:\.\d+)?\s*seconds?\b/gi;

/**
 * Normalize hook output for identity comparison.
 *
 * Strips ANSI escape sequences and timing fragments (durations differ between
 * runs without the failure changing), normalizes line endings, and trims
 * trailing whitespace so two runs differing only in colors or durations
 * compare equal.
 *
 * @param output - Raw hook output of one rejected commit.
 * @returns The normalized output.
 */
export function normalizeHookOutput(output: string): string {
  return output
    .replace(/\r\n/g, "\n")
    .replace(ANSI_ESCAPE, "")
    .replace(PAREN_TIMING, "")
    .replace(BARE_TIMING, "")
    .split("\n")
    .map((line) => line.trimEnd())
    .join("\n")
    .trim();
}

/**
 * Decide whether two consecutive hook-rejected rounds are identical.
 *
 * Identical means equal normalized hook output AND an unchanged tree
 * fingerprint: the fix round changed nothing, so another fix round would
 * repeat the same failed commit.
 *
 * @param previous - The previously recorded hook-rejected round, if any.
 * @param current  - The hook-rejected round now at the gate.
 * @returns True when the two rounds are the same rejection; false otherwise
 *          (including when there is no previous rejection to compare).
 */
export function isIdenticalRejection(
  previous: RejectionSnapshot | undefined,
  current: RejectionSnapshot,
): boolean {
  if (!previous) return false;
  return (
    normalizeHookOutput(previous.hookOutput) === normalizeHookOutput(current.hookOutput) &&
    previous.treeFingerprint === current.treeFingerprint
  );
}

/**
 * Build the halt error for an identical repeated hook rejection.
 *
 * @param behaviorId - The behavior whose rejection repeated.
 * @returns The halt text naming the repeated identical rejection and
 *          recommending a local hook run and an ownership fix.
 */
export function buildIdenticalRejectionHalt(behaviorId: string): string {
  return (
    `Pre-commit hook rejected the commit for ${behaviorId} again with a repeated identical hook rejection: ` +
    `the same hook output (after normalization) and an unchanged tree fingerprint, so another fix round would ` +
    `repeat the same failed commit. Run the hook locally (git commit, or run_precommit_check) to see the live ` +
    `failure and fix the lint/test error it reports; if the output names paths owned by another task, fix the ` +
    `cross-task ownership of those files (or re-declare them via /discuss -> /finalize). Then /implement resumes.`
  );
}
