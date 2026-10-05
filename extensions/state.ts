import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { shortSlug } from "./utils.ts";

/** Valid phases of the workflow state machine. */
export type WorkflowPhase =
  | "idle"
  | "discussing"
  | "finalizing"
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
  /** File that surfaces this behavior. */
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

/** Persisted handoff for a halted or crashed orchestration attempt. */
export interface LastHalt {
  /** The behavior that failed. */
  behaviorId: string;
  /** Failure detail (unit error, hook investigation, timeout note). */
  error: string;
  /** `git status --short` snapshot at halt time. */
  treeState?: string;
  /** Commit subjects landed before the halt. */
  landedCommits?: string[];
  /** ISO timestamp of the halt. */
  at: string;
}

/** Serializable workflow state persisted via pi.appendEntry(). */
export interface WorkflowState {
  /** Current workflow phase. */
  phase: WorkflowPhase;
  /** The topic under discussion. */
  specText: string;
  /** The task contract (present from finalizing onward). */
  task?: TaskContract;
  /** Results from the latest test run, if any. */
  lastTestResults?: TestResults;
  /**
   * Details of the most recent orchestration halt or crash. Persisted to the
   * session log so failures are diagnosable after the fact.
   */
  lastHalt?: LastHalt;
  /**
   * HEAD hash recorded when /implement started. Optional: absent on
   * sessions persisted before this field existed, and when git is
   * unavailable (not a repo).
   */
  baselineHead?: string;
  /**
   * HEAD hash after the most recent mark_task_done. Compared against the
   * current HEAD to soft-warn when no commit landed between behaviors.
   */
  lastMarkedHead?: string;
}

/** Test run results. */
export interface TestResults {
  passed: number;
  failed: number;
  coveragePercent?: number;
}

const STATE_CUSTOM_TYPE = "workflow-state";

/**
 * Whether the workflow widget is currently shown.
 *
 * In-memory UI state only: hidden by default, never persisted, resets on
 * session reload. Toggled by the /task command (extensions/index.ts).
 */
let widgetVisible = false;

/** Per-phase widget header line. */
const PHASE_HEADERS: Record<string, string> = {
  discussing: "◉ discussing — read-only planning",
  finalizing: "◉ finalizing — read-only contract review",
  implementing: "◉ implementing — write access enabled",
};

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
 * "workflow-state" custom entry. Migrates the legacy "finalized"
 * phase name to "finalizing" so sessions persisted before the
 * rename keep working.
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
        // Backward compat: sessions persisted before the phase rename.
        if ((data.phase as string) === "finalized") {
          return { ...data, phase: "finalizing" };
        }
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
 * Build the session title "<phase> · <short-topic>".
 *
 * Uses shortSlug() on specText; long topics that exceed the slug limit
 * fall back to a phase-only title so updateUi never throws.
 *
 * @param state - Current workflow state.
 * @returns The title string.
 */
function buildTitle(state: WorkflowState): string {
  const phaseLabel = state.phase.replace(/_/g, " ");
  if (!state.specText) return phaseLabel;
  try {
    const slug = shortSlug(state.specText);
    return slug ? `${phaseLabel} · ${slug}` : phaseLabel;
  } catch {
    return phaseLabel;
  }
}

/**
 * Toggle workflow widget visibility.
 *
 * Flips the in-memory `widgetVisible` flag and returns the new value.
 * The caller re-renders via updateUi afterwards. State is not
 * persisted: a session reload starts hidden again.
 *
 * @returns true when the widget is now visible.
 */
export function toggleWidgetVisible(): boolean {
  widgetVisible = !widgetVisible;
  return widgetVisible;
}

/**
 * Update the UI status, widget, and session title to reflect the phase.
 *
 * Uses only the string-array form of setWidget so it works in RPC mode
 * (paseo). The widget's first line is a phase header so the current
 * state is visible at a glance.
 *
 * The widget itself is gated by the module-level `widgetVisible` flag:
 * hidden by default, toggled by the /task command. setStatus and
 * setTitle stay unconditional, so the footer phase indicator remains
 * visible even while the widget is hidden.
 *
 * @param state - Current workflow state.
 * @param ctx   - Extension context for UI access.
 */
export function updateUi(state: WorkflowState | null, ctx: ExtensionContext): void {
  if (!state || state.phase === "idle") {
    ctx.ui.setStatus("workflow", undefined);
    ctx.ui.setWidget("workflow-todos", undefined);
    ctx.ui.setTitle("pi");
    return;
  }

  const phaseLabel = state.phase.replace(/_/g, " ");
  ctx.ui.setStatus(
    "workflow",
    ctx.ui.theme.fg("accent", `◉ ${phaseLabel}`),
  );
  ctx.ui.setTitle(buildTitle(state));

  // Widget visibility gate: hidden by default; /task toggles it on.
  if (!widgetVisible) {
    ctx.ui.setWidget("workflow-todos", undefined);
    return;
  }

  const lines: string[] = [
    ctx.ui.theme.fg("accent", PHASE_HEADERS[state.phase] ?? `◉ ${phaseLabel}`),
  ];
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
