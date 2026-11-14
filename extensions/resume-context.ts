/**
 * Resume halt context (T9, pure logic).
 *
 * Renders the "## Previous run halted" section injected into the first
 * unit of the behavior that halted, when /implement is re-run. No I/O:
 * the loop captures state.lastHalt before starting and prepends this
 * section to that behavior's base task text only.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { LastHalt, WorkflowState } from "./state.ts";
import { readTreeState } from "./git-ops.ts";
import { renderAttemptTable } from "./halt-report.ts";
import { deriveDiagnosis } from "./halt-diagnosis.ts";

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

/** Resume-context values constructed once per run and consumed by the loop. */
export interface ResumePrelude {
  /** Dirty-tree fence injected into the first resumed unit ("" when clean). */
  resumeTreeContext: string;
  /** Assumed-run note for a persisted mustRunNow pendingCommand, when present. */
  pendingNote: { behaviorId: string; note: string } | undefined;
  /** Rendered previous-run halt section ("" when there is nothing to inject). */
  previousHaltSection: string;
}

/**
 * Build the resume-context prelude for a new orchestration run.
 *
 * Constructs (without mutating state): the dirty-tree fence by reading the
 * current tree state, the assumed-run note for a persisted mustRunNow
 * pendingCommand, and the rendered previous-run halt section. All
 * consumption and mutation of these values stays in the orchestrator loop.
 *
 * @param pi    - ExtensionAPI reference (tree read).
 * @param cwd   - Repository working directory.
 * @param state - Current workflow state (read only).
 * @returns The three resume-context values consumed by the loop.
 */
export async function buildResumePrelude(
  pi: ExtensionAPI,
  cwd: string,
  state: WorkflowState,
): Promise<ResumePrelude> {
  // Fence: a resumed session with uncommitted changes warns the first unit.
  let resumeTreeContext = "";
  if (state.phase === "implementing") {
    const tree = await readTreeState(pi, cwd);
    if (tree && tree !== "(unavailable)") {
      resumeTreeContext =
        `\n\n## Working tree is dirty (resumed session)\n` +
        `The previous run left uncommitted changes. Inspect them before implementing:\n\n` +
        "```\n" + tree + "\n```\n";
    }
  }

  // Resume after a mustRunNow pause-halt: note attaches to the halted behavior only.
  let pendingNote: { behaviorId: string; note: string } | undefined;
  if (state.lastHalt?.pendingCommand) {
    const pending = state.lastHalt.pendingCommand;
    pendingNote = {
      behaviorId: state.lastHalt.behaviorId,
      note:
        `\n\n## Previously blocked command — assumed run\n` +
        `The user was asked to run this command outside the sandbox:\n\n` +
        "```\n" + pending.command + "\n```\n\n" +
        (pending.reason ? `It was blocked: ${pending.reason}.\n\n` : "") +
        `Assume it has been executed. Do NOT attempt to run it yourself — your sandbox still blocks it. ` +
        `Verify its effects by other means (read files, run allowed checks). ` +
        `If its effects are missing, report that in your JSON report instead of retrying the command.`,
    };
  }

  // T9: resume halt context, prepended to the first unit of the halted behavior only.
  const previousHalt = state.lastHalt;
  const previousHaltSection = previousHalt ? renderPreviousHaltSection(previousHalt) : "";
  return { resumeTreeContext, pendingNote, previousHaltSection };
}
