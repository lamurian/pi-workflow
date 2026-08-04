import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

/** Valid phases of the modular workflow state machine. */
export type WorkflowPhase =
  | "idle"
  | "discussing"
  | "implementing";

/** Serializable workflow state persisted via pi.appendEntry(). */
export interface WorkflowState {
  /** Current workflow phase. */
  phase: WorkflowPhase;
  /** The agreed-upon specification text (from discussion or implement). */
  specText: string;
  /** Results from the latest test run, if any. */
  lastTestResults?: TestResults;
}

/** Test run results. */
export interface TestResults {
  passed: number;
  failed: number;
  coveragePercent?: number;
}

const STATE_CUSTOM_TYPE = "workflow-state";

/**
 * Persist the current workflow state to the session.
 * Called after every phase transition.
 *
 * @param pi    - ExtensionAPI reference for session access.
 * @param state - Current workflow state to persist.
 */
export function saveState(pi: ExtensionAPI, state: WorkflowState): void {
  pi.appendEntry(STATE_CUSTOM_TYPE, state);
}

/**
 * Restore the latest workflow state from session entries.
 *
 * Walks session entries in reverse to find the most recent
 * "workflow-state" custom entry.
 *
 * @param ctx - Extension context with session manager access.
 * @returns The restored state, or null if none exists.
 */
export function loadState(ctx: ExtensionContext): WorkflowState | null {
  const entries = ctx.sessionManager.getBranch();
  for (let i = entries.length - 1; i >= 0; i--) {
    const entry = entries[i];
    if (
      entry.type === "custom" &&
      (entry as { customType?: string }).customType === STATE_CUSTOM_TYPE
    ) {
      const data = (entry as { data?: WorkflowState }).data;
      if (data && data.phase) {
        return data;
      }
    }
  }
  return null;
}

/**
 * Transition to a new phase and persist the state.
 *
 * @param pi    - ExtensionAPI reference.
 * @param state - Mutable workflow state (updated in place).
 * @param phase - Target phase.
 */
export function transitionTo(
  pi: ExtensionAPI,
  state: WorkflowState,
  phase: WorkflowPhase,
): void {
  state.phase = phase;
  saveState(pi, state);
}

/**
 * Update the UI footer and widget to reflect the current workflow state.
 *
 * @param state - Current workflow state.
 * @param ctx   - Extension context for UI access.
 */
export function updateUi(state: WorkflowState | null, ctx: ExtensionContext): void {
  if (!state || state.phase === "idle") {
    ctx.ui.setStatus("workflow", undefined);
    ctx.ui.setWidget("workflow-todos", undefined);
    return;
  }

  const phaseLabel = state.phase.replace(/_/g, " ");
  ctx.ui.setStatus(
    "workflow",
    ctx.ui.theme.fg("accent", `◉ ${phaseLabel}`),
  );

  if (state.phase === "implementing") {
    const lines: string[] = [];
    if (state.lastTestResults) {
      const r = state.lastTestResults;
      const color = r.failed > 0 ? "error" : "success";
      lines.push(
        ctx.ui.theme.fg(color, `tests: ${r.passed}✓ ${r.failed}✗`),
      );
    }
    ctx.ui.setWidget("workflow-todos", lines);
  } else {
    ctx.ui.setWidget("workflow-todos", undefined);
  }
}
