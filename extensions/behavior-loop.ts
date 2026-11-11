import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { saveState, updateUi, type WorkflowState, type TaskContract, type PendingCommand, type PendingManualCheck, type Behavior } from "./state.ts";
import { buildContinuationTaskText, decideContinuation, isAlreadySatisfied, isPartialAttempt, shouldHaltEarly, buildEarlyHaltError, shouldHaltOnTimeout, buildTimeoutHaltError } from "./unit-progress.ts";
import { crossOwnershipHalt } from "./cross-ownership.ts"; import { blockedHaltText } from "./blocked-unit.ts"; import { splitOrHalt, runSplitChild, type SplitTrigger } from "./split-planner.ts";
import { isIdenticalRejection, buildIdenticalRejectionHalt, type RejectionSnapshot } from "./identical-rejection.ts";
import type { AttemptRecord } from "./halt-report.ts"; import { setTaskStatus } from "./task-status.ts";
import type { UnitTask } from "./implementer-runner.ts";
import { RETRY_BUDGET, buildFixTask, retryExhaustedDetail } from "./commit-gate.ts";
import { relayImplementerEvent } from "./implementer-activity.ts";
import type { PauseOutcome } from "./hitl-pause.ts";
import { isOrchestrationCancelled } from "./orchestration-cancel.ts";
import { getCommitTimeoutMs, isOutOfRepoBehavior, readGitHead, readTreeFingerprint, readTreeState } from "./git-ops.ts";
import { commitAndGate, pickCommitSubject } from "./git-commit-gate.ts";
import { resolveSlopGate } from "./slop-gate.ts";
import { buildRetryTask, buildUnitTask, type UnitTaskOptions } from "./unit-task-text.ts";
import { resolveBehaviorSession, createFixRoundTracker, noteAttemptContext, chooseBehaviorFixSession, type FixTrigger } from "./behavior-sessions.ts";
import { removeBehaviorSessions } from "./unit-session.ts";
import { commitScopeGate } from "./test-gate-run.ts";
import { buildScopeGateFixTask, redGateHaltText, redGateNotifyText } from "./test-gate-report.ts";
import type { UnitRunner, OrchestratorResult } from "./implement-loop.ts";
import type { RpcUnitClient } from "./rpc-unit-client.ts";
import { shutdownWarmChild, createAttemptRecorder, completeAlreadySatisfied, completeLeftUncommitted, runManualVerificationPause } from "./warm-unit.ts";

/** Shared driver state and callbacks handed to runBehaviorLoop for one behavior. */
export interface BehaviorLoopDeps {
  pi: ExtensionAPI;
  ctx: ExtensionContext;
  state: WorkflowState;
  task: TaskContract;
  runUnit: UnitRunner;
  result: OrchestratorResult;
  landedCommits: string[];
  attemptHistory: AttemptRecord[];
  findingsSection: () => string;
  recordFindings: (behaviorId: string, texts: string[] | undefined) => boolean;
  noteSection: string;
  taskPrefix: string;
  haltPrefix: string;
  resumeTreeContext: string;
  halt: (behaviorId: string, error: string, pendingCommand?: PendingCommand) => Promise<OrchestratorResult>;
}

/**
 * Run the unit/retry/commit loop for one active behavior: base attempt, partials,
 * budget-charged retries, the mustRunNow pause, already-satisfied, the commit gate
 * with fix rounds (T6: forked or fresh sessions) and the fresh-spawn fallback.
 * Driver state and behavior.status are mutated in place.
 *
 * @param behavior   - The active behavior to run.
 * @param unitIndex  - 0-based position among the active units (UI progress).
 * @param totalUnits - Number of active units (UI progress).
 * @param deps       - Shared driver state, per-behavior prefixes, and the halt callback.
 * @returns The halted orchestrator result, or undefined when the behavior completed.
 */
export async function runBehaviorLoop(behavior: Behavior, unitIndex: number, totalUnits: number, deps: BehaviorLoopDeps): Promise<OrchestratorResult | undefined> {
  const { pi, ctx, state, task, runUnit, result, landedCommits, attemptHistory, findingsSection, recordFindings, noteSection, taskPrefix, haltPrefix, resumeTreeContext, halt } = deps;
  const cwd = ctx.cwd;
  const slopRunner = await resolveSlopGate(cwd); // T5: once per behavior; undefined when mode is off (e.g. PI_SLOP_GATE=off); gates every commit below.
  // T8: attempt history is per behavior — a landed behavior's history is irrelevant to a later behavior's halt report.
  attemptHistory.length = 0;
  // Progress visibility: announce start and landing so a minutes-long captured-stdio run never looks frozen.
  ctx.ui.notify(`Running unit ${behavior.id} (${unitIndex + 1}/${totalUnits})`, "info");
  const position = `${unitIndex + 1}/${totalUnits}`;
  ctx.ui.setStatus("implement", `✦ ${behavior.id} (${position}): implementing…`); // B3: the "workflow" key from state.ts updateUi is never written by these frames.
  // T5: with a v2 contract (state.contractV2) the unit text is the unit's slice only.
  const unitOptions: UnitTaskOptions = { contract: state.contractV2, preloadCwd: cwd, testTool: state.testTool };
  const baseUnitTask = buildUnitTask(behavior, task, unitOptions);
  const baseCore = taskPrefix + baseUnitTask + noteSection + resumeTreeContext;
  // T3: every spawn of this behavior resumes the same session transcript
  // (<behaviorId>-<baselineHead first 8>); the base attempt carries it too.
  const resume = resolveBehaviorSession(cwd, behavior.id, state.baselineHead);
  /** True when the behavior's transcript is on disk — the base attempt's spawn
   * creates it, so follow-ups see it and drop the base task text. */
  const transcriptExists = () => resolveBehaviorSession(cwd, behavior.id, state.baselineHead).exists;
  /** Base task text for a follow-up: empty when the transcript already holds it. */
  const followUpBaseCore = () => (transcriptExists() ? "" : baseCore);
  /** Strip the embedded base task from a retry text when the transcript holds it. */
  const stripRetryBase = (text: string): string =>
    transcriptExists() ? text.replace(`\n\n## Original task\n${baseUnitTask}`, "") : text;
  const baseTask: UnitTask = { behaviorId: behavior.id, taskText: haltPrefix + baseCore + findingsSection(), kind: behavior.kind, session: resume.session };

  const relay = (event: Record<string, unknown>) => relayImplementerEvent(pi, ctx, behavior.id, position, event);
  let liveChild: RpcUnitClient | undefined;
  const fixTracker = createFixRoundTracker(); // T6: latest attempt contextPercent + fix index.
  const haltWithChild = async (behaviorId: string, error: string, pendingCommand?: PendingCommand) => {
    await shutdownWarmChild(liveChild); liveChild = undefined;
    return halt(behaviorId, error, pendingCommand);
  };
  // T8/T6: the recorder fingerprints the tree before every round, records findings, classifies outcomes, keeps history.
  const recorder = createAttemptRecorder({
    behaviorId: behavior.id, cwd, runUnit, relay, recordFindings,
    fingerprint: () => readTreeFingerprint(pi, cwd),
    head: () => readGitHead(pi, cwd),
    history: attemptHistory,
  });
  let attemptProgress = false; let attemptHeadBefore: string | null = null; let timeoutStreak = 0; // T11a: HEAD before the last round, compared with HEAD after it (the flag alone never skips the commit gate). T5: consecutive timed-out attempts (reset by any non-timeout attempt), counted in adoptRound.
  const adoptRound = () => {
    attemptProgress = recorder.progress(); attemptHeadBefore = recorder.headBefore();
    timeoutStreak = attempt.timedOut ? timeoutStreak + 1 : 0; // T5: any non-timeout attempt resets the consecutive-timeout count.
    noteAttemptContext(fixTracker, attempt.contextPercent); // T6: the latest attempt's context usage feeds the next fix-round session choice.
  };
  let attempt = await recorder.runFresh(baseTask);
  liveChild = attempt.client;
  adoptRound(); result.unitsRun++;
  let continuations = 0; // T6: per-behavior continuations, bounded and never charged to RETRY_BUDGET.
  let retry = 1; let previousRejection: RejectionSnapshot | undefined; // T4: last hook-rejected round, compared for an identical repeat.
  let noProgressStreak = 0; // T7: consecutive timed-out/partial attempts that neither moved the tree fingerprint nor added findings; two in a row halt the behavior early.

  /** Run one fresh follow-up attempt (continuation or retry) with the given task text.
   * `thinking` is the retry escalation floor (medium/high); continuations pass none. */
  const runFollowUp = async (taskText: string, thinking?: string, session = resume.session) => {
    await shutdownWarmChild(liveChild); liveChild = undefined; // never leak a stale kept-alive child across fresh spawns
    attempt = await recorder.runFresh({ behaviorId: behavior.id, taskText, kind: behavior.kind, session, ...(thinking ? { thinking } : {}) });
    liveChild = attempt.client; adoptRound(); result.unitsRun++;
  };
  const runRetry = async (taskText: string) => {
    // T2: escalate thinking across retry spawns (fresh spawns only).
    ctx.ui.setStatus("implement", `✦ ${behavior.id} (${position}): retry ${retry}/${RETRY_BUDGET}…`); await runFollowUp(taskText, attempt.timedOut ? undefined : retry === 1 ? "medium" : "high"); retry++; // T14: timeouts never escalate thinking
  };
  /** One fix-forward round (T6): fresh spawn on the chosen session (fork or fresh), never a warm steer.
   * @returns undefined (the fresh spawn carries the attempt). */
  const runFixRound = async (taskText: string, trigger: FixTrigger): Promise<undefined> => {
    const plan = chooseBehaviorFixSession(fixTracker, resume.session, trigger);
    await runFollowUp(taskText, undefined, { dir: resume.session.dir, ...plan });
    return undefined;
  };
  const trySplit = async (trigger: SplitTrigger, haltText: string) => { await shutdownWarmChild(liveChild); liveChild = undefined; return splitOrHalt({ pi, ctx, state, behaviorId: behavior.id, trigger }, haltText, { halt: (text) => halt(behavior.id, text), runChild: (id) => runSplitChild(state, id, (c, t) => runBehaviorLoop(c, unitIndex, totalUnits, { ...deps, task: t }), () => saveState(pi, state)) }); }; // T24: runtime split; children, vetoes and rejections halt
  while (retry <= RETRY_BUDGET + 1) {
    // B2: cancellation checkpoint (top of loop) — /discuss cancelled the run while the unit attempt was in flight. Kill-induced child errors after the cancel surface here as attempts with an error; return immediately instead of retrying. No saveState, no lastHalt, no commit.
    if (isOrchestrationCancelled()) {
      result.cancelled = true; ctx.ui.setStatus("implement", undefined);
      return result;
    }
    const blockedText = blockedHaltText(behavior.id, attempt); if (blockedText) { recorder.sealLast("unit-blocked"); if (attempt.blockedReason === "too-large") { const r = await trySplit("too-large", blockedText); if (r) return r; behavior.status = "done"; setTaskStatus(state, behavior.id, "done"); return undefined; } return haltWithChild(behavior.id, blockedText); } // T12: blocked halts at once — no retry, no continuation.
    // T6: partial reports and timed-out attempts never reach the commit gate — their work stays uncommitted for a continuation unit.
    if (!attempt.missingReport && isPartialAttempt(attempt)) {
      const progressed = attemptProgress;
      if (progressed) {
        noProgressStreak = 0;
      } else if (shouldHaltEarly(++noProgressStreak)) {
        // T7: repeated identical timeouts/partial reports waste hours — halt with an actionable diagnosis instead of burning retries.
        return haltWithChild(behavior.id, buildEarlyHaltError(behavior.id, noProgressStreak));
      }
      if (decideContinuation({ progressed, continuations }) === "continue") {
        continuations++;
        ctx.ui.setStatus("implement", `✦ ${behavior.id} (${position}): continuing partial work…`);
        await runFollowUp(buildContinuationTaskText(behavior.id, attempt, followUpBaseCore(), await readTreeState(pi, cwd)) + noteSection + findingsSection());
        continue;
      }
      if (shouldHaltOnTimeout(timeoutStreak)) { const r = await trySplit("timeout", buildTimeoutHaltError(behavior.id, timeoutStreak)); if (r) return r; behavior.status = "done"; setTaskStatus(state, behavior.id, "done"); return undefined; } // T8/T5: checked only after continuations are exhausted — a progressing timeout resumes meanwhile; the no-progress early halt above keeps precedence and its message.
      if (!attempt.error) {
        // A partial report without progress consumes one retry as today.
        if (retry > RETRY_BUDGET) {
          return haltWithChild(behavior.id,
            `Unit ${behavior.id} reported partial work after ${RETRY_BUDGET} retries without advancing the tree or adding findings: ${attempt.summary ?? "no summary"}`);
        }
        await runRetry(stripRetryBase(buildRetryTask(behavior, task, attempt, retry, unitOptions)) + noteSection + findingsSection());
        continue;
      }
      // Timed out without progress (or beyond the continuation budget): fall through to the unchanged timeout-retry path below.
    }

    if (attempt.error) {
      // A plain unit error (no partial report, no timeout) breaks any no-progress streak: only timed-out/partial attempts count toward the early halt.
      if (!isPartialAttempt(attempt)) noProgressStreak = 0;
      if (retry > RETRY_BUDGET) {
        return haltWithChild(behavior.id, `Unit ${behavior.id} failed after ${RETRY_BUDGET} retries: ${attempt.error}`);
      }
      await runRetry(stripRetryBase(buildRetryTask(behavior, task, attempt, retry, unitOptions)) + noteSection + findingsSection());
      continue;
    }

    // mustRunNow: the unit cannot proceed without the user running a sandbox-blocked command. Pause immediately — no commit attempt, no retry-budget consumption; the behavior stays active for resume.
    const mustRun = attempt.blockedCommands?.find((entry) => entry.mustRunNow);
    if (mustRun) {
      recorder.sealLast("blocked");
      const pendingCommand: PendingCommand = { command: mustRun.command, ...(mustRun.reason ? { reason: mustRun.reason } : {}) };
      return haltWithChild(behavior.id,
        `Unit ${behavior.id} reported a sandbox-blocked command that must run now: ${mustRun.command}${mustRun.reason ? ` (${mustRun.reason})` : ""}. Run it outside the sandbox, then /implement resumes.`,
        pendingCommand);
    }

    // Deferrable entries never block landing: the commit gate runs as usual and the commands are reported to the user at completion.
    for (const entry of attempt.blockedCommands ?? []) result.deferredCommands!.push(entry);
    // The attempt reached the commit gate with a usable report: any no-progress streak from earlier partial attempts is broken.
    noProgressStreak = 0;

    // T11a: the unit reports the behavior is already implemented. With a clean tree and an unchanged HEAD the commit gate would only trip the no-changes verdict — mark the behavior done without a commit and without consuming retries. A dirty tree, an unknown tree state, or a moved HEAD falls through to the normal commit gate. completeAlreadySatisfied shuts the kept-alive child down (T5).
    if (isAlreadySatisfied({ alreadySatisfied: attempt.alreadySatisfied, headBefore: attemptHeadBefore, headNow: await readGitHead(pi, cwd), treeStatus: await readTreeState(pi, cwd) })) {
      recorder.sealLast("landed");
      await completeAlreadySatisfied({ pi, ctx, state, behavior, result, position, client: liveChild }); liveChild = undefined;
      removeBehaviorSessions(resume.session.dir, resume.session.id); // T4: landed — drop the behavior's transcripts (halt paths keep them for resume).
      break;
    }

    // Out-of-repo behaviors (sourceFile resolves outside cwd) are inferred never-commit: no manual pause, no git add/commit — the commit gate would reject them as no-changes forever. The unit report is the verification. Placed after the alreadySatisfied short-circuit so that keeps precedence; unit errors/partials above still retry as usual.
    if (isOutOfRepoBehavior(behavior, cwd)) {
      recorder.sealLast("landed");
      await completeLeftUncommitted({ pi, ctx, state, behavior, result, position, client: liveChild }); liveChild = undefined;
      removeBehaviorSessions(resume.session.dir, resume.session.id); // T4: landed without a commit — transcripts are no longer resumable state.
      break;
    }

    // Manual behaviors pause before commit for human verification (T3). The kept-alive child stays available for mid-pause steering; once the pause closes (approve or HITL timeout), runManualVerificationPause shuts it down and the commit runs. A timeout defers the behavior to pendingManualChecks after the commit lands (T5).
    let pauseOutcome: PauseOutcome | undefined;
    if (behavior.kind === "manual" && liveChild) {
      pauseOutcome = await runManualVerificationPause(ctx, behavior, liveChild);
      liveChild = undefined;
      // B2: cancellation checkpoint (post-pause) — cancelOrchestration settled the pause with cancelled:true and owns the child shutdown via cleanupOrchestration. Return before the commit gate; no state writes after the discussing transition.
      if (isOrchestrationCancelled() || pauseOutcome.cancelled) {
        result.cancelled = true; ctx.ui.setStatus("implement", undefined);
        return result;
      }
    }

    const subject = pickCommitSubject(attempt, behavior, state.contractV2);
    ctx.ui.setStatus("implement", `✦ ${behavior.id} (${position}): committing…`);
    const commit = await commitAndGate(pi, cwd, subject, behavior, task, retry, state.baselineHead, state.contractV2, slopRunner);
    // T8: the commit-gate verdict seals the last attempt's outcome in the halt report's attempt table (landed attempts reset with the next behavior's history).
    if (commit.outcome !== null) recorder.sealLast(commit.outcome.kind);
    // T6: cross-task contamination auto-unstaged at commit — the remediation note (path + owning task) joins the attempt report via the shared findings ledger.
    if (commit.remediation?.length) recordFindings(behavior.id, commit.remediation);
    if (commit.slopNotes?.length) recordFindings(behavior.id, commit.slopNotes); // T5: advisory slop notes join the shared findings ledger

    if (commit.outcome === null) {
      // T8: per-task SCOPE GATE — the orchestrator itself runs every filterable suite with the
      // task's derived packages scope plus every non-filterable suite, unfiltered, outside the
      // unit's tool call; a red gate keeps the task open and steers fix-forward via the retry path.
      const gate = await commitScopeGate(pi, cwd, state, behavior.id);
      if (gate && !gate.passed) {
        landedCommits.push(subject); // the commit landed; only the gate is red
        if (retry > RETRY_BUDGET) return haltWithChild(behavior.id, redGateHaltText(gate));
        ctx.ui.notify(redGateNotifyText(gate, retry), "warning");
        ctx.ui.setStatus("implement", `✦ ${behavior.id} (${position}): scope-gate fix ${retry}/${RETRY_BUDGET}…`);
        await runFixRound(buildScopeGateFixTask(gate, retry, baseCore) + noteSection + findingsSection(), "scope-gate");
        retry++;
        continue;
      }
      await shutdownWarmChild(liveChild); liveChild = undefined; // T5: landing ends the behavior — no live child survives it
      landedCommits.push(subject);
      behavior.status = "done"; setTaskStatus(state, behavior.id, "done");
      if (pauseOutcome?.timedOut) {
        const check: PendingManualCheck = { behaviorId: behavior.id, description: behavior.description };
        state.pendingManualChecks = [...(state.pendingManualChecks ?? []), check];
        result.pendingManualChecks = [...(result.pendingManualChecks ?? []), check];
      }
      removeBehaviorSessions(resume.session.dir, resume.session.id); // T4: commit landed — implementation + fix sessions are finished state.
      ctx.ui.setStatus("implement", `✦ ${behavior.id} (${position}): landed`);
      state.lastMarkedHead = (await readGitHead(pi, cwd)) ?? state.lastMarkedHead;
      state.lastHalt = undefined;
      saveState(pi, state);
      updateUi(state, ctx);
      ctx.ui.notify(
        `Landed commit for ${behavior.id}: ${subject}` +
          (commit.remediation?.length
            ? ` — ${commit.remediation.length} cross-task path(s) auto-unstaged (work kept on disk)`
            : ""),
        "info",
      );
      break;
    }

    if (commit.outcome.kind === "contract-guard") {
      return haltWithChild(behavior.id,
        `Staged diff for ${behavior.id} violates the contract's file allowlist — the declared files are authoritative. ` +
          `Fix the change to match the declarations, or re-declare the affected paths via /discuss -> /finalize with A/M/D status, then /implement resumes.\n\n` + commit.outcome.investigation);
    }

    if (commit.outcome.kind === "test-guard") {
      return haltWithChild(behavior.id,
        `Staged-diff guard blocked the commit for ${behavior.id} — tests are the specification. If the contract ` +
          `requires updating or removing test paths, re-declare them via /discuss -> /finalize listing those paths in files, then /implement resumes.\n\n` + commit.outcome.investigation);
    }

    if (commit.outcome.kind === "commit-timeout") {
      return haltWithChild(behavior.id,
        `Commit process for ${behavior.id} timed out after ${getCommitTimeoutMs()}ms (PI_COMMIT_TIMEOUT_MS) — infrastructure failure, not a hook verdict. Raise the budget or scope the project's pre-commit hooks.`);
    }

    if (commit.outcome.kind === "hook-rejected") { // T1: scan only the raw hook evidence (never the investigation), verify named foreign paths against the true index — a staged foreign path halts now, no fix-forward round, no retry charge.
      const crossBlock = await crossOwnershipHalt(pi, cwd, commit.outcome.hookOutput, state.contractV2, behavior.id);
      if (crossBlock) return haltWithChild(behavior.id, crossBlock);
      const currentRejection: RejectionSnapshot = { hookOutput: commit.outcome.hookOutput, treeFingerprint: await readTreeFingerprint(pi, cwd) }; // T4: identity of this rejected round.
      if (isIdenticalRejection(previousRejection, currentRejection)) return haltWithChild(behavior.id, buildIdenticalRejectionHalt(behavior.id) + "\n\n" + commit.outcome.investigation);
      previousRejection = currentRejection;
    }

    if (retry > RETRY_BUDGET) return haltWithChild(behavior.id, `${retryExhaustedDetail(commit.outcome.kind, behavior.id)}\n\n${commit.outcome.investigation}`);

    const fixText = buildFixTask(behavior, task, baseCore, commit.outcome, retry) + findingsSection();
    ctx.ui.setStatus("implement", `✦ ${behavior.id} (${position}): retry ${retry}/${RETRY_BUDGET}…`);
    await runFixRound(fixText, commit.outcome.kind);
    retry++;
  }
  return undefined;
}
