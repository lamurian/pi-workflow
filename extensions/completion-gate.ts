// ─── Completion gate (T1) ────────────────────────────────────────────────────
// Test-run result parsing (display only) and the deterministic
// complete_implementation gate. Split out of task-contract.ts.

import type { WorkflowState } from "./state.ts";

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
