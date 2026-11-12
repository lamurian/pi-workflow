/** Reasons a unit may report itself blocked. */
export type BlockedReason = "capability" | "too-large" | "missing-context";

/** Minimal attempt shape inspected for a blocked report. */
export interface BlockedAttemptLike {
  status?: string;
  blockedReason?: BlockedReason;
  summary?: string;
}

/**
 * Build the halt text for a blocked attempt. A blocked attempt halts the
 * behavior immediately: no retry, no continuation.
 *
 * @param behaviorId - The behavior the unit ran for.
 * @param attempt    - The attempt outcome.
 * @returns The halt text, or undefined when the attempt is not blocked.
 */
export function blockedHaltText(behaviorId: string, attempt: BlockedAttemptLike): string | undefined {
  if (attempt.status !== "blocked") return undefined;
  const reason = attempt.blockedReason ?? "unspecified";
  const remedy =
    reason === "missing-context"
      ? "Add the missing context (e.g. a paste-ready snippet) to the task description via /discuss -> /finalize, then /implement resumes."
      : "Resolve the blocker (or split the task via /discuss -> /finalize), then /implement resumes.";
  return `Unit ${behaviorId} reported blocked (blockedReason: ${reason}): ${attempt.summary || "no summary"}. ` +
    remedy;
}
