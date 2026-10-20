import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { saveState, updateUi, type WorkflowState, type TaskContract, type PendingCommand, type PendingManualCheck, type Behavior } from "./state.ts";
import { createToolCallCollector, renderToolCallDigest } from "./findings-ledger.ts";
import { buildContinuationTaskText, classifyProgress, decideContinuation, isAlreadySatisfied, isPartialAttempt, shouldHaltEarly, buildEarlyHaltError } from "./unit-progress.ts";
import { classifyAttemptOutcome, truncateAttemptText, type AttemptOutcome, type AttemptRecord } from "./halt-report.ts";
import { getActiveUnitClient, setActiveUnitClient, type UnitTask } from "./implementer-runner.ts";
import { RETRY_BUDGET, buildFixTask } from "./commit-gate.ts";
import { relayImplementerEvent } from "./implementer-activity.ts";
import { openVerificationPause, type PauseOutcome } from "./hitl-pause.ts";
import { commitAndGate, getCommitTimeoutMs, pickCommitSubject, readGitHead, readTreeFingerprint, readTreeState } from "./git-ops.ts";
import { buildRetryTask, buildUnitTask } from "./unit-task-text.ts";
import type { UnitAttempt, UnitRunner, OrchestratorResult } from "./implement-loop.ts";

// ─── Per-behavior loop ─────────────────────────────────────────────────────────

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
 * Run the unit/retry/commit loop for one active behavior: base attempt, partial
 * continuations, budget-charged retries, the mustRunNow pause, the
 * already-satisfied short-circuit, and the commit gate with fix subagents.
 * Shared driver state (result, attemptHistory, landedCommits, workflow state)
 * is mutated in place; behavior.status flips to "done" on landing or
 * already-satisfied. The driver captures resume-context prefixes per behavior
 * and passes them via deps.
 *
 * @param behavior   - The active behavior to run.
 * @param unitIndex  - 0-based position among the active units (UI progress).
 * @param totalUnits - Number of active units (UI progress).
 * @param deps       - Shared driver state, per-behavior prefixes, and the halt callback.
 * @returns The halted orchestrator result, or undefined when the behavior completed.
 */
export async function runBehaviorLoop(
  behavior: Behavior,
  unitIndex: number,
  totalUnits: number,
  deps: BehaviorLoopDeps,
): Promise<OrchestratorResult | undefined> {
  const { pi, ctx, state, task, runUnit, result, landedCommits, attemptHistory, findingsSection, recordFindings } = deps;
  const { noteSection, taskPrefix, haltPrefix, resumeTreeContext, halt } = deps;
  const cwd = ctx.cwd;
  // T8: attempt history is per behavior — a landed behavior's history is irrelevant to a later behavior's halt report.
  attemptHistory.length = 0;
  // Progress visibility: a unit subprocess can run for minutes with captured stdio — announce start and landing so a healthy run never looks frozen.
  ctx.ui.notify(`Running unit ${behavior.id} (${unitIndex + 1}/${totalUnits})`, "info");
  // B3: live footer status under the distinct "implement" key; the "workflow" key from state.ts updateUi is never written by these frames.
  const position = `${unitIndex + 1}/${totalUnits}`;
  ctx.ui.setStatus("implement", `✦ ${behavior.id} (${position}): implementing…`);
  const baseCore = taskPrefix + buildUnitTask(behavior, task) + noteSection + resumeTreeContext;
  const baseTask: UnitTask = {
    behaviorId: behavior.id,
    taskText: haltPrefix + baseCore + findingsSection(),
    kind: behavior.kind,
  };

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
  // T11a: HEAD before this attempt, compared with HEAD after it for the already-satisfied check (the flag alone never skips the commit gate).
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
    // T8: classify and record the finished attempt. Timed-out/partial attempts additionally compute their progress flag here; the partial branch reuses it instead of re-fingerprinting the tree.
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
  // T6: continuation units per behavior, bounded and never charged to the retry budget; reset per behavior.
  let continuations = 0;
  let retry = 1;
  // T7: consecutive timed-out/partial attempts that neither moved the tree fingerprint nor added findings; two in a row halt the behavior early.
  let noProgressStreak = 0;

  /** Run one follow-up attempt (continuation or retry) with the given task text. */
  const runFollowUp = async (taskText: string) => {
    attempt = await runAndRecord({ behaviorId: behavior.id, taskText, kind: behavior.kind });
    result.unitsRun++;
  };
  /** Run one budget-charged retry attempt (status, run, count) with the given task text. */
  const runRetry = async (taskText: string) => {
    ctx.ui.setStatus("implement", `✦ ${behavior.id} (${position}): retry ${retry}/${RETRY_BUDGET}…`);
    await runFollowUp(taskText);
    retry++;
  };

  while (retry <= RETRY_BUDGET + 1) {
    // T6: partial reports and timed-out attempts never reach the commit gate — their work stays uncommitted for a continuation unit.
    if (!attempt.missingReport && isPartialAttempt(attempt)) {
      const progressed = attemptProgress;
      if (progressed) {
        noProgressStreak = 0;
      } else if (shouldHaltEarly(++noProgressStreak)) {
        // T7: repeated identical timeouts/partial reports waste hours — halt with an actionable diagnosis instead of burning retries.
        return halt(behavior.id, buildEarlyHaltError(behavior.id, noProgressStreak));
      }
      if (decideContinuation({ progressed, continuations }) === "continue") {
        continuations++;
        ctx.ui.setStatus("implement", `✦ ${behavior.id} (${position}): continuing partial work…`);
        await runFollowUp(buildContinuationTaskText(behavior.id, attempt, baseCore, await readTreeState(pi, cwd)) + noteSection + findingsSection());
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
        await runRetry(buildRetryTask(behavior, task, attempt, retry) + noteSection + findingsSection());
        continue;
      }
      // Timed out without progress (or beyond the continuation budget): fall through to the unchanged timeout-retry path below.
    }

    if (attempt.error) {
      // A plain unit error (no partial report, no timeout) breaks any no-progress streak: only timed-out/partial attempts count toward the early halt.
      if (!isPartialAttempt(attempt)) noProgressStreak = 0;
      if (retry > RETRY_BUDGET) {
        return halt(behavior.id, `Unit ${behavior.id} failed after ${RETRY_BUDGET} retries: ${attempt.error}`);
      }
      await runRetry(buildRetryTask(behavior, task, attempt, retry) + noteSection + findingsSection());
      continue;
    }

    // mustRunNow: the unit cannot proceed without the user running a sandbox-blocked command. Pause immediately — no commit attempt, no retry-budget consumption; the behavior stays active for resume.
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

    // Deferrable entries never block landing: the commit gate runs as usual and the commands are reported to the user at completion.
    for (const entry of attempt.blockedCommands ?? []) {
      result.deferredCommands!.push(entry);
    }
    // The attempt reached the commit gate with a usable report: any no-progress streak from earlier partial attempts is broken.
    noProgressStreak = 0;

    // T11a: the unit reports the behavior is already implemented. With a clean tree and an unchanged HEAD the commit gate would only trip the no-changes verdict — mark the behavior done without a commit and without consuming retries. A dirty tree, an unknown tree state, or a moved HEAD falls through to the normal commit gate.
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

    // Manual behaviors pause before commit for human verification (T3). The kept-alive child stays available for mid-pause steering; once the pause closes (approve or HITL timeout), it is shut down and the commit runs. A timeout defers the behavior to pendingManualChecks after the commit lands (T5).
    let pauseOutcome: PauseOutcome | undefined;
    if (behavior.kind === "manual" && attempt.client) {
      pauseOutcome = await openVerificationPause(ctx, behavior);
      await attempt.client.shutdown(2_000);
      if (getActiveUnitClient() === attempt.client) setActiveUnitClient(undefined);
    }

    const subject = pickCommitSubject(attempt, behavior);
    ctx.ui.setStatus("implement", `✦ ${behavior.id} (${position}): committing…`);
    const commit = await commitAndGate(pi, cwd, subject, behavior, task, retry);
    // T8: the commit-gate verdict seals the last attempt's outcome in the halt report's attempt table (landed attempts reset with the next behavior's history).
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

    await runRetry(buildFixTask(behavior, task, baseCore, commit.outcome, retry) + findingsSection());
  }
  return undefined;
}
