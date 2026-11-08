import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { loadContent } from "./utils.ts";
import {
  loadState,
  transitionTo,
  updateUi,
  saveState,
  type WorkflowState,
  type TaskContract,
  type LastHalt,
} from "./state.ts";
import {
  runOrchestratedImplement,
  type OrchestratorResult,
  type UnitRunner,
} from "./implement-loop.ts";
import { runSoloImplement } from "./implement-solo.ts";
import { setUnitPrompt } from "./unit-task-text.ts";
import { readGitHead } from "./git-ops.ts";
import { captureBaselineFailures } from "./baseline-failures.ts";
import { preflightImplement } from "./implement-preflight.ts";
import { cleanupOrchestration } from "./hitl-pause.ts";
import { composeCompletionReport, composeHaltReport } from "./implement-report.ts";
import { beginOrchestration, endOrchestration, isOrchestrationCancelled, isOrchestrationInFlight } from "./orchestration-cancel.ts";

// B2: contract-visible cancellation API (state lives in orchestration-cancel.ts).
export { isOrchestrationInFlight, cancelOrchestration } from "./orchestration-cancel.ts";

/**
 * Parse `/implement` arguments into a mode flag and an engineer's note.
 *
 * Recognizes a `--solo` flag anywhere in the args; everything else is
 * treated as the engineer's note appended to the prompt.
 *
 * @param args - Raw argument string from the /implement command.
 * @returns `{ solo, note }` where `solo` selects the in-session loop.
 */
export function parseImplementArgs(args: string): { solo: boolean; note: string } {
  const tokens = args.split(/\s+/).filter(Boolean);
  const solo = tokens.includes("--solo");
  const note = tokens.filter((t) => t !== "--solo").join(" ").trim();
  return { solo, note };
}

/** Pinned refusal warning emitted while a background run holds the guard. */
const IN_FLIGHT_WARNING =
  "An orchestrated implementation is already in flight. " +
  "Wait for it to settle (watch status/notifications), then re-run /implement to resume.";

/**
 * Start the TDD implementation phase from a finalizing task contract.
 *
 * Valid only from the finalizing phase. Consumes state.task and transitions
 * to implementing. By default runs the orchestrator loop; pass `--solo` to
 * hand the agent an in-session TDD prompt instead.
 *
 * The orchestrated loop is fire-and-forget: it launches as a background
 * task, /implement emits a start notification and returns immediately so
 * the RPC prompt response beats the client's control-plane deadline. The
 * completion/halt notifications fire when the background task settles.
 *
 * A module-level guard refuses a second invocation while a background
 * orchestration is in flight: it emits a pinned warning and returns without
 * launching a second loop or touching state. The flag is set at launch and
 * cleared in a finally when the background task settles, so a later
 * /implement resumes normally.
 *
 * @param args        - Optional `--solo` flag plus engineer's note.
 * @param pi          - ExtensionAPI reference.
 * @param ctx         - Extension context.
 * @param runUnit     - Optional unit runner override (tests inject a mock).
 * @param onBackground - Optional seam invoked with the background promise
 *   right after launch (production handlers ignore it; tests capture it to
 *   await settlement deterministically).
 */
export async function runImplement(
  args: string,
  pi: ExtensionAPI,
  ctx: ExtensionContext,
  runUnit?: UnitRunner,
  onBackground?: (settled: Promise<OrchestratorResult>) => void,
): Promise<void> {
  // In-flight guard: refuse re-entry before any state load or mutation.
  if (isOrchestrationInFlight()) {
    ctx.ui.notify(IN_FLIGHT_WARNING, "warning");
    return;
  }
  const state = loadState(ctx);
  if (!state || (state.phase !== "finalizing" && state.phase !== "implementing")) {
    ctx.ui.notify(
      "/implement is only valid after /finalize (or to resume an in-flight implementation). " +
        "Run /discuss then /finalize first.",
      "warning",
    );
    return;
  }
  const task = state.task;
  if (!task) {
    ctx.ui.notify("No task contract found. Run /finalize to create one.", "warning");
    return;
  }
  // Preflight: legacy plain-string files, stale run plan, missing scoped suites.
  const refusal = await preflightImplement(state, ctx.cwd);
  if (refusal) {
    ctx.ui.notify(refusal, "warning");
    return;
  }
  const resuming = state.phase === "implementing";
  if (!resuming) {
    transitionTo(pi, state, "implementing");
  }
  // Resume keeps the original baseline so the soft-warn spans the whole run.
  state.baselineHead = state.baselineHead ?? ((await readGitHead(pi, ctx.cwd)) ?? undefined);
  saveState(pi, state);
  updateUi(state, ctx);
  const { solo, note } = parseImplementArgs(args);
  // Persist the note: a new note replaces the stored one; a bare resume reuses it.
  if (note) {
    state.engineerNote = note;
    saveState(pi, state);
  }

  // Cache the unit prompt once per /implement for the default runner's argv.
  setUnitPrompt(await loadContent("unit-prompt.md"));

  if (solo) {
    await runSoloImplement(note, pi, ctx, task);
    return;
  }

  // Fire-and-forget: launch the loop in the background so this handler returns immediately (RPC deadline).
  const activeCount = task.behaviors.filter((b) => b.status === "active").length;
  const settled = runOrchestratedImplementSafely(
    pi,
    ctx,
    state,
    task,
    runUnit,
    note || state.engineerNote,
    resuming,
  )
    .then((result) => {
      // B2: a cancelled run skips the completion/halt reports and notifications.
      if (result.cancelled || isOrchestrationCancelled()) return result;
      if (result.complete) {
        ctx.ui.notify(
          `Orchestrated implementation complete: ${result.landedCommits.length} behavior(s), ` +
            `${result.unitsRun} unit(s) run.`,
          "info",
        );
        // B4: phase already idle; deliver the completion report as an agent turn for RPC clients.
        pi.sendUserMessage(composeCompletionReport(result, task), { deliverAs: "steer" });
        return result;
      }
      ctx.ui.notify(
        `Orchestration halted on ${result.haltedOn}: ${result.error}\n\n` +
          `Tree state:\n${result.treeState ?? "(unavailable)"}\n\n` +
          `Commits landed so far: ${
            result.landedCommits.length ? result.landedCommits.join("; ") : "(none)"
          }\n\n` +
          `Handoff persisted to session state (lastHalt). ` +
          `Run /implement again to resume from the first active behavior.`,
        "warning",
      );
      // B5: deliver the halt report as an agent turn; phase stays implementing for resume.
      pi.sendUserMessage(composeHaltReport(result), { deliverAs: "steer" });
      return result;
    })
    // Cleared on settle (complete, halt, or crash) so a later /implement resumes.
    .finally(() => endOrchestration());
  beginOrchestration(settled);
  onBackground?.(settled);
  ctx.ui.notify(
    `Orchestration started in background: ${activeCount} unit(s) active. ` +
      `Progress arrives as status + notifications; the final report posts as an agent message when the run settles.`,
    "info",
  );
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
async function runOrchestratedImplementSafely(
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
      await captureBaselineFailures(pi, ctx.cwd, state);
    } catch {
      // Capture failure leaves baselineFailures unset; the loop still starts.
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
