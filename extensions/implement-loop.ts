import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
  saveState,
  updateUi,
  type WorkflowState,
  type TaskContract,
  type PendingCommand,
  type PendingManualCheck,
} from "./state.ts";
import { evaluateCompletionGate } from "./task-contract.ts";
import {
  appendFindings,
  createToolCallCollector,
  renderFindingsSection,
  renderToolCallDigest,
  type Finding,
} from "./findings-ledger.ts";
import {
  buildContinuationTaskText,
  classifyProgress,
  decideContinuation,
  isAlreadySatisfied,
  isPartialAttempt,
  shouldHaltEarly,
  buildEarlyHaltError,
} from "./unit-progress.ts";
import {
  classifyAttemptOutcome,
  deriveDiagnosis,
  truncateAttemptText,
  type AttemptOutcome,
  type AttemptRecord,
} from "./halt-report.ts";
import { renderPreviousHaltSection } from "./resume-context.ts";
import {
  runImplementerUnit,
  getActiveUnitClient,
  setActiveUnitClient,
  type UnitTask,
} from "./implementer-runner.ts";
import type { BlockedCommand, ImplementerReport } from "./subagent-runner.ts";
import type { RpcUnitClient } from "./rpc-unit-client.ts";
import { RETRY_BUDGET, buildFixTask } from "./commit-gate.ts";
import { relayImplementerEvent } from "./implementer-activity.ts";
import {
  cleanupOrchestration,
  openVerificationPause,
  registerWorkflowInputHandler,
  type PauseOutcome,
} from "./hitl-pause.ts";
import {
  commitAndGate,
  getCommitTimeoutMs,
  pickCommitSubject,
  readCommitsSinceBaseline,
  readGitHead,
  readTreeFingerprint,
  readTreeState,
} from "./git-ops.ts";
import {
  buildEngineerNoteSection,
  buildRetryTask,
  buildUnitTask,
  loadUnitPrompt,
} from "./unit-task-text.ts";

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
  runUnit: UnitRunner = (unit, cwd, signal, onEvent) =>
    runImplementerUnit(
      loadUnitPrompt(),
      unit.taskText,
      cwd,
      signal,
      undefined,
      onEvent,
      unit.kind === "manual",
    ),
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
    // T8: attempt history is per behavior — a landed behavior's history
    // is irrelevant to a later behavior's halt report.
    attemptHistory.length = 0;
    // Progress visibility: a unit subprocess can run for minutes with captured
    // stdio — announce start and landing so a healthy run never looks frozen.
    ctx.ui.notify(`Running unit ${behavior.id} (${unitIndex + 1}/${totalUnits})`, "info");
    // B3: live footer status under the distinct "implement" key; the
    // "workflow" key from state.ts updateUi is never written by these frames.
    const position = `${unitIndex + 1}/${totalUnits}`;
    ctx.ui.setStatus("implement", `✦ ${behavior.id} (${position}): implementing…`);
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
    const baseCore = taskPrefix + buildUnitTask(behavior, task) + noteSection + resumeTreeContext;
    const baseTask: UnitTask = {
      behaviorId: behavior.id,
      taskText: haltPrefix + baseCore + findingsSection(),
      kind: behavior.kind,
    };
    resumeTreeContext = "";

    const relay = (event: Record<string, unknown>) =>
      relayImplementerEvent(pi, ctx, behavior.id, position, event);
    /**
     * Run one unit attempt and record its report findings in the ledger.
     * Timed-out or report-less attempts additionally contribute a tool-call
     * digest (T5) so the next attempt does not re-read blindly. Captures the
     * tree fingerprint before the attempt (T6 progress detection) and tracks
     * whether any new finding landed during it.
     */
    let attemptFingerprintBefore = "";
    let attemptNewFindings = false;
    let attemptProgress = false;
    // T11a: HEAD before this attempt, compared with HEAD after it for the
    // already-satisfied check (the flag alone never skips the commit gate).
    let attemptHeadBefore: string | null = null;
    const runAndRecord = async (unit: UnitTask): Promise<UnitAttempt> => {
      attemptFingerprintBefore = await readTreeFingerprint(pi, cwd);
      attemptHeadBefore = await readGitHead(pi, cwd);
      attemptNewFindings = false;
      const startedAt = Date.now();
      const digest = createToolCallCollector();
      const out = await runUnit(unit, cwd, undefined, (event) => {
        digest.record(event);
        relay(event);
      });
      attemptNewFindings = recordFindings(behavior.id, out.findings);
      if (out.timedOut || out.missingReport) {
        const digestText = renderToolCallDigest(digest.entries());
        if (digestText) {
          attemptNewFindings = recordFindings(behavior.id, [digestText]) || attemptNewFindings;
        }
      }
      // T8: classify and record the finished attempt. Timed-out/partial
      // attempts additionally compute their progress flag here; the
      // partial branch reuses it instead of re-fingerprinting the tree.
      const preOutcome = classifyAttemptOutcome(out);
      let progress = attemptNewFindings;
      if (preOutcome === "timeout" || preOutcome === "partial") {
        progress =
          classifyProgress({
            fingerprintBefore: attemptFingerprintBefore,
            fingerprintAfter: await readTreeFingerprint(pi, cwd),
            newFindings: attemptNewFindings,
          }) || attemptNewFindings;
      }
      attemptProgress = progress;
      attemptHistory.push({
        attempt: attemptHistory.length + 1,
        outcome: preOutcome,
        durationSec: Math.max(0, Math.round((Date.now() - startedAt) / 1000)),
        progress,
        lastText: truncateAttemptText(out.error ?? out.summary ?? ""),
      });
      return out;
    };
    /** Seal the last recorded attempt with the commit-gate verdict (T8). */
    const sealLastAttempt = (outcome: AttemptOutcome) => {
      const last = attemptHistory[attemptHistory.length - 1];
      if (last) last.outcome = outcome;
    };
    let attempt = await runAndRecord(baseTask);
    result.unitsRun++;
    let taskText = baseTask.taskText;
    // T6: continuation units per behavior, bounded and never charged to the
    // retry budget; reset per behavior.
    let continuations = 0;
    let retry = 1;
    // T7: consecutive timed-out/partial attempts that neither moved the tree
    // fingerprint nor added findings; two in a row halt the behavior early.
    let noProgressStreak = 0;

    while (retry <= RETRY_BUDGET + 1) {
      // T6: partial reports and timed-out attempts never reach the commit
      // gate — their work stays uncommitted for a continuation unit.
      if (!attempt.missingReport && isPartialAttempt(attempt)) {
        const progressed = attemptProgress;
        if (progressed) {
          noProgressStreak = 0;
        } else if (shouldHaltEarly(++noProgressStreak)) {
          // T7: repeated identical timeouts/partial reports waste hours —
          // halt with an actionable diagnosis instead of burning retries.
          return halt(behavior.id, buildEarlyHaltError(behavior.id, noProgressStreak));
        }
        if (decideContinuation({ progressed, continuations }) === "continue") {
          continuations++;
          ctx.ui.setStatus("implement", `✦ ${behavior.id} (${position}): continuing partial work…`);
          taskText =
            buildContinuationTaskText(behavior.id, attempt, baseCore, await readTreeState(pi, cwd)) +
            noteSection +
            findingsSection();
          attempt = await runAndRecord({ behaviorId: behavior.id, taskText, kind: behavior.kind });
          result.unitsRun++;
          continue;
        }
        if (!attempt.error) {
          // A partial report without progress consumes one retry as today.
          if (retry > RETRY_BUDGET) {
            return halt(
              behavior.id,
              `Unit ${behavior.id} reported partial work after ${RETRY_BUDGET} retries without ` +
                `advancing the tree or adding findings: ${attempt.summary ?? "no summary"}`,
            );
          }
          ctx.ui.setStatus("implement", `✦ ${behavior.id} (${position}): retry ${retry}/${RETRY_BUDGET}…`);
          taskText = buildRetryTask(behavior, task, attempt, retry) + noteSection + findingsSection();
          attempt = await runAndRecord({ behaviorId: behavior.id, taskText, kind: behavior.kind });
          result.unitsRun++;
          retry++;
          continue;
        }
        // Timed out without progress (or beyond the continuation budget):
        // fall through to the unchanged timeout-retry path below.
      }

      if (attempt.error) {
        // A plain unit error (no partial report, no timeout) breaks any
        // no-progress streak: only timed-out/partial attempts count toward
        // the early halt.
        if (!isPartialAttempt(attempt)) noProgressStreak = 0;
        if (retry > RETRY_BUDGET) {
          return halt(behavior.id, `Unit ${behavior.id} failed after ${RETRY_BUDGET} retries: ${attempt.error}`);
        }
        ctx.ui.setStatus("implement", `✦ ${behavior.id} (${position}): retry ${retry}/${RETRY_BUDGET}…`);
        taskText = buildRetryTask(behavior, task, attempt, retry) + noteSection + findingsSection();
        attempt = await runAndRecord({ behaviorId: behavior.id, taskText, kind: behavior.kind });
        result.unitsRun++;
        retry++;
        continue;
      }

      // mustRunNow: the unit cannot proceed without the user running a
      // sandbox-blocked command. Pause immediately — no commit attempt, no
      // retry-budget consumption; the behavior stays active for resume.
      const mustRun = attempt.blockedCommands?.find((entry) => entry.mustRunNow);
      if (mustRun) {
        sealLastAttempt("blocked");
        const pendingCommand: PendingCommand = {
          command: mustRun.command,
          ...(mustRun.reason ? { reason: mustRun.reason } : {}),
        };
        return halt(
          behavior.id,
          `Unit ${behavior.id} reported a sandbox-blocked command that must run now: ` +
            `${mustRun.command}${mustRun.reason ? ` (${mustRun.reason})` : ""}. ` +
            `Run it outside the sandbox, then /implement resumes.`,
          pendingCommand,
        );
      }

      // Deferrable entries never block landing: the commit gate runs as
      // usual and the commands are reported to the user at completion.
      for (const entry of attempt.blockedCommands ?? []) {
        result.deferredCommands!.push(entry);
      }
      // The attempt reached the commit gate with a usable report: any
      // no-progress streak from earlier partial attempts is broken.
      noProgressStreak = 0;

      // T11a: the unit reports the behavior is already implemented. With a
      // clean tree and an unchanged HEAD the commit gate would only trip
      // the no-changes verdict — mark the behavior done without a commit
      // and without consuming retries. A dirty tree, an unknown tree
      // state, or a moved HEAD falls through to the normal commit gate.
      if (
        isAlreadySatisfied({
          alreadySatisfied: attempt.alreadySatisfied,
          headBefore: attemptHeadBefore,
          headNow: await readGitHead(pi, cwd),
          treeStatus: await readTreeState(pi, cwd),
        })
      ) {
        sealLastAttempt("landed");
        behavior.status = "done";
        result.satisfiedWithoutCommit.push(behavior.id);
        ctx.ui.setStatus("implement", `✦ ${behavior.id} (${position}): already satisfied`);
        state.lastMarkedHead = (await readGitHead(pi, cwd)) ?? state.lastMarkedHead;
        state.lastHalt = undefined;
        saveState(pi, state);
        updateUi(state, ctx);
        ctx.ui.notify(`${behavior.id} already satisfied at HEAD — no commit needed`, "info");
        break;
      }

      // Manual behaviors pause before commit for human verification (T3).
      // The kept-alive child stays available for mid-pause steering; once
      // the pause closes (approve or HITL timeout), it is shut down and the
      // commit runs. A timeout defers the behavior to pendingManualChecks
      // after the commit lands (T5).
      let pauseOutcome: PauseOutcome | undefined;
      if (behavior.kind === "manual" && attempt.client) {
        pauseOutcome = await openVerificationPause(ctx, behavior);
        await attempt.client.shutdown(2_000);
        if (getActiveUnitClient() === attempt.client) setActiveUnitClient(undefined);
      }

      const subject = pickCommitSubject(attempt, behavior);
      ctx.ui.setStatus("implement", `✦ ${behavior.id} (${position}): committing…`);
      const commit = await commitAndGate(pi, cwd, subject, behavior, task, retry);
      // T8: the commit-gate verdict seals the last attempt's outcome in
      // the halt report's attempt table (landed attempts reset with the
      // next behavior's history).
      if (commit.outcome !== null) sealLastAttempt(commit.outcome.kind);

      if (commit.outcome === null) {
        landedCommits.push(subject);
        behavior.status = "done";
        if (pauseOutcome?.timedOut) {
          const check: PendingManualCheck = {
            behaviorId: behavior.id,
            description: behavior.description,
          };
          state.pendingManualChecks = [...(state.pendingManualChecks ?? []), check];
          result.pendingManualChecks = [...(result.pendingManualChecks ?? []), check];
        }
        ctx.ui.setStatus("implement", `✦ ${behavior.id} (${position}): landed`);
        state.lastMarkedHead = (await readGitHead(pi, cwd)) ?? state.lastMarkedHead;
        state.lastHalt = undefined;
        saveState(pi, state);
        updateUi(state, ctx);
        ctx.ui.notify(`Landed commit for ${behavior.id}: ${subject}`, "info");
        break;
      }

      if (commit.outcome.kind === "test-guard") {
        return halt(
          behavior.id,
          `Staged-diff guard blocked the commit for ${behavior.id} — tests are the specification. ` +
            `If the contract requires updating or removing test paths, re-declare them via ` +
            `/discuss -> /finalize listing those paths in files, then /implement resumes.\n\n` +
            commit.outcome.investigation,
        );
      }

      if (commit.outcome.kind === "commit-timeout") {
        return halt(
          behavior.id,
          `Commit process for ${behavior.id} timed out after ${getCommitTimeoutMs()}ms ` +
            `(PI_COMMIT_TIMEOUT_MS) — infrastructure failure, not a hook verdict. ` +
            `Raise the budget or scope the project's pre-commit hooks.`,
        );
      }

      if (retry > RETRY_BUDGET) {
        const detail =
          commit.outcome.kind === "hook-rejected"
            ? `pre-commit hook rejected the commit for ${behavior.id} after ${RETRY_BUDGET} retries`
            : `no changes detected for ${behavior.id} after ${RETRY_BUDGET} retries`;
        return halt(behavior.id, `${detail}\n\n${commit.outcome.investigation}`);
      }

      ctx.ui.setStatus("implement", `✦ ${behavior.id} (${position}): retry ${retry}/${RETRY_BUDGET}…`);
      taskText = buildFixTask(behavior, task, baseCore, commit.outcome, retry) + findingsSection();
      attempt = await runAndRecord({ behaviorId: behavior.id, taskText, kind: behavior.kind });
      result.unitsRun++;
      retry++;
    }
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

