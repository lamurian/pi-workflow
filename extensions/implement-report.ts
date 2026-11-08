import { formatTask } from "./task-contract.ts";
import { renderHaltReport, HALT_REPORT_CLOSING_LINE } from "./halt-report.ts";
import type { OrchestratorResult } from "./implement-loop.ts";
import type { TaskContract, WorkflowState } from "./state.ts";
import type { ContractV2 } from "./contract-types.ts";

/** Total attempt time above which a task counts as slow (7 minutes). */
export const SLOW_TASK_THRESHOLD_SEC = 420;

/** Calibration facts for one slow task. */
export interface SlowTask {
  taskId: string;
  durationSec: number;
  assertions: number;
  paths: number;
  ownedBytes: number;
}

/**
 * Select tasks whose accumulated attempt durations exceed the threshold.
 *
 * @param durations - Total attempt seconds per task id.
 * @param contract  - v2 contract (assertions and owned paths); optional.
 * @param sizeOf    - Returns byte size of a repo-relative path (0 when missing).
 * @returns Slow tasks with duration, assertion count, path count, owned bytes.
 */
export function buildSlowTasks(
  durations: Record<string, number>,
  contract: ContractV2 | undefined,
  sizeOf: (path: string) => number,
): SlowTask[] {
  const out: SlowTask[] = [];
  for (const [taskId, durationSec] of Object.entries(durations)) {
    if (durationSec <= SLOW_TASK_THRESHOLD_SEC) continue;
    const task = contract?.tasks.find((t) => t.id === taskId);
    const owned = [...(contract?.sources ?? []), ...(contract?.tests ?? [])].filter((p) => p.tasks.includes(taskId));
    out.push({
      taskId,
      durationSec,
      assertions: task?.expectedOutput.length ?? 0,
      paths: owned.length,
      ownedBytes: owned.reduce((sum, p) => sum + sizeOf(p.path), 0),
    });
  }
  return out;
}

/**
 * Render the slow-task section lines (empty when none).
 *
 * @param slow - Slow tasks.
 * @returns Markdown lines, starting with a blank line.
 */
export function renderSlowTasks(slow: SlowTask[] | undefined): string[] {
  if (!slow?.length) return [];
  const lines = ["", `Slow tasks (attempts over ${SLOW_TASK_THRESHOLD_SEC / 60} minutes in total):`];
  for (const s of slow) {
    const m = Math.floor(s.durationSec / 60);
    const sec = s.durationSec % 60;
    lines.push(
      `- ${s.taskId}: ${m}m ${sec}s, ${s.assertions} assertions, ${s.paths} paths, ${s.ownedBytes} bytes owned`,
    );
  }
  return lines;
}

/**
 * Compose the pinned completion report for a settled orchestration.
 *
 * Delivered as an agent turn via `pi.sendUserMessage(report, { deliverAs:
 * "steer" })` after the orchestrator loop has set state.phase to idle and
 * persisted it (the explore pattern), so the outcome renders as an
 * assistant message in RPC clients even though the original /implement
 * prompt request is long done. A result with deferredCommands renders a
 * "Deferred commands" section (manual, run outside the sandbox) after the
 * behavior list. A result with a non-empty satisfiedWithoutCommit (T11a)
 * renders a "Satisfied without a new commit:" section after the behavior
 * list; the section is omitted when empty or absent. A result with a
 * non-empty leftUncommitted renders a "Left uncommitted — commit these
 * manually" section listing behavior id + sourceFile path; omitted when
 * empty or absent.
 *
 * @param result - The settled orchestrator outcome (complete).
 * @param task   - The task contract (provides the done behavior ids).
 * @returns The markdown report string with the pinned shape.
 */
export function composeCompletionReport(
  result: OrchestratorResult,
  task: TaskContract,
): string {
  const lines: string[] = [
    "## Implementation status: complete",
    "",
    `Units run: ${result.unitsRun}`,
    "",
    "Commits landed:",
  ];
  for (const subject of result.landedCommits) {
    lines.push(`- ${subject}`);
  }
  lines.push("", "Behaviors:");
  for (const behavior of task.behaviors.filter((b) => b.status === "done")) {
    lines.push(`- ${behavior.id} done`);
  }
  if (result.satisfiedWithoutCommit?.length) {
    lines.push("", "Satisfied without a new commit:");
    for (const id of result.satisfiedWithoutCommit) {
      lines.push(`- ${id}`);
    }
  }
  if (result.leftUncommitted?.length) {
    lines.push("", "Left uncommitted — commit these manually:");
    for (const entry of result.leftUncommitted) {
      lines.push(`- ${entry.behaviorId}: ${entry.sourceFile}`);
    }
  }
  if (result.pendingManualChecks?.length) {
    lines.push(
      "",
      "Manual verification required (verification timed out — confirm these in the app after the run):",
    );
    for (const check of result.pendingManualChecks) {
      lines.push(`- ${check.behaviorId}: ${check.description}`);
    }
  }
  if (result.deferredCommands?.length) {
    lines.push(
      "",
      "Deferred commands (manual — run outside the sandbox if you want their effects; " +
        "they do not block landing):",
    );
    for (const entry of result.deferredCommands) {
      lines.push(`- ${entry.command}${entry.reason ? ` (${entry.reason})` : ""}`);
    }
  }
  lines.push(...renderSlowTasks(result.slowTasks));
  lines.push(
    "",
    "No action needed: relay this status to the user. Do not run tools or modify the working tree.",
  );
  return lines.join("\n");
}

/**
 * Compose the pinned halt report for a settled orchestration.
 *
 * Delivered as an agent turn via `pi.sendUserMessage(report, { deliverAs:
 * "steer" })` after the orchestrator loop has persisted lastHalt and kept
 * state.phase implementing (the explore pattern), so the halt outcome
 * renders as an assistant message in RPC clients. Thin wrapper over
 * renderHaltReport (extensions/halt-report.ts, T8): renders the cumulative
 * commits since the /implement baseline (falling back to this run's
 * landedCommits), the halted behavior's attempt table, the findings tail,
 * and the Diagnosis / Recommended next action lines, ending with the
 * pinned relay instruction. A result with pendingCommand renders an
 * "Action required" section (run the command outside the sandbox, then
 * resume) before the resume line. Any OrchestratorResult with haltedOn
 * qualifies: unit failure after retries, test-guard, commit-timeout,
 * mustRunNow pause-halt, completion-gate refusal, or a caught crash.
 *
 * @param result - The settled orchestrator outcome (halted).
 * @returns The markdown report string with the pinned shape.
 */
export function composeHaltReport(result: OrchestratorResult): string {
  const slow = renderSlowTasks(result.slowTasks);
  const body = renderHaltReport({
    haltedOn: result.haltedOn,
    error: result.error,
    treeState: result.treeState,
    commits: result.commitsSinceBaseline?.length
      ? result.commitsSinceBaseline
      : result.landedCommits,
    attempts: result.attempts,
    findings: result.findings,
    diagnosis: result.diagnosis,
    recommendation: result.recommendation,
    pendingCommand: result.pendingCommand,
  });
  if (!slow.length) return body;
  const at = body.lastIndexOf(HALT_REPORT_CLOSING_LINE);
  if (at < 0) return body + "\n" + slow.join("\n");
  return body.slice(0, at) + slow.slice(1).join("\n") + "\n\n" + body.slice(at);
}

/**
 * Build a completion report from the workflow state.
 *
 * Test behaviors appear under Test Results. Completed manual behaviors are
 * listed under "Manual verification required" so the engineer can confirm
 * them after the fact; the section is omitted when none completed.
 *
 * @param state - Current workflow state.
 * @returns A markdown report string.
 */
export function generateReport(state: WorkflowState): string {
  const task = state.task;
  const results = state.lastTestResults;
  const lines: string[] = [];
  lines.push("# Implementation Report");
  if (task) {
    lines.push("", `## ${task.title}`, "", formatTask(task));
  }
  lines.push("", "## Test Results");
  lines.push(`- Passed: ${results?.passed ?? 0}`);
  lines.push(`- Failed: ${results?.failed ?? 0}`);
  if (results?.coveragePercent !== undefined) {
    lines.push(`- Coverage: ${results.coveragePercent}%`);
  }

  const gateNotes: string[] = [];
  for (const gate of Object.values(state.gateResults ?? {})) {
    gateNotes.push(...(gate.notes ?? []));
  }
  gateNotes.push(...(state.finalGate?.notes ?? []));
  if (gateNotes.length > 0) {
    lines.push("", "## Gate notes");
    for (const note of gateNotes) {
      lines.push(`- ${note}`);
    }
  }

  const completedManual = (task?.behaviors ?? []).filter(
    (b) => b.kind === "manual" && b.status === "done",
  );
  if (completedManual.length > 0) {
    lines.push("", "## Manual verification required");
    for (const b of completedManual) {
      lines.push(`- ${b.id}: ${b.description}`);
    }
  }

  return lines.join("\n");
}
