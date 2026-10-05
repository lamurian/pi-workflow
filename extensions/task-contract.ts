import type { WorkflowState, TaskContract, Behavior } from "./state.ts";

/** Normalized, validated task contract produced by validateTask. */
export type TaskValidation =
  | { ok: true; task: TaskContract; warnings: string[] }
  | { ok: false; reason: string };

/** Test-artifact phrasing: expectedOutput talks about test files/cases only. */
const TEST_ARTIFACT_PATTERN = /test (file|files|cases?|scenarios?)\b/i;

/** Observable-behavior markers that make a test-kind expectedOutput valid. */
const OBSERVABLE_MARKER_PATTERN = /\b(returns?|raises?|emits?|rejects?|persists?|validates?)\b/i;

/**
 * Deterministically collect contract-quality warnings for one behavior.
 *
 * Two advisory rules, both test-kind only:
 * 1. Test-artifact-only expectedOutput (mentions test files/cases/scenarios
 *    with no observable-behavior marker) — such a commit is red by
 *    construction: a test without its implementation.
 * 2. Test-deletion expectedOutput — deletion is not test-verified behavior;
 *    the behavior should be kind: "manual".
 *
 * @param b - Behavior to inspect (already shape-validated).
 * @returns Zero or two warning strings (never both rules for one behavior:
 *          deletion is checked first and wins).
 */
function collectBehaviorWarnings(b: Behavior): string[] {
  if (b.kind !== "test") return [];
  if (/\b(deletes?|removes?)\b/i.test(b.expectedOutput) && /\btests?\b/i.test(b.expectedOutput)) {
    return [
      `${b.id}: expectedOutput describes test deletion — test deletion is not ` +
        `test-verified behavior; set kind: manual for removal behaviors.`,
    ];
  }
  if (
    TEST_ARTIFACT_PATTERN.test(b.expectedOutput) &&
    !OBSERVABLE_MARKER_PATTERN.test(b.expectedOutput)
  ) {
    return [
      `${b.id}: expectedOutput describes test artifacts only — the commit ` +
        `would be red by construction (test without implementation). ` +
        `Merge the test and its implementation into one behavior.`,
    ];
  }
  return [];
}

/**
 * Deterministically validate a raw save_task payload.
 *
 * Checks every field of the contract. On success returns a normalized
 * TaskContract with each behavior defaulted to status "active" when the
 * caller omitted it, plus advisory contract-quality warnings (never
 * blocking). On failure returns the first offending field.
 *
 * @param raw - Unvalidated payload (from the save_task tool call).
 * @returns A normalized task with warnings, or a rejection reason.
 */
export function validateTask(raw: unknown): TaskValidation {
  if (raw === null || typeof raw !== "object") {
    return { ok: false, reason: "payload must be an object" };
  }
  const t = raw as Record<string, unknown>;
  if (typeof t.title !== "string" || t.title.trim() === "") {
    return { ok: false, reason: "title is required" };
  }
  if (typeof t.instruction !== "string" || t.instruction.trim() === "") {
    return { ok: false, reason: "instruction is required" };
  }
  if (typeof t.done !== "string" || t.done.trim() === "") {
    return { ok: false, reason: "done is required" };
  }
  if (!Array.isArray(t.files) || t.files.some((f) => typeof f !== "string")) {
    return { ok: false, reason: "files must be an array of strings" };
  }
  if (!Array.isArray(t.behaviors)) {
    return { ok: false, reason: "behaviors must be an array" };
  }
  const behaviors: Behavior[] = [];
  for (let i = 0; i < t.behaviors.length; i++) {
    const b = t.behaviors[i] as Record<string, unknown>;
    if (b === null || typeof b !== "object") {
      return { ok: false, reason: `behaviors[${i}] must be an object` };
    }
    if (typeof b.id !== "string" || b.id.trim() === "") {
      return { ok: false, reason: `behaviors[${i}].id is required` };
    }
    if (typeof b.description !== "string" || b.description.trim() === "") {
      return { ok: false, reason: `behaviors[${i}].description is required` };
    }
    if (typeof b.expectedOutput !== "string" || b.expectedOutput.trim() === "") {
      return { ok: false, reason: `behaviors[${i}].expectedOutput is required` };
    }
    if (b.kind !== "test" && b.kind !== "manual") {
      return { ok: false, reason: `behaviors[${i}].kind must be test or manual` };
    }
    const status =
      b.status === "removed" || b.status === "done"
        ? b.status
        : "active";
    behaviors.push({
      id: b.id,
      description: b.description,
      expectedOutput: b.expectedOutput,
      kind: b.kind,
      status,
      ...(typeof b.sourceFile === "string" ? { sourceFile: b.sourceFile } : {}),
    });
  }
  return {
    ok: true,
    task: {
      title: t.title,
      instruction: t.instruction,
      files: t.files as string[],
      done: t.done,
      behaviors,
    },
    warnings: behaviors.flatMap(collectBehaviorWarnings),
  };
}

/** Parsed results from a test run. */
export interface ParsedTest {
  passed: number;
  failed: number;
  coveragePercent?: number;
}

/**
 * Parse a test-run result from exit code and stdout.
 *
 * The exit code is the primary signal: a non-zero exit means failed. The
 * passed/failed counts and coverage are best-effort regex extractions used
 * only for display, never for gating.
 *
 * @param exitCode - Process exit code from the test command.
 * @param stdout   - Combined test output.
 * @returns Parsed pass/fail counts.
 */
export function parseTestOutput(exitCode: number, stdout: string): ParsedTest {
  // Match both the classic TAP/Vitest forms (`# pass 2`, `2 passing`) and
  // the Node.js core test-runner summary lines (`ℹ pass 2`, `ℹ fail 0`).
  const failedMatch =
    stdout.match(/(\d+)\s+(?:failed|failing)\b/i) ??
    stdout.match(/\bfail\s+(\d+)/i);
  const passedMatch =
    stdout.match(/(\d+)\s+(?:passed|passing)\b/i) ??
    stdout.match(/\bpass\s+(\d+)/i);

  // Best-effort coverage: istanbul "All files" row (take last column),
  // else a "Lines: N%" / "Statements: N%" style percentage.
  let coveragePercent: number | undefined;
  const allFilesLine = stdout.match(/All files[^\n]*/i);
  if (allFilesLine) {
    const nums = allFilesLine[0].match(/\d+(?:\.\d+)?/g);
    if (nums && nums.length > 0) {
      coveragePercent = parseFloat(nums[nums.length - 1]);
    }
  } else {
    const pct = stdout.match(/(?:Lines|Statements)[^\d]*?(\d+(?:\.\d+)?)\s*%/i);
    if (pct) coveragePercent = parseFloat(pct[1]);
  }

  const failed = failedMatch ? parseInt(failedMatch[1], 10) : 0;
  const passed = passedMatch ? parseInt(passedMatch[1], 10) : 0;
  return {
    passed,
    // A non-zero exit with no parseable "failed" count still counts as a failure.
    failed: exitCode !== 0 && failed === 0 ? 1 : failed,
    ...(coveragePercent !== undefined ? { coveragePercent } : {}),
  };
}

/**
 * Deterministically evaluate the complete_implementation gate.
 *
 * Refuses completion while any active behavior remains, or when no task
 * contract is present. Test outcomes are not consulted: verification is
 * owned by the project (per-behavior commits pass the project's own
 * pre-commit hooks; some projects have no hooks at all).
 *
 * @param state - Current workflow state.
 * @returns null when the gate passes, otherwise a refusal reason.
 */
export function evaluateCompletionGate(state: WorkflowState): string | null {
  const task = state.task;
  if (!task) {
    return "no task contract in state";
  }
  const active = task.behaviors.filter((b) => b.status === "active");
  if (active.length > 0) {
    return `${active.length} behavior(s) still active`;
  }
  return null;
}

/**
 * Render a task contract as markdown for prompts, widgets, and compaction.
 *
 * @param task - The task contract to render.
 * @returns Markdown string listing title, files, done, and behaviors.
 */
export function renderTaskContract(task: TaskContract): string {
  const lines: string[] = [];
  lines.push(`### ${task.title}`);
  lines.push(`Files: ${task.files.join(", ")}`);
  lines.push(`Instruction: ${task.instruction}`);
  lines.push(`Done: ${task.done}`);
  lines.push("Behaviors:");
  for (const b of task.behaviors) {
    const flag = b.status === "removed" ? " [removed]" : "";
    lines.push(
      `- [${b.kind}] ${b.id}: ${b.description} → ${b.expectedOutput}${flag}`,
    );
  }
  return lines.join("\n");
}
