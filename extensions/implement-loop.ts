import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { saveState, type WorkflowState, type TaskContract, type PendingCommand, type PendingManualCheck } from "./state.ts";
import { evaluateCompletionGate } from "./completion-gate.ts";
import { appendFindings, renderFindingsSection, GLOBAL_FINDINGS_ID, type Finding } from "./findings-ledger.ts";
import type { AttemptRecord } from "./halt-report.ts";
import { renderPreviousHaltSection } from "./resume-context.ts";
import type { UnitTask } from "./implementer-runner.ts";
import type { BlockedCommand, ImplementerReport } from "./implementer-report.ts";
import type { RpcUnitClient } from "./rpc-unit-client.ts";
import { registerWorkflowInputHandler } from "./hitl-pause.ts";
import { readTreeState } from "./git-ops.ts";
import { buildDirtyTreeAdvisoryText, buildDirtyTreeHaltText, dirtyTreePreflight } from "./dirty-tree-check.ts";
import { TEST_EXTENSION_CHORE_SUBJECT } from "./test-extension-chore.ts";
import { ensureTestExtensionAtStart } from "./test-tool-ensure.ts";
import { refreshTestExtensionAfterLanding } from "./test-extension-refresh.ts";
import { buildEngineerNoteSection } from "./unit-task-text.ts";
import { createDefaultUnitRunner } from "./unit-runner-default.ts";
import { formatModelRef } from "./process-utils.ts";
import { createHalt } from "./orchestrator-halt.ts";
import { finishRun, type FinalGateDeps } from "./full-gate-fix.ts";
import { runBehaviorLoop } from "./behavior-loop.ts";
import type { SlowTask } from "./implement-report.ts";
import { createDurationTracker } from "./duration-tracker.ts";

/** Result of one unit attempt: the parsed report plus failure diagnostics. */
export type UnitAttempt = ImplementerReport & {
  error?: string;
  timedOut?: boolean; // True when the unit subprocess was killed by the wall-clock timeout.
  missingReport?: boolean; // True when the unit exited 0 without the mandatory JSON report block.
  undeliveredSteer?: boolean; // True when a warm fix round was never picked up by the child (T2).
  client?: RpcUnitClient; // Live rpc client handle; only for manual-kind behaviors (T3).
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
  slowTasks?: SlowTask[];
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
 *                       write the payload file, then spawn with PI_UNIT_FILE and
 *                       the session model as `--model <provider>/<id>`).
 * @param engineerNote - Optional engineer's note forwarded from /implement.
 * @returns Loop outcome including landed commits and halt details.
 */
export async function runOrchestratedImplement(
  pi: ExtensionAPI,
  ctx: ExtensionContext,
  state: WorkflowState,
  task: TaskContract,
  baseRunUnit: UnitRunner = createDefaultUnitRunner(pi, state, task, formatModelRef(ctx.model)),
  engineerNote?: string,
): Promise<OrchestratorResult> {
  const cwd = ctx.cwd;
  const landedCommits: string[] = [];
  const noteSection = engineerNote ? buildEngineerNoteSection(engineerNote) : "";
  const units = task.behaviors.filter((b) => b.status === "active");

  // T13: findings are scoped to the current behavior plus global (shared) entries.
  let currentBehaviorId: string | undefined;
  const findingsSection = () => renderFindingsSection(state.findings, currentBehaviorId);

  /** Append findings to the ledger and persist; true when something new landed. */
  const recordFindings = (behaviorId: string, texts: string[] | undefined): boolean => {
    if (!texts?.length) return false;
    const { ledger, changed } = appendFindings(state.findings ?? [], behaviorId, texts);
    if (!changed) return false;
    state.findings = ledger;
    saveState(pi, state);
    return true;
  };

  // Report sharedFindings land in the ledger as global entries.
  const runUnit: UnitRunner = async (unit, unitCwd, signal, onEvent) => {
    const attempt = await baseRunUnit(unit, unitCwd, signal, onEvent);
    return recordFindings(GLOBAL_FINDINGS_ID, attempt.sharedFindings), attempt;
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
  const attemptHistory: AttemptRecord[] = [];

  // T22: per-behavior attempt seconds live in duration-tracker.ts.
  const tracker = createDurationTracker(cwd, () => state.contractV2, result);
  const setSlow = tracker.attach;

  const halt = createHalt({ pi, ctx, state, cwd, result, landedCommits, attemptHistory });

  // T7: final-gate phase runs after the completion gate passes (both paths).
  const gateDeps: FinalGateDeps = { pi, ctx, state, task, runUnit, halt, landedCommits, result };

  if (units.length === 0) {
    if (evaluateCompletionGate(state) !== null) {
      ctx.ui.setStatus("implement", undefined);
      return result;
    }
    return finishRun(gateDeps);
  }

  // T9: land the test-extension chore commit before any unit spawns; failure halts.
  const startEnsure = await ensureTestExtensionAtStart(pi, cwd, state);
  if (startEnsure.kind === "failed") {
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

  // T6: dirty-tree preflight (v2 only) — later-task-owned dirty paths halt.
  if (state.contractV2) {
    const pre = await dirtyTreePreflight(pi, cwd, state.contractV2, units[0]!.id);
    if (pre.blocking.length > 0) return halt(units[0]!.id, buildDirtyTreeHaltText(pre, units[0]!.id));
    const advisory = buildDirtyTreeAdvisoryText(pre);
    if (advisory) ctx.ui.notify(advisory, "info");
  }

  const resuming = state.phase === "implementing";
  // Steering (T4): user input during an open verification pause goes to the live child.
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

  // Resume after a mustRunNow pause-halt: note attaches to the halted behavior only.
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
  // T9: resume halt context, prepended to the first unit of the halted behavior only.
  const previousHalt = state.lastHalt;
  let previousHaltSection = previousHalt ? renderPreviousHaltSection(previousHalt) : "";
  for (let unitIndex = 0; unitIndex < units.length; unitIndex++) {
    const behavior = units[unitIndex]!;
    currentBehaviorId = behavior.id;
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
    const landedBefore = landedCommits.length;
    const halted = await runBehaviorLoop(behavior, unitIndex, units.length, {
      pi, ctx, state, task, runUnit, result, landedCommits, attemptHistory,
      findingsSection, recordFindings, noteSection, taskPrefix, haltPrefix, resumeTreeContext, halt,
    });
    resumeTreeContext = "";
    tracker.record(behavior.id, attemptHistory);
    if (halted) return setSlow(halted);
    if (landedCommits.length > landedBefore) await refreshTestExtensionAfterLanding(pi, cwd, state);
  }
  setSlow(result);

  const refusal = evaluateCompletionGate(state);
  if (refusal) {
    return setSlow(await halt(units[units.length - 1]!.id, `Completion gate refused: ${refusal}`));
  }
  return setSlow(await finishRun(gateDeps));
}
