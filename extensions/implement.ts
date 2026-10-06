import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
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
import { evaluateCompletionGate, renderTaskContract } from "./task-contract.ts";
import {
  runOrchestratedImplement,
  setUnitPrompt,
  readGitHead,
  type OrchestratorResult,
  type UnitRunner,
} from "./implement-loop.ts";

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
  const settled = runOrchestratedImplementSafely(pi, ctx, state, task, runUnit).then(
    (result) => {
      if (result.complete) {
        ctx.ui.notify(
          `Orchestrated implementation complete: ${result.landedCommits.length} behavior(s), ` +
            `${result.unitsRun} unit(s) run.`,
          "info",
        );
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
      return result;
    },
  );
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
 * @param pi      - ExtensionAPI reference.
 * @param ctx     - Extension context.
 * @param state   - Current workflow state.
 * @param task    - The task contract.
 * @param runUnit - Injectable unit runner.
 * @returns Loop outcome; error details when an exception was caught.
 */
async function runOrchestratedImplementSafely(
  pi: ExtensionAPI,
  ctx: ExtensionContext,
  state: WorkflowState,
  task: TaskContract,
  runUnit?: UnitRunner,
): Promise<Awaited<ReturnType<typeof runOrchestratedImplement>>> {
  try {
    return await runOrchestratedImplement(pi, ctx, state, task, runUnit);
  } catch (err) {
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
    prompt +=
      `\n\n## Engineer's note\n\n${note}` +
      "\n\nGuidance on top of the authoritative contract. If it implies changes " +
      "beyond the contract, report that and tell the user to run /finalize — " +
      "do not implement beyond the contract.";
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

/**
 * Register the `mark_task_done` AI tool.
 *
 * Marks a single behavior as done after the agent has implemented it and
 * run the tests. Records evidence in the session for the final report.
 *
 * @param pi - ExtensionAPI reference.
 */
export function registerMarkTaskDoneTool(pi: ExtensionAPI): void {
  pi.registerTool({
    name: "mark_task_done",
    label: "Mark Task Done",
    description:
      "Mark one behavior as done after implementing it and running tests. " +
      "Pass the behavior id and a short evidence note.",
    parameters: Type.Object({
      behaviorId: Type.String({ description: "The behavior id, e.g. T1" }),
      evidence: Type.String({ description: "Short note on how it was verified" }),
    }),

    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const state = loadState(ctx);
      if (!state || state.phase !== "implementing") {
        return {
          content: [{ type: "text", text: "mark_task_done requires the implementing phase." }],
          isError: true,
        };
      }
      const task = state.task;
      const behavior = task?.behaviors.find((b) => b.id === params.behaviorId);
      if (!task || !behavior) {
        return {
          content: [
            { type: "text", text: `mark_task_done rejected: behavior not in contract (${params.behaviorId}).` },
          ],
          isError: true,
        };
      }
      if (behavior.status === "removed") {
        return { content: [{ type: "text", text: `mark_task_done rejected: behavior ${params.behaviorId} is removed.` }], isError: true };
      }
      behavior.status = "done";
      // T2 soft-warn: HEAD unchanged since the previous mark (or the
      // /implement baseline) means no commit landed for the last behavior.
      const head = await readGitHead(pi, ctx.cwd);
      let warning = "";
      if (head !== null) {
        const previous = state.lastMarkedHead ?? state.baselineHead;
        if (previous !== undefined && head === previous) {
          warning =
            "\nWarning: no commit detected since the previous behavior — " +
            "consider calling commit_changes.";
        }
        state.lastMarkedHead = head;
      }
      saveState(pi, state);
      updateUi(state, ctx);
      return {
        content: [
          {
            type: "text",
            text: `${params.behaviorId} marked done. Evidence: ${params.evidence}${warning}`,
          },
        ],
      };
    },
  });
}

/**
 * Register the `complete_implementation` AI tool.
 *
 * Ends the implementing phase and returns the workflow to idle. Refuses
 * while any behavior is still active; test outcomes are not consulted
 * (verification is owned by the project's own commit hooks).
 *
 * @param pi - ExtensionAPI reference.
 */
export function registerCompleteImplementationTool(pi: ExtensionAPI): void {
  pi.registerTool({
    name: "complete_implementation",
    label: "Complete Implementation",
    description:
      "Finalize implementation. Ends the implementing phase and returns " +
      "the workflow to idle. Call this ONLY after all behaviors are done. " +
      "Test outcomes are not checked here — the project's commit hooks own verification.",

    parameters: Type.Object({}),

    async execute(_toolCallId, _params, _signal, _onUpdate, ctx) {
      const state = loadState(ctx);
      if (!state || state.phase !== "implementing") {
        return {
          content: [{ type: "text", text: "Not in implementing phase. Nothing to finalize." }],
          isError: true,
        };
      }
      const refusal = evaluateCompletionGate(state);
      if (refusal) {
        return {
          content: [{ type: "text", text: `Cannot complete: ${refusal}.` }],
          isError: true,
        };
      }
      transitionTo(pi, state, "idle");
      updateUi(null, ctx);
      return {
        content: [{ type: "text", text: "## Implementation Complete\n\nThe workflow has returned to idle." }],
      };
    },
  });
}

/**
 * Build a completion report from the workflow state.
 *
 * Test behaviors appear under Test Results. Completed manual behaviors are
 * listed under "Manual verification required" so the engineer can confirm
 * them after the fact; the section is omitted when none completed.
 *
 * @param state - Current workflow state.
 * @returns A markdown report string.
 */
export function generateReport(state: WorkflowState): string {
  const task = state.task;
  const results = state.lastTestResults;
  const lines: string[] = [];
  lines.push("# Implementation Report");
  if (task) {
    lines.push("", `## ${task.title}`, "", renderTaskContract(task));
  }
  lines.push("", "## Test Results");
  lines.push(`- Passed: ${results?.passed ?? 0}`);
  lines.push(`- Failed: ${results?.failed ?? 0}`);
  if (results?.coveragePercent !== undefined) {
    lines.push(`- Coverage: ${results.coveragePercent}%`);
  }

  const completedManual = (task?.behaviors ?? []).filter(
    (b) => b.kind === "manual" && b.status === "done",
  );
  if (completedManual.length > 0) {
    lines.push("", "## Manual verification required");
    for (const b of completedManual) {
      lines.push(`- ${b.id}: ${b.description}`);
    }
  }

  return lines.join("\n");
}
