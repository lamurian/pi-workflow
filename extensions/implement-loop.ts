import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { saveState, updateUi, type WorkflowState, type TaskContract, type PendingCommand, type PendingManualCheck } from "./state.ts";
import { evaluateCompletionGate } from "./task-contract.ts";
import { appendFindings, renderFindingsSection, type Finding } from "./findings-ledger.ts";
import { deriveDiagnosis, type AttemptRecord } from "./halt-report.ts";
import { renderPreviousHaltSection } from "./resume-context.ts";
import { runImplementerUnit, type UnitTask } from "./implementer-runner.ts";
import type { BlockedCommand, ImplementerReport } from "./implementer-report.ts";
import type { RpcUnitClient } from "./rpc-unit-client.ts";
import { cleanupOrchestration, registerWorkflowInputHandler } from "./hitl-pause.ts";
import { readCommitsSinceBaseline, readTreeState } from "./git-ops.ts";
import { buildEngineerNoteSection, loadUnitPrompt } from "./unit-task-text.ts";
import { runBehaviorLoop } from "./behavior-loop.ts";

// ─── Types ─────────────────────────────────────────────────────────────────────

/** Result of one unit attempt: the parsed report plus failure diagnostics. */
export type UnitAttempt = ImplementerReport & {
  error?: string;
  /** True when the unit subprocess was killed by the wall-clock timeout. */
  timedOut?: boolean;
  /** True when the unit exited 0 without the mandatory JSON report block. */
  missingReport?: boolean;
  /** Live rpc client handle; present only for manual-kind behaviors (T3). */
  client?: RpcUnitClient;
};

/** Injectable unit runner: execute one behavior, return its report. */
export type UnitRunner = (
  unit: UnitTask,
  cwd: string,
  signal?: AbortSignal,
  onEvent?: (event: Record<string, unknown>) => void,
) => Promise<UnitAttempt>;

/** Result of the orchestrator loop. */
export interface OrchestratorResult {
  /** True when every unit completed and the workflow returned to idle. */
  complete: boolean;
  /** Number of units that ran (including retries). */
  unitsRun: number;
  /** Commit subjects landed so far, in order. */
  landedCommits: string[];
  /** Behaviors marked done without a commit via the alreadySatisfied flag (T11a). */
  satisfiedWithoutCommit: string[];
  /** Populated when the loop halted early. */
  haltedOn?: string;
  /** Failure detail when the loop halted. */
  error?: string;
  /** `git status --short` snapshot captured at halt time. */
  treeState?: string;
  /** Sandbox-blocked command the user must run before resuming (pause-halt). */
  pendingCommand?: PendingCommand;
  /** Deferrable sandbox-blocked commands reported by units (informational). */
  deferredCommands?: BlockedCommand[];
  /** Manual behaviors whose verification timed out — committed but unconfirmed. */
  pendingManualChecks?: PendingManualCheck[];
  /** Per-attempt history recorded for the halted behavior (T8). */
  attempts?: AttemptRecord[];
  /** Commit subjects since the /implement baseline, git log baseline..HEAD (T8). */
  commitsSinceBaseline?: string[];
  /** Shared findings ledger snapshot at halt time; the report renders its tail (T8). */
  findings?: Finding[];
  /** Derived one-line halt diagnosis (T8). */
  diagnosis?: string;
  /** Derived one-line recommended next action (T8). */
  recommendation?: string;
}

// ─── Orchestrator loop ─────────────────────────────────────────────────────────

/**
 * Run the orchestrator loop over a task contract (HEAD-gate design).
 *
 * For each active behavior, in order: run the unit (subprocess), then commit
 * with the unit's suggested subject — the project's pre-commit hooks fire and
 * own verification. HEAD before/after classifies the attempt: landed (done),
 * hook-rejected (investigation + fix subagent, RETRY_BUDGET retries), or
 * no-changes (same budget). A mustRunNow blockedCommands report pauses
 * immediately (no commit, no retry consumption) with pendingCommand on the
 * halt handoff. Commit-process timeouts halt as infrastructure
 * failures. Every halt persists lastHalt into workflow state so failures are
 * diagnosable from the session log. Already-done behaviors are skipped, so
 * re-running resumes cleanly. Progress notifications (unit start + landed
 * commit) keep a multi-minute run visibly alive in the UI.
 *
 * The per-behavior unit/retry/commit loop lives in runBehaviorLoop
 * (behavior-loop.ts); this driver owns unit filtering, halt wiring, the
 * shared findings ledger, resume context, and the empty-units gate.
 *
 * A non-empty engineerNote is appended to every unit's task text: the base
 * attempt, every retry (buildRetryTask), and every fix subagent (whose
 * original task text already carries it). On completion the loop clears
 * state.engineerNote along with the phase switch to idle.
 *
 * @param pi           - ExtensionAPI reference.
 * @param ctx          - Extension context (cwd, UI).
 * @param state        - Current workflow state (mutated in place).
 * @param task         - The task contract.
 * @param runUnit      - Injectable unit runner (defaults to the real subprocess).
 * @param engineerNote - Optional engineer's note forwarded from /implement.
 * @returns Loop outcome including landed commits and halt details.
 */
export async function runOrchestratedImplement(
  pi: ExtensionAPI,
  ctx: ExtensionContext,
  state: WorkflowState,
  task: TaskContract,
  runUnit: UnitRunner = (unit, cwd, signal, onEvent) => runImplementerUnit(loadUnitPrompt(), unit.taskText, cwd, signal, undefined, onEvent, unit.kind === "manual"),
  engineerNote?: string,
): Promise<OrchestratorResult> {
  const cwd = ctx.cwd;
  const landedCommits: string[] = [];
  const noteSection = engineerNote ? buildEngineerNoteSection(engineerNote) : "";
  const units = task.behaviors.filter((b) => b.status === "active");

  /** Current findings section for task texts (shared ledger, all behaviors). */
  const findingsSection = () => renderFindingsSection(state.findings);

  /**
   * Append a unit attempt's report findings to the shared ledger and
   * persist the state. Exact duplicates are skipped; when nothing new
   * lands, no persist happens.
   *
   * @returns True when at least one new finding landed in the ledger.
   */
  const recordFindings = (behaviorId: string, texts: string[] | undefined): boolean => {
    if (!texts?.length) return false;
    const { ledger, changed } = appendFindings(state.findings ?? [], behaviorId, texts);
    if (!changed) return false;
    state.findings = ledger;
    saveState(pi, state);
    return true;
  };

  const result: OrchestratorResult = {
    complete: false,
    unitsRun: 0,
    landedCommits,
    satisfiedWithoutCommit: [],
    deferredCommands: [],
    pendingManualChecks: [],
  };

  // T8: per-attempt history of the currently-halted-behavior candidate.
  // Reset per behavior; on halt it feeds the attempt table, the diagnosis
  // derivation and lastHalt persistence.
  const attemptHistory: AttemptRecord[] = [];

  // Steering (T4): while a verification pause is open, plain user input at
  // the main prompt is consumed and forwarded to the live child; slash
  // commands and everything outside a pause pass through. Unregistered on
  // every exit path via cleanupOrchestration.

  const halt = async (
    behaviorId: string,
    error: string,
    pendingCommand?: PendingCommand,
  ) => {
    await cleanupOrchestration();
    result.haltedOn = behaviorId;
    result.error = error;
    result.treeState = await readTreeState(pi, cwd);
    if (pendingCommand) result.pendingCommand = pendingCommand;
    // T8: enrich the halt — cumulative commits since the /implement
    // baseline (per-run fallback stays in composeHaltReport), the halted
    // behavior's attempt history, the findings tail, and a derived
    // diagnosis + recommended next action. All of it persists to lastHalt.
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

  if (units.length === 0) {
    result.complete = evaluateCompletionGate(state) === null;
    if (result.complete) {
      state.phase = "idle";
      state.engineerNote = undefined;
      state.findings = undefined;
      saveState(pi, state);
      updateUi(null, ctx);
    }
    ctx.ui.setStatus("implement", undefined);
    return result;
  }

  const resuming = state.phase === "implementing";
  registerWorkflowInputHandler(pi);
  let resumeTreeContext = "";
  if (resuming) {
    const tree = await readTreeState(pi, cwd);
    if (tree && tree !== "(unavailable)") {
      resumeTreeContext =
        `\n\n## Working tree is dirty (resumed session)\n` +
        `The previous run left uncommitted changes. Inspect them before implementing:\n\n` +
        "```\n" + tree + "\n```\n";
    }
  }

  const totalUnits = units.length;
  // Resume after a mustRunNow pause-halt: the user was asked to run the
  // blocked command outside the sandbox. Assume it was executed — the
  // unit must not attempt it (its sandbox still blocks it). Capture the
  // note before the loop (a landed commit clears state.lastHalt), attach
  // it only to the behavior that halted, then clear it so later behaviors
  // never inherit it.
  let pendingNote: { behaviorId: string; note: string } | undefined;
  if (state.lastHalt?.pendingCommand) {
    const pending = state.lastHalt.pendingCommand;
    pendingNote = {
      behaviorId: state.lastHalt.behaviorId,
      note:
        `\n\n## Previously blocked command — assumed run\n` +
        `The user was asked to run this command outside the sandbox:\n\n` +
        "```\n" + pending.command + "\n```\n\n" +
        (pending.reason ? `It was blocked: ${pending.reason}.\n\n` : "") +
        `Assume it has been executed. Do NOT attempt to run it yourself — your sandbox still blocks it. ` +
        `Verify its effects by other means (read files, run allowed checks). ` +
        `If its effects are missing, report that in your JSON report instead of retrying the command.`,
    };
  }
  // T9: resume halt context. Capture state.lastHalt before the loop (a
  // landed commit clears it), render the "## Previous run halted" section
  // once, and prepend it to the base task text of the FIRST unit of the
  // halted behavior only — it is dropped after that unit so retries,
  // continuations and other behaviors never inherit it.
  const previousHalt = state.lastHalt;
  let previousHaltSection = previousHalt ? renderPreviousHaltSection(previousHalt) : "";
  for (let unitIndex = 0; unitIndex < units.length; unitIndex++) {
    const behavior = units[unitIndex]!;
    let taskPrefix = "";
    if (pendingNote && pendingNote.behaviorId === behavior.id) {
      taskPrefix = pendingNote.note;
      pendingNote = undefined;
      if (state.lastHalt?.pendingCommand) {
        state.lastHalt.pendingCommand = undefined;
        saveState(pi, state);
      }
    }
    let haltPrefix = "";
    if (previousHaltSection && previousHalt?.behaviorId === behavior.id) {
      haltPrefix = previousHaltSection + "\n\n";
      previousHaltSection = "";
    }
    const halted = await runBehaviorLoop(behavior, unitIndex, totalUnits, {
      pi, ctx, state, task, runUnit, result, landedCommits, attemptHistory,
      findingsSection, recordFindings, noteSection, taskPrefix, haltPrefix, resumeTreeContext, halt,
    });
    resumeTreeContext = "";
    if (halted) return halted;
  }

  const refusal = evaluateCompletionGate(state);
  if (refusal) {
    return halt(units[units.length - 1]!.id, `Completion gate refused: ${refusal}`);
  }
  await cleanupOrchestration();
  state.phase = "idle";
  state.engineerNote = undefined;
  state.findings = undefined;
  saveState(pi, state);
  updateUi(null, ctx);
  ctx.ui.setStatus("implement", undefined);
  result.complete = true;
  return result;
}
