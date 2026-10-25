// ─── Solo TDD implementation path (T13) ──────────────────────────────────────
// `--solo` mode: the in-session TDD prompt steered into the conversation,
// split out of implement.ts.

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { TaskContract } from "./state.ts";
import { loadContent, renderTemplate } from "./utils.ts";
import { formatTask } from "./task-contract.ts";
import { buildEngineerNoteSection } from "./unit-task-text.ts";

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
 * In-session TDD loop (`--solo`): steer the agent with the TDD prompt.
 *
 * @param note  - Optional engineer's note appended to the prompt.
 * @param pi    - ExtensionAPI reference.
 * @param ctx   - Extension context.
 * @param task  - The task contract.
 */
export async function runSoloImplement(
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
    task: formatTask(task),
    commitInstruction,
  });
}
