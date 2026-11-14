/**
 * Pre-launch orchestration preparation and the exception-safe loop wrapper.
 *
 * Extracted from implement.ts (T10) to restore the 250-line module budget:
 * prepareOrchestrationLaunch holds the T7 cancel-and-takeover and T8 lock
 * classification blocks that run between preflight and transitionTo;
 * runOrchestratedImplementSafely wraps the background loop with baseline
 * capture, the T9(a) cancellation checkpoint and the crash path.
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
  saveState,
  updateUi,
  type WorkflowState,
  type TaskContract,
  type LastHalt,
} from "./state.ts";
import { runOrchestratedImplement, type UnitRunner } from "./implement-loop.ts";
import { captureBaselineFailures } from "./baseline-failures.ts";
import { cleanupOrchestration } from "./hitl-pause.ts";
import { isOrchestrationCancelled, CANCEL_AWAIT_TIMEOUT_MS } from "./orchestration-cancel.ts";
import {
  peekOrchestrationClaim,
  readOrchestrationLock,
  classifyOrchestrationLock,
  releaseOrchestration,
} from "./orchestration-lock.ts";

/**
 * Run the pre-transition orchestration preparation for a /implement launch.
 *
 * Runs after preflight and before transitionTo, so a refusal never advances
 * the phase. Two steps, in order:
 *
 * Cancel-and-takeover (T7): the caller's in-flight guard keeps precedence,
 * so this only ever sees an orphaned claim from a previous runtime. An
 * occupied orchestration claim (an orphan left by a previous runtime) is
 * announced with its id and age, cancelled through its stored closure, and
 * awaited boundedly (CANCEL_AWAIT_TIMEOUT_MS) before the launch proceeds,
 * for both normal and `--solo` runs. PI_ORCHESTRATION_LOCK=off disables the
 * whole mechanism (no claim taken or peeked, no lock file read or written).
 *
 * T8 lock classification: only after the takeover (so a lock left by
 * takeover is ours to overwrite) and only when no registry claim was
 * occupied, a leftover lock file is classified: a fresh heartbeat owned by
 * another live pid refuses the launch with a warning naming the
 * orchestration's age in minutes (state untouched); a stale lock is cleared
 * via its stored id with an age notification and the launch continues; an
 * absent lock continues.
 *
 * @param ctx - Extension context (cwd, UI notifications).
 * @returns False when the live-lock refusal fired (the caller returns
 *   without transitioning); true when the launch may proceed.
 */
export async function prepareOrchestrationLaunch(ctx: ExtensionContext): Promise<boolean> {
  // T7 cancel-and-takeover: the in-flight guard above keeps precedence, so
  // this only ever sees an orphaned claim from a previous runtime. Runs for
  // normal and --solo alike (an orphan must be cancelled either way).
  const orphan = peekOrchestrationClaim();
  if (orphan) {
    const startedAt = readOrchestrationLock(ctx.cwd)?.startedAt ?? Date.now();
    const ageSec = Math.round(Math.max(0, Date.now() - startedAt) / 1000);
    ctx.ui.notify(
      `Cancelling orphaned orchestration ${orphan.id} (age ${ageSec}s) ` +
        `left by a previous runtime before starting a new run.`,
      "warning",
    );
    // Stored cancel closure: sets the orphan's flag, settles its pause and
    // kills its child; then wait boundedly for its settlement so a stuck
    // orphan only delays the launch. Proceed regardless of which side wins:
    // the old chain's id-matched release cannot clobber our later claim and
    // its pre-spawn cancellation checkpoints stop it from spawning.
    await Promise.resolve(orphan.cancel());
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<void>((resolve) => {
      timer = setTimeout(resolve, CANCEL_AWAIT_TIMEOUT_MS);
    });
    try {
      await Promise.race([orphan.settle().then(() => undefined, () => undefined), timeout]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  } else {
    // T8 lock classification: no registry claim was occupied, so a leftover
    // lock file decides the launch — a fresh lock owned by another live pid
    // refuses with the orchestration's age; a stale lock (expired heartbeat,
    // or this pid's lock with no claim) is cleared by its stored id and the
    // launch continues; an absent lock continues. Runs after the takeover
    // above and before transitionTo, so a refusal never advances the phase.
    const lockState = classifyOrchestrationLock(ctx.cwd, false);
    if (lockState.kind === "live") {
      const ageMin = Math.max(1, Math.round(lockState.ageMs / 60_000));
      ctx.ui.notify(
        `Refusing to start: another orchestration (pid ${lockState.pid}) has been ` +
          `running for ${ageMin} minute(s). Wait for it to settle, then re-run /implement.`,
        "warning",
      );
      return false;
    }
    if (lockState.kind === "stale") {
      const ageMin = Math.max(1, Math.round(lockState.ageMs / 60_000));
      ctx.ui.notify(
        `Clearing stale orchestration lock (age ${ageMin} minute(s)) ` +
          `left by a previous run before starting a new one.`,
        "info",
      );
      const storedId = readOrchestrationLock(ctx.cwd)?.id;
      if (storedId !== undefined) releaseOrchestration(ctx.cwd, storedId);
    }
  }
  return true;
}

/**
 * Run the orchestrator loop with exception safety.
 *
 * Any uncaught error is persisted as lastHalt (so it is diagnosable from
 * the session log) and surfaced in a notification instead of killing the
 * /implement turn silently. The phase stays implementing for resume.
 *
 * @param pi           - ExtensionAPI reference.
 * @param ctx          - Extension context.
 * @param state        - Current workflow state.
 * @param task         - The task contract.
 * @param runUnit      - Injectable unit runner.
 * @param engineerNote - Optional engineer's note forwarded to every unit.
 * @param resuming     - True when resuming; skips baseline failure capture.
 * @returns Loop outcome; error details when an exception was caught.
 */
export async function runOrchestratedImplementSafely(
  pi: ExtensionAPI,
  ctx: ExtensionContext,
  state: WorkflowState,
  task: TaskContract,
  runUnit?: UnitRunner,
  engineerNote?: string,
  resuming = false,
): Promise<Awaited<ReturnType<typeof runOrchestratedImplement>>> {
  if (!resuming) {
    try {
      await captureBaselineFailures(pi, ctx.cwd, state, ctx.ui.notify);
    } catch {
      // Capture failure leaves baselineFailures unset; the loop still starts.
    }
    // T9(a): cancellation checkpoint — a cancel observed during baseline
    // capture must return before any unit spawn or lastHalt write; the
    // .then cancelled-check above then suppresses reports/notifications.
    if (isOrchestrationCancelled()) {
      return {
        complete: false,
        cancelled: true,
        unitsRun: 0,
        landedCommits: [],
        satisfiedWithoutCommit: [],
      };
    }
  }
  try {
    return await runOrchestratedImplement(pi, ctx, state, task, runUnit, engineerNote);
  } catch (err) {
    // Crash path (T6): never leave an orphaned child or a stale pause.
    await cleanupOrchestration();
    // B2: a kill-induced crash after cancellation must not persist lastHalt.
    if (isOrchestrationCancelled()) {
      return {
        complete: false,
        unitsRun: 0,
        landedCommits: [],
        satisfiedWithoutCommit: [],
        leftUncommitted: [],
        cancelled: true,
      };
    }
    const message = String((err as Error)?.message ?? err);
    const active = task.behaviors.find((b) => b.status === "active");
    const lastHalt: LastHalt = {
      behaviorId: active?.id ?? "(unknown)",
      error: `orchestrator crashed: ${message}`,
      at: new Date().toISOString(),
    };
    state.lastHalt = lastHalt;
    saveState(pi, state);
    updateUi(state, ctx);
    return {
      complete: false,
      unitsRun: 0,
      landedCommits: [],
      satisfiedWithoutCommit: [],
      haltedOn: lastHalt.behaviorId,
      error: lastHalt.error,
    };
  }
}
