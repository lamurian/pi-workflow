/**
 * Resume halt context (T9, pure logic).
 *
 * Renders the "## Previous run halted" section injected into the first
 * unit of the behavior that halted, when /implement is re-run. No I/O:
 * the loop captures state.lastHalt before starting and prepends this
 * section to that behavior's base task text only.
 */

import type { LastHalt } from "./state.ts";
import { deriveDiagnosis, renderAttemptTable } from "./halt-report.ts";

/**
 * Render the previous-run halt context for the resumed behavior's first unit.
 *
 * Returns "" when the halt has neither attempts nor diagnosis (nothing
 * useful to inject). Otherwise renders a "## Previous run halted" section
 * carrying the failure detail, the diagnosis, the recommended next action
 * and the attempt table. Diagnosis and recommendation fall back to the
 * shared derivation when the persisted halt predates those fields.
 *
 * @param lastHalt - The persisted handoff from the halted run.
 * @returns The section markdown, or "" when there is nothing to inject.
 */
export function renderPreviousHaltSection(lastHalt: LastHalt): string {
  const attempts = lastHalt.attempts ?? [];
  if (attempts.length === 0 && !lastHalt.diagnosis) return "";
  const derived = deriveDiagnosis(attempts, lastHalt.error ?? "");
  const diagnosis = lastHalt.diagnosis ?? derived.diagnosis;
  const recommendation = lastHalt.recommendation ?? derived.recommendation;
  const lines: string[] = [
    "## Previous run halted",
    "",
    `The previous run halted on ${lastHalt.behaviorId}: ${lastHalt.error}`,
    "",
    `Diagnosis: ${diagnosis}`,
    "",
    `Recommended next action: ${recommendation}`,
  ];
  if (attempts.length) {
    lines.push("", "Attempt history:");
    lines.push(...renderAttemptTable(attempts));
  }
  lines.push(
    "",
    "Do not repeat the failed attempts above; continue from the current tree state.",
  );
  return lines.join("\n");
}
