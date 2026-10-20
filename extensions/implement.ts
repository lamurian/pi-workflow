import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { loadContent, renderTemplate } from "./utils.ts";
import {
  loadState,
  transitionTo,
  updateUi,
  saveState,
  type WorkflowState,
  type TaskContract,
  type LastHalt,
} from "./state.ts";
import { renderTaskContract } from "./task-contract.ts";
import {
  runOrchestratedImplement,
  type OrchestratorResult,
  type UnitRunner,
} from "./implement-loop.ts";
import { buildEngineerNoteSection, setUnitPrompt } from "./unit-task-text.ts";
import { readGitHead } from "./git-ops.ts";
import { cleanupOrchestration } from "./hitl-pause.ts";
import { composeCompletionReport, composeHaltReport } from "./implement-report.ts";

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

/**
 * Module-level in-flight guard for the orchestrated /implement path.
 *
 * Fire-and-forget removed the accidental re-entry protection (the blocked
 * turn used to prevent a second slash command), so this explicit flag
 * refuses a second /implement while a background orchestration is running.
 */
let orchestrationInFlight = false;

/** Pinned refusal warning emitted while a background run holds the guard. */
const IN_FLIGHT_WARNING =
  "An orchestrated implementation is already in flight. " +
  "Wait for it to settle (watch status/notifications), then re-run /implement to resume.";

/**
 * Detect whether the `commit_changes` tool is registered in this session.
 *
 * @param pi - ExtensionAPI reference.
 * @returns True when a tool named `commit_changes` is registered.
 */
export function hasCommitTool(pi: ExtensionAPI): boolean {
  return pi.getAllTools().some((t) => t.name === "commit_changes");
}

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
  if (orchestrationInFlight) {
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
  const resuming = state.phase === "implementing";
  if (!resuming) {
    transitionTo(pi, state, "implementing");
  }
  // Resume keeps the original baseline so the soft-warn still spans the
  // whole implementation, not just the current /implement invocation.
  state.baselineHead =
    state.baselineHead ?? ((await readGitHead(pi, ctx.cwd)) ?? undefined);
  saveState(pi, state);
  updateUi(state, ctx);
  const { solo, note } = parseImplementArgs(args);
  // Persist the engineer's note: a new note replaces the persisted one, a
  // resume without args reuses it (state.ts serializes the whole object).
  if (note) {
    state.engineerNote = note;
    saveState(pi, state);
  }

  // Cache the implementer unit prompt once per /implement so the orchestrator
  // default runner can build subprocess argv without re-reading the file.
  setUnitPrompt(await loadContent("unit-prompt.md"));

  if (solo) {
    await runSoloImplement(note, pi, ctx, task);
    return;
  }

  // Fire-and-forget: launch the loop as a background task so this handler
  // returns immediately (the RPC prompt response must beat the client's
  // deadline). The catch-to-lastHalt logic stays inside the background task.
  const activeCount = task.behaviors.filter((b) => b.status === "active").length;
  orchestrationInFlight = true;
  const settled = runOrchestratedImplementSafely(
    pi,
    ctx,
    state,
    task,
    runUnit,
    note || state.engineerNote,
  )
    .then((result) => {
      if (result.complete) {
        ctx.ui.notify(
          `Orchestrated implementation complete: ${result.landedCommits.length} behavior(s), ` +
            `${result.unitsRun} unit(s) run.`,
          "info",
        );
        // B4: the loop has already set state.phase to idle and persisted it
        // before returning; deliver the pinned completion report as an agent
        // turn (explore pattern) so the outcome renders in RPC clients.
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
      // B5: the halt notification and lastHalt persistence already happened;
      // additionally deliver the pinned halt report as an agent turn (explore
      // pattern) so the outcome renders in RPC clients. state.phase stays
      // implementing, so a later /implement resumes.
      pi.sendUserMessage(composeHaltReport(result), { deliverAs: "steer" });
      return result;
    })
    .finally(() => {
      // Cleared when the background task settles (complete, halt, or crash)
      // so a later /implement resumes normally.
      orchestrationInFlight = false;
    });
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
 * @returns Loop outcome; error details when an exception was caught.
 */
async function runOrchestratedImplementSafely(
  pi: ExtensionAPI,
  ctx: ExtensionContext,
  state: WorkflowState,
  task: TaskContract,
  runUnit?: UnitRunner,
  engineerNote?: string,
): Promise<Awaited<ReturnType<typeof runOrchestratedImplement>>> {
  try {
    return await runOrchestratedImplement(pi, ctx, state, task, runUnit, engineerNote);
  } catch (err) {
    // Crash path (T6): never leave an orphaned child or a stale pause.
    await cleanupOrchestration();
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
    // No separate toast: runImplement's halt handoff already surfaces
    // haltedOn/error plus the lastHalt persistence note and resume guidance.
    return {
      complete: false,
      unitsRun: 0,
      landedCommits: [],
      haltedOn: lastHalt.behaviorId,
      error: lastHalt.error,
    };
  }
}

/**
 * In-session TDD loop (`--solo`): steer the agent with the TDD prompt.
 *
 * @param note  - Optional engineer's note appended to the prompt.
 * @param pi    - ExtensionAPI reference.
 * @param ctx   - Extension context.
 * @param task  - The task contract.
 */
async function runSoloImplement(
  note: string,
  pi: ExtensionAPI,
  ctx: ExtensionContext,
  task: TaskContract,
): Promise<void> {
  let prompt = await buildTddPrompt(task, hasCommitTool(pi));
  if (note) {
    prompt += buildEngineerNoteSection(note);
  }
  ctx.ui.notify(
    "Starting TDD implementation. I'll work through the contract behavior by behavior.",
    "info",
  );
  pi.sendUserMessage(prompt, { deliverAs: "steer" });
}

/**
 * Build the TDD prompt from the task contract.
 *
 * @param task - The task contract.
 * @returns The rendered TDD prompt string.
 */
export async function buildTddPrompt(
  task: TaskContract,
  hasCommitTool = false,
): Promise<string> {
  const template = await loadContent("tdd-prompt.md");
  const commitInstruction = hasCommitTool
    ? "\n## Commits\n\n" +
      "After each `mark_task_done`, call `commit_changes` with a conventional commit subject line " +
      "(`type(scope): description`, ≤75 chars) that describes what the behavior changed. " +
      "Do NOT include the behavior id in the subject.\n"
    : "";
  return renderTemplate(template, {
    task: renderTaskContract(task),
    commitInstruction,
  });
}
