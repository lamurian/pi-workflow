// Fix-forward task text, halt/notify lines, gate reports and done evidence
// rendered from a recorded GateResult. Pure: no I/O.

import type { GateResult } from "./state.ts";
import { RETRY_BUDGET } from "./commit-gate.ts";

/**
 * Build the fix-forward task text for a red scope gate (T8).
 *
 * The commit landed, but the orchestrator-run gate stayed red: the task is
 * not done and a fix-forward attempt goes through the retry path with this
 * text — gate report (failing suite + output tail) plus the original task.
 *
 * @param result   - The red gate result.
 * @param attempt  - 1-based fix-forward attempt number.
 * @param original - The original unit task text for this behavior.
 * @returns Rendered fix-forward task text.
 */
export function buildScopeGateFixTask(
  result: GateResult,
  attempt: number,
  original: string,
): string {
  return (
    `## Previous attempt failed (retry ${attempt}/${RETRY_BUDGET})\n` +
    `${renderGateReport(result, "scope gate")}\n\n` +
    `The scope gate is run by the ORCHESTRATOR after your commit landed — it is ` +
    `not your own test-tool call and cannot be satisfied by reporting success: ` +
    `every filterable suite runs with this task's derived package scope plus ` +
    `every non-filterable suite, unfiltered. Fix forward: make the failing suite ` +
    `pass with real code changes. Do NOT delete, skip, or weaken a test to turn ` +
    `the gate green.\n\n` +
    `## Original task\n` + original
  );
}

/**
 * The halt text for a scope gate that stayed red past the retry budget (T8).
 *
 * @param result - The red gate result.
 * @returns The halt message: the task is not done, plus the gate report.
 */
export function redGateHaltText(result: GateResult): string {
  return (
    `Scope gate for ${result.behaviorId} stayed red after ${RETRY_BUDGET} fix-forward ` +
    `attempts — the task is not done.\n\n${renderGateReport(result, "scope gate")}`
  );
}

/**
 * The notification text for a red scope gate steering fix-forward (T8).
 *
 * @param result  - The red gate result.
 * @param attempt - The current fix-forward attempt number.
 * @returns One-line warning naming the failing suite count and retry position.
 */
export function redGateNotifyText(result: GateResult, attempt: number): string {
  return (
    `Scope gate red for ${result.behaviorId}: ` +
    `${result.suites.filter((s) => !s.passed).length} suite(s) failed — ` +
    `steering fix-forward (retry ${attempt}/${RETRY_BUDGET})`
  );
}

/**
 * Render one recorded gate result as report/investigation text (T8).
 *
 * Names the gate kind and verdict, the scope, every suite verdict, and the
 * full output tail of each failing suite — the text a red scope gate's
 * fix-forward attempt (or a refused completion) receives.
 *
 * @param result - The recorded gate result (a state.gateResults entry).
 * @param kind   - "scope gate" (per-task) or "full gate" (completion).
 * @returns Multi-line report text.
 */
export function renderGateReport(
  result: GateResult,
  kind: "scope gate" | "full gate",
): string {
  const failing = result.suites.filter((s) => !s.passed);
  const parts = [
    `## Orchestrator ${kind}: ${result.behaviorId} — ${result.passed ? "GREEN" : "RED"}`,
    "",
    `Scope: ${result.scope.length > 0 ? result.scope.join(", ") : "(all packages — unfiltered)"}`,
    `Suites: ${
      result.suites.length > 0
        ? result.suites.map((s) => `${s.label} ${s.passed ? "PASS" : "FAIL"}`).join("; ")
        : "(none)"
    }`,
    "",
  ];
  for (const f of failing) {
    parts.push(`### ${f.label} (FAIL) — output tail`, "", f.tail, "");
  }
  return parts.join("\n").replace(/\n+$/, "");
}

/**
 * The one-line gate evidence for mark_task_done (T8): scope + pass/fail.
 *
 * @param result - The recorded gate result (a state.gateResults entry).
 * @returns e.g. `orchestrator gate T1 — scope pkg/foo — passed (2/2 suites)`.
 */
export function formatGateEvidenceLine(result: GateResult): string {
  const passedCount = result.suites.filter((s) => s.passed).length;
  return (
    `orchestrator gate ${result.behaviorId} — scope ` +
    `${result.scope.length > 0 ? result.scope.join(", ") : "(all packages)"} — ` +
    `${result.passed ? "passed" : "failed"} (${passedCount}/${result.suites.length} suites)`
  );
}
