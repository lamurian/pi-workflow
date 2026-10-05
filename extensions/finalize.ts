import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { loadState, transitionTo, updateUi } from "./state.ts";
import { validateTask } from "./task-contract.ts";
import { loadContent } from "./utils.ts";

/**
 * Finalize the discussion: steer the agent to draft the task contract.
 *
 * Valid only from the discussing phase. Loads finalize-prompt.md, appends
 * the optional engineer's note, and hands the prompt to the agent as a
 * steer. The agent drafts the contract and calls save_task; the extension
 * performs the phase transition there.
 *
 * @param args - Optional note folded into the prompt as an Engineer's note.
 * @param pi   - ExtensionAPI reference.
 * @param ctx  - Extension context.
 */
export async function runFinalize(
  args: string,
  pi: ExtensionAPI,
  ctx: ExtensionContext,
): Promise<void> {
  const state = loadState(ctx);
  if (!state || state.phase !== "discussing") {
    ctx.ui.notify(
      "/finalize is only valid during the discussing phase. Run /discuss first.",
      "warning",
    );
    return;
  }
  let prompt = await loadContent("finalize-prompt.md");
  const note = args.trim();
  if (note) {
    prompt +=
      `\n\n## Engineer's note\n\n${note}` +
      "\n\nFold this note into the contract where relevant.";
  }
  pi.sendUserMessage(prompt, { deliverAs: "steer" });
}

/**
 * Register the `save_task` AI tool.
 *
 * The agent calls save_task to persist a drafted or revised task contract.
 * The extension validates the payload deterministically, stores the task,
 * and transitions the workflow to the finalizing phase. Idempotent: safe
 * to call again while already finalizing to update the contract.
 *
 * @param pi - ExtensionAPI reference.
 */
export function registerSaveTaskTool(pi: ExtensionAPI): void {
  pi.registerTool({
    name: "save_task",
    label: "Save Task",
    description:
      "Persist the task contract. Call once the contract is drafted or " +
      "revised. Validates the payload, stores the task, and transitions " +
      "the workflow to the finalizing phase.",

    parameters: Type.Object({
      title: Type.String({ description: "Short task title" }),
      instruction: Type.String({ description: "What to implement" }),
      files: Type.Array(Type.String(), { description: "Files affected" }),
      done: Type.String({ description: "Definition of done" }),
      behaviors: Type.Array(
        Type.Object({
          id: Type.String({ description: "Stable behavior id, e.g. T1" }),
          description: Type.String({ description: "Behavior under test" }),
          expectedOutput: Type.String({ description: "Expected output" }),
          kind: Type.String({ description: "test | manual" }),
          status: Type.String({ description: "active | removed | done" }),
          sourceFile: Type.Optional(
            Type.String({ description: "File that surfaces this behavior" }),
          ),
        }),
        { description: "Behaviors covered by the task contract" },
      ),
    }),

    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const state = loadState(ctx);
      if (!state || (state.phase !== "discussing" && state.phase !== "finalizing")) {
        return {
          content: [
            {
              type: "text",
              text: "save_task requires the discussing or finalizing phase.",
            },
          ],
          isError: true,
        };
      }
      const result = validateTask(params);
      if (!result.ok) {
        return {
          content: [{ type: "text", text: `save_task rejected: ${result.reason}` }],
          isError: true,
        };
      }
      const warnings = result.warnings;
      const entering = state.phase === "discussing";
      state.task = result.task;
      transitionTo(pi, state, "finalizing");
      updateUi(state, ctx);
      if (entering) {
        ctx.ui.notify(
          `Contract saved. Phase: finalizing — review the contract, run /implement when ready. ` +
            `(warnings: ${warnings.length})`,
          "info",
        );
      }
      const warningBlock =
        warnings.length > 0
          ? "\n\nWarnings (advisory — the contract was saved):\n" +
            warnings.map((w) => `warning: ${w}`).join("\n")
          : "";
      return {
        content: [
          {
            type: "text",
            text:
              "Task saved. Phase: finalizing (read-only). " +
              "Wait for the user to run /implement once the contract is approved." +
              warningBlock,
          },
        ],
      };
    },
  });
}
