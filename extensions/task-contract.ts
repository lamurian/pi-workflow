import type { WorkflowState, TaskContract, Behavior } from "./state.ts";

/** Normalized, validated task contract produced by validateTask. */
export type TaskValidation =
  | { ok: true; task: TaskContract }
  | { ok: false; reason: string };

/**
 * Deterministically validate a raw save_task payload.
 *
 * Checks every field of the contract. On success returns a normalized
 * TaskContract with each behavior defaulted to status "active" when the
 * caller omitted it. On failure returns the first offending field.
 *
 * @param raw - Unvalidated payload (from the save_task tool call).
 * @returns A normalized task or a rejection reason.
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
  };
}

/** Outcome of the six-check back_to_finalize validation. */
export type BackValidation =
  | { ok: true; task: TaskContract; returnCount: number }
  | { ok: false; reason: string };

/**
 * Deterministically validate a back_to_finalize request.
 *
 * Enforces the six checks: phase guard, reason enum, shape, novelty against
 * the contract, sourceFile existence, and the returnCount cap. On success
 * returns the updated task plus the incremented return count.
 *
 * @param state      - Current workflow state (phase + task + returnCount).
 * @param params     - { reason, behaviors?, removals? } from the tool call.
 * @param fileExists - Injected existence check for sourceFile validation.
 * @returns The next task/returnCount, or a rejection reason.
 */
export function validateBackToFinalize(
  state: WorkflowState,
  params: Record<string, unknown>,
  fileExists: (path: string) => boolean,
): BackValidation {
  if (state.phase !== "implementing") {
    return { ok: false, reason: "back_to_finalize requires the implementing phase" };
  }
  const reason = params.reason;
  if (reason !== "new-testable-surface" && reason !== "out-of-scope") {
    return {
      ok: false,
      reason: "reason must be new-testable-surface or out-of-scope",
    };
  }
  const task = state.task;
  if (!task) {
    return { ok: false, reason: "no task contract in state" };
  }
  const returnCount = state.returnCount ?? 0;
  if (returnCount >= 2) {
    return {
      ok: false,
      reason:
        "return cap reached (2). Proceed with best judgment and record the decision in the final report.",
    };
  }
  const behaviors: Behavior[] = task.behaviors.map((b) => ({ ...b }));
  if (reason === "new-testable-surface") {
    const proposed = params.behaviors;
    if (!Array.isArray(proposed) || proposed.length === 0) {
      return { ok: false, reason: "behaviors must be a non-empty array" };
    }
    for (let i = 0; i < proposed.length; i++) {
      const b = proposed[i] as Record<string, unknown>;
      if (typeof b.description !== "string" || b.description.trim() === "") {
        return { ok: false, reason: `behaviors[${i}].description is required` };
      }
      if (typeof b.expectedOutput !== "string" || b.expectedOutput.trim() === "") {
        return { ok: false, reason: `behaviors[${i}].expectedOutput is required` };
      }
      if (typeof b.sourceFile !== "string" || b.sourceFile.trim() === "") {
        return { ok: false, reason: `behaviors[${i}].sourceFile is required` };
      }
      if (!fileExists(b.sourceFile)) {
        return { ok: false, reason: `sourceFile does not exist: ${b.sourceFile}` };
      }
      const dup = behaviors.some(
        (existing) =>
          existing.description.trim().toLowerCase() ===
          b.description!.trim().toLowerCase(),
      );
      if (dup) {
        return {
          ok: false,
          reason: `behavior already in contract: ${b.description}`,
        };
      }
    }
    let nextId = behaviors.length + 1;
    for (const b of proposed as Record<string, unknown>[]) {
      behaviors.push({
        id: `T${nextId++}`,
        description: b.description as string,
        expectedOutput: b.expectedOutput as string,
        kind: "test",
        status: "active",
        sourceFile: b.sourceFile as string,
      });
    }
  } else {
    const removals = params.removals;
    if (!Array.isArray(removals) || removals.length === 0) {
      return { ok: false, reason: "removals must be a non-empty array" };
    }
    for (const id of removals as string[]) {
      const target = behaviors.find((b) => b.id === id);
      if (!target) {
        return { ok: false, reason: `behavior not in contract: ${id}` };
      }
      target.status = "removed";
    }
  }
  return {
    ok: true,
    task: { ...task, behaviors },
    returnCount: returnCount + 1,
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
  const failedMatch = stdout.match(/(\d+)\s+(?:failed|failing)/i);
  const passedMatch = stdout.match(/(\d+)\s+(?:passed|passing)/i);

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
 * Refuses completion while any active behavior is pending, or when a test
 * behavior exists and the last recorded test run had failures.
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
  const hasTest = task.behaviors.some((b) => b.kind === "test" && b.status !== "removed");
  if (hasTest) {
    const r = state.lastTestResults;
    if (!r) {
      return "test behaviors present but no test run recorded";
    }
    if (r.failed > 0) {
      return `${r.failed} test(s) failing`;
    }
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
