import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { loadState, transitionTo, updateUi } from "./state.ts";
import { applyDiscussTools } from "./tools.ts";
import { validateTask } from "./task-contract.ts";
import { loadContent } from "./utils.ts";

/**
 * Finalize the discussion: steer the agent to draft the task contract.
 *
 * Valid only from the discussing phase. Loads finalize-prompt.md and hands
 * it to the agent as a steer. The agent drafts the contract and calls
 * save_task; the extension performs the phase transition there.
 *
 * @param pi  - ExtensionAPI reference.
 * @param ctx - Extension context.
 */
export async function runFinalize(pi: ExtensionAPI, ctx: ExtensionContext): Promise<void> {
  const state = loadState(ctx);
  if (!state || state.phase !== "discussing") {
    ctx.ui.notify(
      "/finalize is only valid during the discussing phase. Run /discuss first.",
      "warning",
    );
    return;
  }
  const prompt = await loadContent("finalize-prompt.md");
  pi.sendUserMessage(prompt, { deliverAs: "steer" });
}

/**
 * Register the `save_task` AI tool.
 *
 * The agent calls save_task to persist a drafted or revised task contract.
 * The extension validates the payload deterministically, stores the task,
 * and transitions the workflow to the finalized phase. Idempotent: safe to
 * call again while already finalized to update the contract.
 *
 * @param pi - ExtensionAPI reference.
 */
export function registerSaveTaskTool(pi: ExtensionAPI): void {
  pi.registerTool({
    name: "save_task",
    label: "Save Task",
    description:
      "Persist the finalized task contract. Call once the contract is " +
      "drafted or revised. Validates the payload, stores the task, and " +
      "transitions the workflow to the finalized phase.",

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
      if (!state || (state.phase !== "discussing" && state.phase !== "finalized")) {
        return {
          content: [
            {
              type: "text",
              text: "save_task requires the discussing or finalized phase.",
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
      state.task = result.task;
      state.returnCount = 0;
      transitionTo(pi, state, "finalized");
      applyDiscussTools(pi);
      updateUi(state, ctx);
      return {
        content: [
          { type: "text", text: "Task saved. Phase: finalized." },
        ],
      };
    },
  });
}
