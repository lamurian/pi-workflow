import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { isToolCallEventType } from "@earendil-works/pi-coding-agent";
import { loadState, updateUi } from "./state.ts";
import { buildPhasePrompt } from "./prompt.ts";
import { runDiscussion } from "./discuss.ts";
import { runYolo } from "./yolo.ts";
import {
  startTdd,
  NO_INPUT_WARNING,
  registerCompleteImplementationTool,
  resolveImplementSpec,
} from "./implement.ts";
import { registerExploreCommand, registerExploreTool } from "./explore.ts";
import { parseArgs, getSkillsDir, stripFileRefs } from "./utils.ts";
import { setupAutocomplete } from "./autocomplete.ts";
import { handlePreCompact, handlePostCompact } from "./compaction.ts";
import { readFile } from "node:fs/promises";
import { statSync, existsSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";

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
    // Always read fresh state from session to avoid stale module-level cache.
    const currentState = loadState(ctx);

    if (!currentState || currentState.phase === "idle") {
      return;
    }

    // Phase-specific protocol prompt (only discussing has one)
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
  registerCompleteImplementationTool(pi);

  // ── Phase-based edit restrictions ───────────────────────────
  pi.on("tool_call", async (event, ctx) => {
    const currentState = loadState(ctx);
    if (!currentState || currentState.phase !== "discussing") return;

    // /discuss: no file edits allowed
    if (isToolCallEventType("write", event) || isToolCallEventType("edit", event)) {
      return {
        block: true,
        reason:
          "The /discuss command does not allow file editing. " +
          "Discuss the approach first, then use /implement to execute the agreed plan.",
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

  // ── /implement ──────────────────────────────────────────────
  pi.registerCommand("implement", {
    description:
      "TDD implementation. Usage: /implement <topic> | /implement @<file> | " +
      "/implement <path-to-file>",
    handler: async (args, ctx) => {
      const trimmed = args.trim();

      // ── Phase 1: Extract @file references ──────────────────
      const refRegex = /@(\S+)/g;
      const refs: string[] = [];
      let match: RegExpExecArray | null;
      while ((match = refRegex.exec(trimmed)) !== null) {
        refs.push(match[1]);
      }

      // ── Phase 2: Resolve the specification source ───────────
      let spec: string | undefined;

      // Strategy A: @-prefixed file references — read contents as spec
      if (refs.length > 0) {
        const { fileContents } = await parseArgs(args, ctx.cwd);
        if (fileContents.length > 0) {
          spec = fileContents.join("\n\n---\n\n");
        }
      }

      // Strategy B: plain path (no @ prefix) — read the file
      if (!spec && trimmed) {
        const maybePath = isAbsolute(trimmed)
          ? trimmed
          : resolve(ctx.cwd, trimmed);
        try {
          if (existsSync(maybePath) && statSync(maybePath).isFile()) {
            spec = await readFile(maybePath, "utf-8");
          }
        } catch {
          // Not a valid file — fall through to free-form topic
        }
      }

      // Strategy C: bare /implement — resolve from session
      if (!spec) {
        const topic = stripFileRefs(trimmed);

        if (!topic) {
          const resolvedSpec = await resolveImplementSpec(ctx);
          if (resolvedSpec) {
            spec = resolvedSpec;
          } else {
            ctx.ui.notify(NO_INPUT_WARNING, "warning");
            return;
          }
        } else {
          // Free-form topic text
          spec = topic;
        }
      }

      // ── Phase 3: Start TDD ─────────────────────────────────
      if (!spec) {
        ctx.ui.notify("No specification resolved. Nothing to implement.", "warning");
        return;
      }

      await startTdd(spec, pi, ctx);
    },
  });

  // ── /yolo ─────────────────────────────────────────────────
  pi.registerCommand("yolo", {
    description:
      "Snap back to the default pi session from any workflow phase. " +
      "Resets all phase state (discussing, implementing, etc.). " +
      "Usage: /yolo",
    handler: async (_args, ctx) => {
      await runYolo(pi, ctx);
    },
  });
}
