import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { isToolCallEventType } from "@earendil-works/pi-coding-agent";
import { loadState, updateUi } from "./state.ts";
import { DISCUSS_BLOCKED_TOOLS } from "./tools.ts";
import { buildPhasePrompt } from "./prompt.ts";
import { runDiscussion } from "./discuss.ts";
import {
  runImplement,
  registerMarkTaskDoneTool,
  registerCompleteImplementationTool,
} from "./implement.ts";
import { runFinalize, registerSaveTaskTool } from "./finalize.ts";
import { registerExploreCommand, registerExploreTool } from "./explore.ts";
import { getSkillsDir } from "./utils.ts";
import { setupAutocomplete } from "./autocomplete.ts";
import { handlePreCompact, handlePostCompact } from "./compaction.ts";

export default function (pi: ExtensionAPI): void {
  // ─── Resources Discovery ────────────────────────────────────
  pi.on("resources_discover", async () => {
    return { skillPaths: [getSkillsDir()] };
  });

  // ─── Session Lifecycle ──────────────────────────────────────
  pi.on("session_start", async (_event, ctx) => {
    const state = loadState(ctx);
    updateUi(state, ctx);
    setupAutocomplete(ctx, ctx.cwd);
  });

  // ─── Compaction Preservation ─────────────────────────────────
  pi.on("session_before_compact", async (event, ctx) => {
    const result = await handlePreCompact(event, ctx);
    if (result) return result;
  });

  pi.on("session_compact", async (event, ctx) => {
    await handlePostCompact(event, ctx);
  });

  // ─── Context Injection ──────────────────────────────────────
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

  // ─── Register Commands ──────────────────────────────────────
  registerExploreCommand(pi);
  registerExploreTool(pi);

  // ─── Register Workflow Tools ────────────────────────────────
  registerSaveTaskTool(pi);
  registerMarkTaskDoneTool(pi);
  registerCompleteImplementationTool(pi);

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
}
