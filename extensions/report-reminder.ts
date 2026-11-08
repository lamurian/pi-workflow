/** Reminder steer sent once when a unit ends its run without the JSON report. */
export const REPORT_REMINDER_MESSAGE =
  "your run ended without the mandatory JSON report block: emit only the " +
  "fenced json report (summary, suggestedCommit, status) now, nothing else";

/**
 * Decide what to do when an agent_end arrives without a parseable report.
 *
 * @param event - The stdout event.
 * @param state - Whether a report was seen and whether a reminder was already sent.
 * @returns "none" to ignore, "remind" to send the reminder, "settle" to stop waiting.
 */
export function reportReminderAction(
  event: Record<string, unknown>,
  state: { reportSeen: boolean; reminderSent: boolean },
): "none" | "remind" | "settle" {
  if (event.type !== "agent_end" || event.willRetry !== false || state.reportSeen) return "none";
  return state.reminderSent ? "settle" : "remind";
}
