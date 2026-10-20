import { RETRY_BUDGET } from "./commit-gate.ts";
import { renderTaskContract } from "./task-contract.ts";
import type { Behavior, TaskContract } from "./state.ts";
import type { UnitAttempt } from "./implement-loop.ts";

// ─── Task text builders ────────────────────────────────────────────────────────

let _unitPrompt: string | undefined;

/**
 * Load (and cache) the implementer unit prompt from content/unit-prompt.md.
 *
 * @returns The unit prompt text.
 */
export function loadUnitPrompt(): string {
  if (_unitPrompt === undefined) {
    _unitPrompt = "";
  }
  return _unitPrompt;
}

/**
 * Set the cached unit prompt (called at /implement time).
 *
 * @param text - The prompt text from content/unit-prompt.md.
 */
export function setUnitPrompt(text: string): void {
  _unitPrompt = text;
}

/**
 * Build the `## Engineer's note` section appended to unit task texts.
 *
 * Mirrors the wording the solo /implement prompt uses: the note is guidance
 * on top of the authoritative contract, never a license to extend it.
 *
 * @param note - The engineer's note text (non-empty).
 * @returns The rendered markdown section, ready for string concatenation.
 */
export function buildEngineerNoteSection(note: string): string {
  return (
    `\n\n## Engineer's note\n\n${note}` +
    "\n\nGuidance on top of the authoritative contract. If it implies changes " +
    "beyond the contract, report that and tell the user to run /finalize — " +
    "do not implement beyond the contract."
  );
}

/**
 * Build the task text for one behavior unit.
 *
 * @param behavior - The behavior to implement.
 * @param task     - The full task contract (for context).
 * @returns Rendered task text for the subprocess.
 */
export function buildUnitTask(behavior: Behavior, task: TaskContract): string {
  return [
    `Implement ONE behavior: ${behavior.id}.`,
    `Description: ${behavior.description}`,
    `Expected output: ${behavior.expectedOutput}`,
    `Kind: ${behavior.kind}`,
    behavior.sourceFile ? `Source file: ${behavior.sourceFile}` : "",
    "",
    "## Contract context (do not implement beyond this behavior)",
    `Title: ${task.title}`,
    `Instruction: ${task.instruction}`,
    `Files: ${task.files.join(", ")}`,
    `Definition of done: ${task.done}`,
    "",
    "## Contract (for reference)",
    renderTaskContract(task),
    "",
    "End with the JSON report block (summary, suggestedCommit) as instructed.",
  ]
    .filter(Boolean)
    .join("\n");
}

/**
 * Build the retry task text for a unit-reported failure (pre-commit stage).
 *
 * Three branches keyed off structured flags on the prior attempt:
 * - `timedOut` → infrastructure timeout at the wall clock, not a check
 *   failure; the retry inspects the on-disk work first, fixes one blocker,
 *   and reports even if verification is incomplete (context = last
 *   assistant text from the runner, not raw JSONL).
 * - `missingReport` → the unit ended without the mandatory JSON report;
 *   it runs headless, so blocked commands go in blockedCommands, never as
 *   a prose request to a user that does not exist mid-run.
 * - default → unchanged failure + retry wording (byte-compatible).
 *
 * @param behavior - The behavior being retried.
 * @param task     - The full task contract.
 * @param prior    - The failed outcome from the previous attempt.
 * @param attempt  - 1-based retry attempt number.
 * @returns Rendered retry task text.
 */
export function buildRetryTask(
  behavior: Behavior,
  task: TaskContract,
  prior: UnitAttempt,
  attempt: number,
): string {
  const failure = prior.error ?? prior.summary ?? "unknown failure";
  if (prior.timedOut) {
    return (
      `## Previous attempt was killed at the time limit (retry ${attempt}/${RETRY_BUDGET})\n` +
      `The previous run hit the hard wall-clock timeout (PI_IMPLEMENT_TIMEOUT_MS, 900 s default) and was ` +
      `killed mid-investigation — this was an infrastructure timeout, not a check failure.\n\n` +
      `Your work from that run is likely already on disk. Do NOT redo it from scratch: inspect git status ` +
      `and git diff first, then fix exactly one blocking issue. ` +
      `Emit the JSON report even if verification is incomplete.\n\n` +
      `## Last assistant text before the kill\n` +
      failure +
      `\n\n## Original task\n` +
      buildUnitTask(behavior, task) +
      "\n\nFix the reported issues and re-verify."
    );
  }
  if (prior.missingReport) {
    return (
      `## Previous attempt ended without the required JSON report (retry ${attempt}/${RETRY_BUDGET})\n` +
      `You run headless in a sandbox — no user is available mid-run. A blocked command must be reported ` +
      `via blockedCommands in the JSON report, never as a prose request to the user.\n\n` +
      `## Previous final message\n` +
      failure +
      `\n\n## Original task\n` +
      buildUnitTask(behavior, task) +
      "\n\nFix the reported issues and re-verify."
    );
  }
  return (
    `## Previous attempt failed (retry ${attempt}/${RETRY_BUDGET})\n` +
    failure +
    `\n\n## Original task\n` +
    buildUnitTask(behavior, task) +
    "\n\nFix the reported issues and re-verify."
  );
}
