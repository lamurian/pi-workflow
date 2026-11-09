import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { isToolCallEventType } from "@earendil-works/pi-coding-agent";
import { loadState, updateUi } from "./state.ts";
import {
  toggleWidgetVisible,
  resetWidgetVisibility,
} from "./widget-visibility.ts";
import { DISCUSS_BLOCKED_TOOLS } from "./tools.ts";
import { buildPhasePrompt } from "./prompt.ts";
import { runDiscussion } from "./discuss.ts";
import { runImplement } from "./implement.ts";
import {
  registerMarkTaskDoneTool,
  registerCompleteImplementationTool,
  registerImplementerActivityRenderer,
} from "./implement-tools.ts";
import { runApprove, runSteer, cleanupOrchestration } from "./hitl-pause.ts";
import { runFinalize, registerSaveTaskTool } from "./finalize.ts";
import { registerPrecommitCheckTool } from "./precommit-check.ts";
import { registerCommitTool } from "./commit-tool.ts";
import { registerExploreCommand, registerExploreTool } from "./explore.ts";
import { registerWorkflowConfigTool } from "./workflow-config-tool.ts";
import { getSkillsDir } from "./utils.ts";
import { setupAutocomplete } from "./autocomplete.ts";
import { handlePreCompact, handlePostCompact } from "./compaction.ts";

export default function (pi: ExtensionAPI): void {
  pi.on("resources_discover", async () => {
    return { skillPaths: [getSkillsDir()] };
  });

  pi.on("session_start", async (_event, ctx) => {
    resetWidgetVisibility();
    const state = loadState(ctx);
    updateUi(state, ctx);
    setupAutocomplete(ctx, ctx.cwd);
  });

  pi.on("session_before_compact", async (event, ctx) => {
    const result = await handlePreCompact(event, ctx);
    if (result) return result;
  });

  pi.on("session_compact", async (event, ctx) => {
    await handlePostCompact(event, ctx);
  });

  // Session shutdown aborts and kills any live implementer child, clears
  // the pause window, and unregisters the input handler so a dying session
  // never leaves an orphaned subprocess steering nobody.
  pi.on("session_shutdown", async () => {
    await cleanupOrchestration(500);
  });

  pi.on("before_agent_start", async (event, ctx) => {
    const currentState = loadState(ctx);

    if (!currentState || currentState.phase === "idle") {
      return;
    }

    const phasePrompt = await buildPhasePrompt(currentState.phase);
    const topic = currentState.specText
      ? `\n\nTopic: ${currentState.specText}`
      : "";

    return {
      systemPrompt: `${event.systemPrompt}\n\n${phasePrompt}${topic}`,
    };
  });

  registerExploreCommand(pi);
  registerExploreTool(pi);

  registerSaveTaskTool(pi);
  registerMarkTaskDoneTool(pi);
  registerCompleteImplementationTool(pi);
  registerPrecommitCheckTool(pi);
  registerCommitTool(pi);
  registerWorkflowConfigTool(pi);

  // Zero-token activity relay rendering (T2). Fire-and-forget: degrades to
  // unrendered (but persisted) entries when pi-tui is not resolvable.
  void registerImplementerActivityRenderer(pi);

  // ── Phase-based tool gate ──────────────────────────────────
  // Gated phases (discussing, finalizing) block write-capable tools
  // with a phase-aware message. Tools stay in the active set so the
  // model gets an explanation instead of "tool not found".
  pi.on("tool_call", async (event, ctx) => {
    const currentState = loadState(ctx);
    if (!currentState) return;
    const phase = currentState.phase;
    if (phase !== "discussing" && phase !== "finalizing") return;

    if (
      isToolCallEventType("write", event) ||
      isToolCallEventType("edit", event) ||
      DISCUSS_BLOCKED_TOOLS.includes(event.toolName)
    ) {
      const userCommand = phase === "discussing" ? "/finalize" : "/implement";
      return {
        block: true,
        reason:
          `The '${phase}' phase is read-only: write, edit, PARA-doc and commit tools are gated. ` +
          `Wait for the user to run ${userCommand}.`,
      };
    }
  });

  // ── /discuss ───────────────────────────────────────────────
  pi.registerCommand("discuss", {
    description:
      "Discuss an issue, bug, chore, or small fix with the engineer. " +
      "Usage: /discuss <topic>",
    handler: async (args, ctx) => {
      await runDiscussion(args, pi, ctx);
    },
  });

  // ── /finalize ──────────────────────────────────────────────
  pi.registerCommand("finalize", {
    description:
      "Draft the task contract from the discussion. " +
      "Valid only after /discuss. Usage: /finalize [note]",
    handler: async (args, ctx) => {
      await runFinalize(args, pi, ctx);
    },
  });

  // ── /implement ─────────────────────────────────────────────
  pi.registerCommand("implement", {
    description:
      "TDD implementation of the task contract. " +
      "Valid only after /finalize. Usage: /implement [note]",
    handler: async (args, ctx) => {
      await runImplement(args, pi, ctx);
    },
  });

  // ── /approve ──────────────────────────────────────────────
  pi.registerCommand("approve", {
    description:
      "Approve the manual behavior under verification and commit it. " +
      "Only valid during a manual verification pause.",
    handler: async (_args, ctx) => {
      runApprove(pi, ctx);
    },
  });

  // ── /steer ────────────────────────────────────────────────
  pi.registerCommand("steer", {
    description:
      "Forward feedback to the implementer subprocess. " +
      "Only valid during a manual verification pause. Usage: /steer <message>",
    handler: async (args, ctx) => {
      runSteer(args, pi, ctx);
    },
  });

  // ── /task ──────────────────────────────────────────────────
  pi.registerCommand("task", {
    description: "Show/hide the workflow widget. Usage: /task",
    handler: async (_args, ctx) => {
      toggleWidgetVisible();
      updateUi(loadState(ctx), ctx);
    },
  });
}
