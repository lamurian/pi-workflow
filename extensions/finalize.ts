import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { loadState } from "./state.ts";
import { runContractScan } from "./contract-scan.ts";
import { runSaveTask } from "./save-task-core.ts";
import { loadContent } from "./utils.ts";

export { runContractScan };

/**
 * Finalize the discussion: steer the agent to draft the task contract.
 *
 * Valid only from the discussing phase. Loads finalize-prompt.md, appends
 * the optional engineer's note, and hands the prompt to the agent as a steer.
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
 * Register the `save_task` AI tool: a thin adapter over runSaveTask
 * (save-task-core.ts) with caller 'agent'.
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

    parameters: Type.Object(
      {
        title: Type.String({ description: "Short task title" }),
        instruction: Type.String({ description: "What to implement" }),
        done: Type.Optional(Type.String({ description: "Definition of done" })),
        operation: Type.Optional(
          Type.String({ description: "Contract operation (default 'replace')" }),
        ),
        sources: Type.Optional(
          Type.Array(Type.Unknown(), {
            description: "Implementation files: { path, status?, tasks }",
          }),
        ),
        tests: Type.Optional(
          Type.Array(Type.Unknown(), {
            description: "Test/fixture files: { path, status?, tasks }",
          }),
        ),
        tasks: Type.Optional(
          Type.Array(Type.Unknown(), {
            description: "Task units: { id, description, expectedOutput[], status? }",
          }),
        ),
        files: Type.Optional(
          Type.Unknown({ description: "Legacy allowlist — rejected; use sources/tests/tasks" }),
        ),
        behaviors: Type.Optional(
          Type.Unknown({ description: "Legacy behaviors — rejected; use tasks" }),
        ),
      },
      { additionalProperties: true },
    ),

    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const state = loadState(ctx);
      const res = await runSaveTask(state, params as Record<string, unknown>, {
        caller: "agent",
        pi,
        ctx,
      });
      return {
        content: [{ type: "text", text: res.text }],
        details: {},
        ...(res.ok ? {} : { isError: true }),
      };
    },
  });
}
