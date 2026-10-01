import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { isToolCallEventType } from "@earendil-works/pi-coding-agent";
import { loadState, updateUi } from "./state.ts";
import { applyDiscussTools, restoreTools, DISCUSS_BLOCKED_TOOLS } from "./tools.ts";
import { buildPhasePrompt } from "./prompt.ts";
import { runDiscussion } from "./discuss.ts";
import {
  runImplement,
  registerRunTestsTool,
  registerMarkTaskDoneTool,
  registerBackToFinalizeTool,
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

    // Re-apply the read-only filter when resuming into a gated phase
    // (discussing or finalized). Any other phase restores the saved set.
    if (state && (state.phase === "discussing" || state.phase === "finalized")) {
      applyDiscussTools(pi);
    } else {
      restoreTools(pi);
    }
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
  registerRunTestsTool(pi);
  registerMarkTaskDoneTool(pi);
  registerBackToFinalizeTool(pi);
  registerCompleteImplementationTool(pi);

  // ── Phase-based edit restrictions ───────────────────────────
  pi.on("tool_call", async (event, ctx) => {
    const currentState = loadState(ctx);
    if (!currentState) return;
    const gated = currentState.phase === "discussing" || currentState.phase === "finalized";
    if (!gated) return;

    // Gated phases: no file edits or commit tools allowed.
    if (
      isToolCallEventType("write", event) ||
      isToolCallEventType("edit", event) ||
      DISCUSS_BLOCKED_TOOLS.includes(event.toolName)
    ) {
      return {
        block: true,
        reason:
          "This phase does not allow file edits or commits. " +
          "Run /implement to execute the agreed contract.",
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
      "Valid only after /discuss. Usage: /finalize",
    handler: async (_args, ctx) => {
      await runFinalize(pi, ctx);
    },
  });

  // ── /implement ──────────────────────────────────────────────
  pi.registerCommand("implement", {
    description:
      "TDD implementation of the finalized task contract. " +
      "Valid only after /finalize. Usage: /implement",
    handler: async (_args, ctx) => {
      await runImplement(pi, ctx);
    },
  });
}
