import { RETRY_BUDGET } from "./commit-gate.ts";
import { formatFiles, formatTask } from "./task-contract.ts";
import type { Behavior, ContractV2, PathEntry, TaskContract, TestToolInfo } from "./state.ts";
import { deriveUnitScope, type UnitScope } from "./contract-derive.ts";
import { buildContextPreload } from "./unit-context-preload.ts";
import type { UnitAttempt } from "./implement-loop.ts";

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

/** Options for {@link buildUnitTask}. */
export interface UnitTaskOptions {
  /**
   * The v2 contract (T5): when set, only this unit's slice is rendered —
   * task id, description, one expectedOutput line per assertion, the owned
   * sources/tests and the Verification line. The full contract is never
   * embedded.
   */
  contract?: ContractV2;
  /** When set, owned M/D file contents are preloaded into the task text (T7/T5). */
  preloadCwd?: string;
  /** Test-tool wiring from state.testTool; drives the Verification line (T3). */
  testTool?: TestToolInfo;
}

/**
 * Build the Verification line for one behavior.
 *
 * @param behavior - The behavior being implemented.
 * @param testTool - The persisted test-tool wiring, if any.
 * @returns "call the `test` tool (runs: <argv joins>)" when suites are known
 *          (config/existing-with-suites/detected), otherwise the fallback:
 *          the pre-commit hook for test-kind behaviors, inspection for manual.
 */
function verificationLine(
  behavior: Behavior,
  testTool: TestToolInfo | undefined,
): string {
  const suites = testTool?.suites ?? [];
  if (suites.length > 0) {
    const runs = suites.map((suite) => suite.argv.join(" ")).join("; ");
    return `call the \`test\` tool (runs: ${runs})`;
  }
  return behavior.kind === "test"
    ? "no test tool; verification is the pre-commit hook"
    : "no test tool; verify by inspection";
}

/**
 * Render one list of owned slice entries as "path (STATUS)" items.
 *
 * @param entries - The unit's owned slice entries (sources or tests).
 * @returns The comma-joined list; "(none)" when the unit owns none.
 */
function formatSliceEntries(entries: readonly PathEntry[]): string {
  if (entries.length === 0) return "(none)";
  return entries
    .map((e) => (e.status ? `${e.path} (${e.status})` : e.path))
    .join(", ");
}

/**
 * Build the Verification line for a slice-mode unit (T5).
 *
 * States that the `test` tool with no arguments defaults to this task's
 * derived scope (its packages) and that a filtered iteration run is not
 * verification. Without suites it falls back to the pre-commit hook
 * (test-kind) or inspection (manual).
 *
 * @param scope    - The unit's derived scope (supplies its packages).
 * @param behavior - The behavior being implemented (kind drives the fallback).
 * @param testTool - The persisted test-tool wiring, if any.
 * @returns The rendered Verification line.
 */
function sliceVerificationLine(
  scope: UnitScope,
  behavior: Behavior,
  testTool: TestToolInfo | undefined,
): string {
  const suites = testTool?.suites ?? [];
  if (suites.length > 0) {
    const runs = suites.map((suite) => suite.argv.join(" ")).join("; ");
    const packages = scope.packages.length > 0 ? scope.packages.join(", ") : "(none)";
    return (
      `call the \`test\` tool (runs: ${runs}) — with no arguments it defaults ` +
      `to this task's derived scope (packages: ${packages}); a filtered ` +
      `iteration run does not satisfy the done criteria and is not verification`
    );
  }
  return behavior.kind === "test"
    ? "no test tool; verification is the pre-commit hook — in-turn iteration is not verification"
    : "no test tool; verify by inspection";
}

/**
 * Build the slice-only task text for one v2 unit (T5).
 *
 * Renders ONLY the unit's slice: task id, description, one expectedOutput
 * line per assertion (verbatim from the v2 task unit), the owned
 * sources/tests, the owned M/D preloads and the Verification line. The full
 * contract is never embedded.
 *
 * @param behavior - The behavior to implement (its id keys the slice).
 * @param contract - The v2 contract the slice derives from.
 * @param options  - Optional preload/test-tool flags.
 * @returns Rendered slice task text for the subprocess.
 */
function buildSliceTask(
  behavior: Behavior,
  contract: ContractV2,
  options: UnitTaskOptions,
): string {
  const scope = deriveUnitScope(contract, behavior.id);
  const unit = contract.tasks.find((t) => t.id === behavior.id);
  const assertions = unit?.expectedOutput ?? [behavior.expectedOutput];
  return [
    `Implement ONE behavior: ${behavior.id}.`,
    `Description: ${unit?.description ?? behavior.description}`,
    "",
    "## Expected output (the test's contract — one line per assertion)",
    ...assertions.map((a) => `- ${a}`),
    "",
    "## Owned paths (this unit's slice of the contract)",
    `Sources: ${formatSliceEntries(scope.sources)}`,
    `Tests: ${formatSliceEntries(scope.tests)}`,
    options.preloadCwd
      ? buildContextPreload([...scope.sources, ...scope.tests], options.preloadCwd)
      : "",
    unit?.commands && unit.commands.length > 0
      ? `## Run tool\nCall the \`run\` tool with one of these pinned commands: ${unit.commands.join(", ")}\n`
      : "",
    "## Verification",
    sliceVerificationLine(scope, behavior, options.testTool),
    "End with the JSON report block (summary, suggestedCommit) as instructed.",
  ]
    .filter(Boolean)
    .join("\n");
}

/**
 * Build the task text for one behavior unit.
 *
 * With `options.contract` (T5) the text is the unit's slice only; without
 * it (v1 sessions) the full contract context is embedded as before.
 *
 * @param behavior - The behavior to implement.
 * @param task     - The full task contract (for context; v1 render only).
 * @param options  - Optional flags; `contract` selects the slice render.
 * @returns Rendered task text for the subprocess.
 */
export function buildUnitTask(
  behavior: Behavior,
  task: TaskContract,
  options: UnitTaskOptions = {},
): string {
  if (options.contract) return buildSliceTask(behavior, options.contract, options);
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
    `Files: ${formatFiles(task.files)}`,
    `Definition of done: ${task.done}`,
    "",
    "## Contract (for reference)",
    formatTask(task),
    options.preloadCwd ? buildContextPreload(task.files, options.preloadCwd) : "",
    "## Verification",
    verificationLine(behavior, options.testTool),
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
 * @param options  - Options forwarded to buildUnitTask (T5: `contract`
 *                   keeps the retry text slice-only in v2 sessions).
 * @returns Rendered retry task text.
 */
export function buildRetryTask(
  behavior: Behavior,
  task: TaskContract,
  prior: UnitAttempt,
  attempt: number,
  options: UnitTaskOptions = {},
): string {
  const failure = prior.error ?? prior.summary ?? "unknown failure";
  if (prior.timedOut) {
    return (
      `## Previous attempt was killed at the time limit (retry ${attempt}/${RETRY_BUDGET})\n` +
      `The previous run hit the hard wall-clock timeout (PI_IMPLEMENT_TIMEOUT_MS, 600 s default) and was ` +
      `killed mid-investigation — this was an infrastructure timeout, not a check failure.\n\n` +
      `Your work from that run is likely already on disk. Do NOT redo it from scratch: inspect git status ` +
      `and git diff first, then fix exactly one blocking issue. ` +
      `Emit the JSON report even if verification is incomplete.\n\n` +
      `## Last assistant text before the kill\n` +
      failure +
      `\n\n## Original task\n` +
      buildUnitTask(behavior, task, options) +
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
      buildUnitTask(behavior, task, options) +
      "\n\nFix the reported issues and re-verify."
    );
  }
  return (
    `## Previous attempt failed (retry ${attempt}/${RETRY_BUDGET})\n` +
    failure +
    `\n\n## Original task\n` +
    buildUnitTask(behavior, task, options) +
    "\n\nFix the reported issues and re-verify."
  );
}
