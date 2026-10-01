import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

/** Valid phases of the workflow state machine. */
export type WorkflowPhase =
  | "idle"
  | "discussing"
  | "finalized"
  | "implementing";

/** Lifecycle of one behavior in the task contract. */
export type BehaviorStatus = "active" | "removed" | "done";

/** Whether a behavior is verified by a test or by manual verification. */
export type BehaviorKind = "test" | "manual";

/** One testable behavior in the task contract. */
export interface Behavior {
  /** Stable behavior id, e.g. "T1". */
  id: string;
  /** The behavior under test. */
  description: string;
  /** The expected output when the behavior is implemented. */
  expectedOutput: string;
  /** test (TDD) or manual (definition-of-done verification). */
  kind: BehaviorKind;
  /** Lifecycle status. */
  status: BehaviorStatus;
  /** File that surfaces this behavior (used by back_to_finalize checks). */
  sourceFile?: string;
}

/** The atomic implementation contract produced by /finalize. */
export interface TaskContract {
  /** Short task title. */
  title: string;
  /** What to implement. */
  instruction: string;
  /** Files affected. */
  files: string[];
  /** Definition of done. */
  done: string;
  /** Behaviors covered by the task. */
  behaviors: Behavior[];
}

/** Serializable workflow state persisted via pi.appendEntry(). */
export interface WorkflowState {
  /** Current workflow phase. */
  phase: WorkflowPhase;
  /** The topic under discussion. */
  specText: string;
  /** The finalized task contract (present from finalized onward). */
  task?: TaskContract;
  /** Number of back_to_finalize returns this implementing round. */
  returnCount?: number;
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
 * Called after every phase transition and contract change.
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
 * @param pi    - ExtensionAPI reference for session access.
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
 * Uses only the string-array form of setWidget so it works in RPC mode.
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

  const lines: string[] = [];
  if (state.task) {
    lines.push(state.task.title);
    for (const b of state.task.behaviors) {
      const mark = b.status === "done" ? "✓" : b.status === "removed" ? "–" : "○";
      lines.push(
        `  ${mark} [${b.kind}] ${b.id}: ${b.description}`,
      );
    }
  }
  if (state.phase === "implementing" && state.lastTestResults) {
    const r = state.lastTestResults;
    const color = r.failed > 0 ? "error" : "success";
    lines.push(
      ctx.ui.theme.fg(color, `tests: ${r.passed}✓ ${r.failed}✗`),
    );
  }
  ctx.ui.setWidget("workflow-todos", lines.length ? lines : undefined);
}
