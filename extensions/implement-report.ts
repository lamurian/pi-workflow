import { renderTaskContract } from "./task-contract.ts";
import { renderHaltReport } from "./halt-report.ts";
import type { OrchestratorResult } from "./implement-loop.ts";
import type { TaskContract, WorkflowState } from "./state.ts";

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
 * list; the section is omitted when empty or absent.
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
  return renderHaltReport({
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
    lines.push("", `## ${task.title}`, "", renderTaskContract(task));
  }
  lines.push("", "## Test Results");
  lines.push(`- Passed: ${results?.passed ?? 0}`);
  lines.push(`- Failed: ${results?.failed ?? 0}`);
  if (results?.coveragePercent !== undefined) {
    lines.push(`- Coverage: ${results.coveragePercent}%`);
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
