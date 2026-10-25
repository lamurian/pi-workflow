// ─── Orchestrator halt builder ───────────────────────────────────────────────
// Builds the halt closure used across one runOrchestratedImplement pass:
// persists lastHalt, enriches the result with tree state, baseline commits,
// attempt history, findings and the derived diagnosis.

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { saveState, updateUi, type WorkflowState, type PendingCommand } from "./state.ts";
import type { AttemptRecord } from "./halt-report.ts";
import { deriveDiagnosis } from "./halt-diagnosis.ts";
import { readCommitsSinceBaseline, readTreeState } from "./git-ops.ts";
import { cleanupOrchestration } from "./hitl-pause.ts";
import type { OrchestratorResult } from "./implement-loop.ts";

/** State a halt needs to fill the result and persist lastHalt (T8). */
export interface HaltDeps {
  /** ExtensionAPI (exec for tree state and baseline commits, state persistence). */
  pi: ExtensionAPI;
  /** Extension context (cwd, UI). */
  ctx: ExtensionContext;
  /** Current workflow state (mutated: lastHalt). */
  state: WorkflowState;
  /** Repository working directory. */
  cwd: string;
  /** The shared result object the halt fills. */
  result: OrchestratorResult;
  /** Commits landed so far (persisted to lastHalt). */
  landedCommits: string[];
  /** Per-attempt history of the currently-halted-behavior candidate. */
  attemptHistory: AttemptRecord[];
}

/**
 * Build the halt closure for one orchestrator run.
 *
 * On halt: cleans up orchestration, fills the result (haltedOn, error,
 * treeState, pendingCommand, commitsSinceBaseline, attempts, findings,
 * diagnosis, recommendation), persists `state.lastHalt`, refreshes the UI
 * and clears the implement status.
 *
 * @param deps - The shared run state the halt fills and persists.
 * @returns The async halt function handed to runBehaviorLoop.
 */
export function createHalt(deps: HaltDeps): (
  behaviorId: string,
  error: string,
  pendingCommand?: PendingCommand,
) => Promise<OrchestratorResult> {
  const { pi, ctx, state, cwd, result, landedCommits, attemptHistory } = deps;
  return async (behaviorId, error, pendingCommand) => {
    await cleanupOrchestration();
    result.haltedOn = behaviorId;
    result.error = error;
    result.treeState = await readTreeState(pi, cwd);
    if (pendingCommand) result.pendingCommand = pendingCommand;
    // T8: enrich the halt with baseline commits, attempt history, findings
    // tail and a derived diagnosis — all persisted to lastHalt.
    const commits = await readCommitsSinceBaseline(pi, cwd, state.baselineHead);
    if (commits?.length) result.commitsSinceBaseline = commits;
    result.attempts = attemptHistory.map((entry) => ({ ...entry }));
    result.findings = state.findings?.length ? [...state.findings] : undefined;
    const diagnosis = deriveDiagnosis(result.attempts, error);
    result.diagnosis = diagnosis.diagnosis;
    result.recommendation = diagnosis.recommendation;
    state.lastHalt = {
      behaviorId,
      error,
      treeState: result.treeState,
      landedCommits: [...landedCommits],
      attempts: result.attempts,
      diagnosis: diagnosis.diagnosis,
      recommendation: diagnosis.recommendation,
      ...(pendingCommand ? { pendingCommand } : {}),
      at: new Date().toISOString(),
    };
    saveState(pi, state);
    updateUi(state, ctx);
    ctx.ui.setStatus("implement", undefined);
    return result;
  };
}
