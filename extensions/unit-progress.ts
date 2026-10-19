/**
 * Partial-attempt continuation and progress classification (T6, pure logic).
 *
 * Attempts that report `status: "partial"` or end in a wall-clock timeout
 * never reach the commit gate: their work stays UNCOMMITTED for a
 * continuation unit. Progress is classified from the working-tree
 * fingerprint (git status --short + git diff --stat) changed since before
 * the attempt, or new findings appended to the shared ledger. With
 * progress the loop spawns a continuation unit without consuming the retry
 * budget, bounded by {@link MAX_CONTINUATIONS} per behavior; without
 * progress the attempt consumes one retry as before. {@link shouldHaltEarly}
 * additionally halts the behavior after {@link EARLY_HALT_THRESHOLD}
 * consecutive no-progress timed-out/partial attempts (T7). Plain unit
 * errors and missing-report attempts never enter this path. The module
 * also hosts {@link isAlreadySatisfied} (T11a): the predicate that lets
 * the loop mark a behavior done without a commit when the unit reports it
 * is already implemented at an unchanged HEAD and a clean tree.
 */

/** Maximum continuation units per behavior before retries take over. */
export const MAX_CONTINUATIONS = 4;

/** Consecutive no-progress timed-out/partial attempts that halt early (T7). */
export const EARLY_HALT_THRESHOLD = 2;

/** Diagnosis named verbatim in the early-halt error text. */
export const EARLY_HALT_DIAGNOSIS = "exploration not converging";

/** Heading rendered at the top of every continuation task text. */
export const CONTINUATION_HEADING = "## Continue previous partial attempt";

/** Minimal attempt shape the partial classification needs. */
export interface PartialAttemptLike {
  /** Parsed report status field ("partial" marks unfinished work). */
  status?: string;
  /** True when the unit subprocess was killed by the wall-clock timeout. */
  timedOut?: boolean;
}

/**
 * Whether an attempt qualifies for the partial-continuation path.
 *
 * True only for reports with `status: "partial"` or attempts killed by the
 * wall-clock timeout. Plain unit errors and missing-report attempts are
 * false — they keep the existing retry path.
 *
 * @param attempt - The attempt outcome (report plus failure flags).
 * @returns True for partial or timed-out attempts.
 */
export function isPartialAttempt(attempt: PartialAttemptLike): boolean {
  if (attempt.timedOut) return true;
  return attempt.status === "partial";
}

/**
 * Compute the working-tree fingerprint used for progress detection.
 *
 * Joins the trailing-whitespace-trimmed outputs of `git status --short` and
 * `git diff --stat` with a `--` separator so both dirty-state and dirty-diff
 * changes move the fingerprint. Leading whitespace is preserved: in
 * `git status --short` it distinguishes staged from unstaged changes.
 *
 * @param statusShort - `git status --short` output ("" when clean).
 * @param diffStat    - `git diff --stat` output.
 * @returns The joined fingerprint string.
 */
export function computeTreeFingerprint(statusShort: string, diffStat: string): string {
  return `${statusShort.trimEnd()}\n--\n${diffStat.trimEnd()}`;
}

/**
 * Classify whether a partial/timed-out attempt made progress.
 *
 * Progress means the tree fingerprint moved since before the attempt or
 * new findings were appended to the shared ledger during it.
 *
 * @param input - Fingerprints before/after the attempt and the new-findings flag.
 * @returns True when the attempt progressed.
 */
export function classifyProgress(input: {
  fingerprintBefore: string;
  fingerprintAfter: string;
  newFindings: boolean;
}): boolean {
  return input.fingerprintBefore !== input.fingerprintAfter || input.newFindings;
}

/**
 * Decide between a continuation unit and a plain retry.
 *
 * Continuations are allowed while the attempt progressed and fewer than
 * `maxContinuations` (default {@link MAX_CONTINUATIONS}) continuations ran
 * for this behavior; anything else falls back to the retry budget.
 *
 * @param input        - Progress flag, continuations used so far, optional cap override.
 * @returns "continue" for a continuation unit; "retry" to consume the retry budget.
 */
export function decideContinuation(input: {
  progressed: boolean;
  continuations: number;
  maxContinuations?: number;
}): "continue" | "retry" {
  const max = input.maxContinuations ?? MAX_CONTINUATIONS;
  return input.progressed && input.continuations < max ? "continue" : "retry";
}

/**
 * Whether consecutive no-progress attempts should halt the behavior early.
 *
 * Counts consecutive timed-out/partial attempts that neither moved the tree
 * fingerprint nor appended findings. At {@link EARLY_HALT_THRESHOLD} (2) the
 * loop halts immediately instead of burning the retry budget on attempts
 * that explore identically every time.
 *
 * @param consecutiveNoProgress - No-progress attempts so far, in a row.
 * @returns True when the behavior must halt now.
 */
export function shouldHaltEarly(consecutiveNoProgress: number): boolean {
  return consecutiveNoProgress >= EARLY_HALT_THRESHOLD;
}

/**
 * Build the early-halt error text for a non-converging behavior.
 *
 * Names the diagnosis ("exploration not converging") and both actionable
 * recommendations: split the behavior via /discuss -> /finalize, or raise
 * PI_IMPLEMENT_TIMEOUT_MS so the unit gets more time.
 *
 * @param behaviorId - The halted behavior.
 * @param attempts   - Consecutive no-progress attempts that triggered the halt.
 * @returns The halt error text.
 */
export function buildEarlyHaltError(behaviorId: string, attempts: number): string {
  return (
    `Unit ${behaviorId}: ${attempts} consecutive attempts reported partial work or hit the ` +
    `time limit without advancing the working tree or adding findings — ` +
    `diagnosis: ${EARLY_HALT_DIAGNOSIS}. ` +
    `Split this behavior into smaller behaviors via /discuss -> /finalize, or raise ` +
    `PI_IMPLEMENT_TIMEOUT_MS so the unit has more time to converge.`
  );
}

/** Minimal report shape the continuation task text renders. */
export interface ContinuationReport {
  /** Last assistant summary from the partial attempt (may be empty). */
  summary?: string;
  /** The partial unit's next-step guidance for its continuation. */
  nextSteps?: string;
  /** True when the attempt was killed by the wall-clock timeout. */
  timedOut?: boolean;
}

/**
 * Build the task text for a continuation unit.
 *
 * Carries the heading, the previous unit's nextSteps and last summary, a
 * `git status --short` snapshot, and the original task text. States that
 * the prior work stays UNCOMMITTED on disk and must be inspected first,
 * never redone from scratch. Retry numbering never appears: a continuation
 * does not consume the retry budget.
 *
 * @param behaviorId     - Behavior the continuation implements.
 * @param report         - The partial attempt's report (nextSteps, summary, timedOut).
 * @param originalTaskText - The behavior's original task text (base core).
 * @param gitStatus      - `git status --short` snapshot after the attempt.
 * @returns Rendered continuation task text.
 */
export function buildContinuationTaskText(
  behaviorId: string,
  report: ContinuationReport,
  originalTaskText: string,
  gitStatus: string,
): string {
  const headline = report.timedOut
    ? `The previous attempt on ${behaviorId} hit the wall-clock limit mid-work; its files stay UNCOMMITTED on disk.`
    : `The previous attempt on ${behaviorId} reported a partial result; its files stay UNCOMMITTED on disk.`;
  return [
    CONTINUATION_HEADING,
    "",
    headline,
    "Inspect the on-disk work (git status, git diff) first — do NOT redo the exploration from scratch.",
    "",
    "### Next steps from the previous unit",
    report.nextSteps?.trim() || "(none reported)",
    "",
    "### Last summary",
    report.summary?.trim() || "(no summary)",
    "",
    "### Working tree after the previous attempt",
    "```",
    gitStatus || "(clean)",
    "```",
    "",
    "### Original task",
    originalTaskText,
  ].join("\n");
}

/** Inputs for the already-satisfied check (T11a). */
export interface AlreadySatisfiedInput {
  /** True when the unit's report declares the behavior already implemented. */
  alreadySatisfied?: boolean;
  /** HEAD hash captured before the attempt (null when unavailable). */
  headBefore: string | null;
  /** HEAD hash after the attempt (null when unavailable). */
  headNow: string | null;
  /** `git status --short` output; "" means clean, "(unavailable)" means unknown. */
  treeStatus: string;
}

/**
 * Decide whether a behavior is already satisfied and needs no commit (T11a).
 *
 * True only when the unit set the alreadySatisfied flag, the working tree
 * is clean, and HEAD did not move during the attempt (both hashes known
 * and equal). A dirty tree, an unknown tree state, or a moved HEAD always
 * falls through to the normal commit gate — the flag alone never skips
 * landing real changes.
 *
 * @param input - The flag plus HEAD/tree observations around the attempt.
 * @returns True when the behavior can be marked done without committing.
 */
export function isAlreadySatisfied(input: AlreadySatisfiedInput): boolean {
  if (input.alreadySatisfied !== true) return false;
  if (input.treeStatus !== "") return false;
  return input.headBefore !== null && input.headNow !== null && input.headNow === input.headBefore;
}
