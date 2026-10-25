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
import { TEST_EXTENSION_CHORE_SUBJECT } from "./test-extension-chore.ts";
import { writeContractGuardFile } from "./contract-guard-file.ts";
import { ensureTestExtensionAtStart } from "./test-tool-ensure.ts";
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

/**
 * Result of the orchestrator loop.
 *
 * Completion: `complete`, `unitsRun`, `landedCommits`,
 * `satisfiedWithoutCommit`, `leftUncommitted`. Halt: `haltedOn`, `error`,
 * `treeState`, `pendingCommand`, `deferredCommands`, `pendingManualChecks`,
 * `attempts`, `commitsSinceBaseline`, `findings`, `diagnosis`,
 * `recommendation`, plus `cancelled` for a /discuss cancellation.
 */
export interface OrchestratorResult {
  complete: boolean;
  cancelled?: boolean;
  unitsRun: number;
  landedCommits: string[];
  satisfiedWithoutCommit: string[];
  leftUncommitted?: Array<{ behaviorId: string; sourceFile: string }>;
  haltedOn?: string;
  error?: string;
  treeState?: string;
  pendingCommand?: PendingCommand;
  deferredCommands?: BlockedCommand[];
  pendingManualChecks?: PendingManualCheck[];
  attempts?: AttemptRecord[];
  commitsSinceBaseline?: string[];
  findings?: Finding[];
  diagnosis?: string;
  recommendation?: string;
}

// ─── Orchestrator loop ─────────────────────────────────────────────────────────

/**
 * Build the default unit runner for one /implement run: writes the
 * per-spawn payload to `.git/pi-workflow/contract-guard.json` before
 * every spawn (base attempt, retry, fix, continuation) and runs the unit
 * with `PI_UNIT_FILE` pointing at it so the child contract-guard
 * extension can enforce the allowlist in-turn (`PI_CONTRACT_GUARD_FILE`
 * stays set as the legacy read-fallback for one release). v2 sessions
 * (state.contractV2) get the derived allowlist plus the unit's slice
 * (`unit { id, sources, tests, packages, testSuites }`); v1 sessions keep
 * the plain `files` payload.
 *
 * @param pi    - ExtensionAPI (used for the baseline `git ls-tree` query).
 * @param state - Current workflow state (supplies baselineHead, contractV2).
 * @param task  - The task contract (supplies the declared files).
 * @returns A UnitRunner that writes the payload file, then spawns the unit.
 */
export function createDefaultUnitRunner(
  pi: ExtensionAPI,
  state: WorkflowState,
  task: TaskContract,
): UnitRunner {
  return async (unit, cwd, signal, onEvent) => {
    // T5: v2 sessions write the derived allowlist + the unit's slice; the
    // taskId keys the slice (ignored by the writer in v1 mode, where the
    // plain `files` payload is kept — no ownership refs exist there).
    const guardPath = await writeContractGuardFile(
      pi, cwd, task.files, state.baselineHead ?? "HEAD",
      {
        contract: state.contractV2,
        taskId: unit.behaviorId,
        testSuites: state.testTool?.suites ?? [],
      },
    );
    // T5: keep the child alive after every report — test-kind children absorb
    // hook-rejected/no-changes fixes as warm steers; the behavior loop shuts
    // them down on landing, halt, cancel and completion paths.
    return runImplementerUnit(
      loadUnitPrompt(), unit.taskText, cwd, signal, undefined,
      onEvent, true,
      {
        PI_UNIT_FILE: guardPath,
        // Legacy read-fallback for one release (T5).
        PI_CONTRACT_GUARD_FILE: guardPath,
      },
    );
  };
}

/**
 * Run the orchestrator loop over a task contract (HEAD-gate design).
 *
 * For each active behavior: run the unit (kept-alive subprocess), then commit
 * with the unit's suggested subject — the project's pre-commit hooks fire and
 * own verification. HEAD before/after classifies the attempt: landed (done),
 * hook-rejected, or no-changes — both retried via warm steers into the live
 * child when possible (T5), else fresh fix units, RETRY_BUDGET times. Halts
 * persist lastHalt into workflow state; already-done behaviors are skipped.
 *
 * The per-behavior unit/retry/commit loop lives in runBehaviorLoop
 * (behavior-loop.ts); this driver owns unit filtering, halt wiring, the
 * shared findings ledger, resume context, and the empty-units gate.
 * A non-empty engineerNote is appended to every unit's task text; on
 * completion the loop clears state.engineerNote with the phase switch to idle.
 *
 * @param pi           - ExtensionAPI reference.
 * @param ctx          - Extension context (cwd, UI).
 * @param state        - Current workflow state (mutated in place).
 * @param task         - The task contract.
 * @param runUnit      - Injectable unit runner (defaults to createDefaultUnitRunner:
 *                       write the payload file, then spawn with PI_UNIT_FILE).
 * @param engineerNote - Optional engineer's note forwarded from /implement.
 * @returns Loop outcome including landed commits and halt details.
 */
export async function runOrchestratedImplement(
  pi: ExtensionAPI,
  ctx: ExtensionContext,
  state: WorkflowState,
  task: TaskContract,
  runUnit: UnitRunner = createDefaultUnitRunner(pi, state, task),
  engineerNote?: string,
): Promise<OrchestratorResult> {
  const cwd = ctx.cwd;
  const landedCommits: string[] = [];
  const noteSection = engineerNote ? buildEngineerNoteSection(engineerNote) : "";
  const units = task.behaviors.filter((b) => b.status === "active");

  /** Current findings section for task texts (shared ledger, all behaviors). */
  const findingsSection = () => renderFindingsSection(state.findings);

  /**
   * Append a unit attempt's report findings to the shared ledger and persist
   * the state (exact duplicates skipped; no persist when nothing new lands).
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
    leftUncommitted: [],
    deferredCommands: [],
    pendingManualChecks: [],
  };

  // T8: per-attempt history of the currently-halted-behavior candidate;
  // reset per behavior, feeds the attempt table, diagnosis and lastHalt.
  const attemptHistory: AttemptRecord[] = [];

  // Steering (T4): while a verification pause is open, plain user input at
  // the main prompt is forwarded to the live child; unregistered on every
  // exit path via cleanupOrchestration.

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

  // T9: at /implement start, before the first unit spawns, the orchestrator
  // runs the ensure step for the generated test extension (orchestrator-owned,
  // never writable by a unit) and lands any regeneration as the SOLE
  // chore-commit exception: the commit may contain only
  // .pi/extensions/test.ts. Any other staged path aborts the chore commit
  // and halts the run before any unit work begins.
  const startEnsure = await ensureTestExtensionAtStart(pi, cwd, state);
  if (startEnsure.kind === "aborted" || startEnsure.kind === "failed") {
    return halt(
      units[0]!.id,
      `Test-extension chore commit ${startEnsure.kind} at /implement start — the run halts before any unit spawns.\n\n${startEnsure.investigation}`,
    );
  }
  if (startEnsure.kind === "landed") {
    ctx.ui.notify(
      `${TEST_EXTENSION_CHORE_SUBJECT} — .pi/extensions/test.ts committed alone (sole chore-commit path)`,
      "info",
    );
  }

  const resuming = state.phase === "implementing";
  registerWorkflowInputHandler(pi, ctx);
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
  // Resume after a mustRunNow pause-halt: assume the user ran the blocked
  // command. Capture the note before the loop (a landed commit clears
  // state.lastHalt) and attach it only to the behavior that halted.
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
