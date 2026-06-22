import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import {
  decomposeInstruction,
  runParallelExploration,
  synthesizeResults,
  createLoader,
} from "./explore-core.ts";

// ─── /explore command registration ────────────────────────────────────────────

/**
 * Register the `/explore` slash command.
 *
 * Usage: /explore <instruction>
 *
 * The command:
 * 1. Decomposes the instruction into parallel search tasks
 * 2. Runs them concurrently via scout subprocesses
 * 3. Synthesizes results into a structured summary
 * 4. Injects the summary into the conversation via sendUserMessage
 *
 * @param pi - ExtensionAPI reference.
 */
export function registerExploreCommand(pi: ExtensionAPI): void {
  pi.registerCommand("explore", {
    description:
      "Explore the codebase using parallel searches. " +
      "Usage: /explore <instruction>",
    handler: async (args, ctx) => {
      const instruction = args.trim();
      if (!instruction) {
        ctx.ui.notify("Usage: /explore <instruction>", "warning");
        return;
      }

      /** Helper to set persistent explore status in the footer/status bar. */
      const setStatus = (text: string | undefined) => {
        ctx.ui.setStatus("explore", text);
      };

      setStatus("✦ Decomposing exploration into parallel searches...");

      // Phase 1: Decompose
      const tasks = await decomposeInstruction(instruction, ctx, ctx.signal);
      setStatus(`✦ Running ${tasks.length} parallel search${tasks.length > 1 ? "es" : ""}...`);

      // Phase 2: Execute in parallel
      const loader = createLoader(instruction);
      loader.update("Running scouts...");
      const results = await runParallelExploration(
        tasks,
        ctx.cwd,
        ctx.signal,
        (partial) => {
          const done = partial.filter((r) => r.exitCode >= 0).length;
          const msg = `${done}/${partial.length} scouts complete`;
          setStatus(`✦ ${msg}`);
          loader.update(msg);
        },
      );

      const successCount = results.filter((r) => r.exitCode === 0).length;
      setStatus(`✦ Synthesis: ${successCount}/${results.length} tasks succeeded`);
      loader.done();

      // Phase 3: Synthesize
      const summary = await synthesizeResults(instruction, results, ctx, ctx.signal);

      // Phase 4: Clear status and inject into conversation
      setStatus(undefined);
      pi.sendUserMessage(summary, { deliverAs: "steer" });
    },
  });
}

// ─── explore tool registration ─────────────────────────────────────────────────

/**
 * Register the `explore` tool for LLM-initiated use.
 *
 * The tool accepts an `instruction` parameter and returns synthesized
 * exploration results directly as tool output.
 *
 * @param pi - ExtensionAPI reference.
 */
export function registerExploreTool(pi: ExtensionAPI): void {
  pi.registerTool({
    name: "explore",
    label: "Explore",
    description:
      "Explore the codebase using parallel searches. " +
      "Provide an instruction describing what to find. " +
      "Runs multiple scouts concurrently with different search strategies " +
      "and returns a structured summary with relative file paths.",
    parameters: Type.Object({
      instruction: Type.String({
        description: "What to explore in the codebase",
      }),
    }),

    async execute(_toolCallId, params, signal, onUpdate, ctx) {
      const instruction = params.instruction.trim();
      if (!instruction) {
        return {
          content: [{ type: "text", text: "No instruction provided." }],
          isError: true,
        };
      }

      /** Helper to send a text progress update to the LLM via onUpdate. */
      const sendProgress = (text: string) => {
        onUpdate?.({
          content: [{ type: "text" as const, text }],
          details: undefined as any,
        });
      };

      // Phase 1: Decompose
      sendProgress(`✦ Decomposing instruction into search tasks...`);
      const tasks = await decomposeInstruction(instruction, ctx, signal);
      sendProgress(`✦ Split into ${tasks.length} parallel search task${tasks.length > 1 ? "s" : ""}`);

      // Phase 2: Execute with per-scout progress
      const results = await runParallelExploration(
        tasks,
        ctx.cwd,
        signal,
        (partial) => {
          const done = partial.filter((r) => r.exitCode >= 0).length;
          sendProgress(`✦ Scout progress: ${done}/${partial.length} complete`);
        },
      );

      // Phase 3: Synthesize
      sendProgress(`✦ Synthesizing ${results.length} scout result${results.length > 1 ? "s" : ""}...`);
      const summary = await synthesizeResults(instruction, results, ctx, signal);

      return {
        content: [{ type: "text", text: summary }],
      };
    },
  });
}
