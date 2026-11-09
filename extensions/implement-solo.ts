// `--solo` mode: the in-session TDD prompt steered into the conversation,
// split out of implement.ts.

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { TaskContract } from "./state.ts";
import { loadContent, renderTemplate } from "./utils.ts";
import { formatTask } from "./task-contract.ts";
import { buildEngineerNoteSection } from "./unit-task-text.ts";

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
  let prompt = await buildTddPrompt(task);
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
 * Build the commit instruction for the solo TDD prompt: each behavior is
 * committed through the `commit_changes` tool with its `taskId` right after
 * `mark_task_done`. Never instructs raw `git add`/`git commit` commands.
 *
 * @returns The rendered `## Commits` section (never empty).
 */
function buildCommitInstruction(): string {
  return (
    "\n## Commits\n\n" +
    "Right after each `mark_task_done`, call the `commit_changes` tool with " +
    "`taskId` set to the id of the behavior you just marked — one commit per " +
    "behavior, made by the tool, never by raw shell commands.\n\n" +
    "`commit_changes` stages only the behavior's owned paths and commits " +
    "with a conventional subject (`type(scope): description`, ≤75 chars) that " +
    "describes what the behavior changed. " +
    "Do NOT include the behavior id in the subject.\n"
  );
}

/**
 * Build the TDD prompt from the task contract. The rendered prompt carries
 * the contract's declared file paths plus the `commit_changes`/`taskId`
 * instruction (one commit per behavior right after `mark_task_done`).
 *
 * @param task - The task contract.
 * @returns The rendered TDD prompt string.
 */
export async function buildTddPrompt(task: TaskContract): Promise<string> {
  const template = await loadContent("tdd-prompt.md");
  return renderTemplate(template, {
    task: formatTask(task),
    commitInstruction: buildCommitInstruction(),
  });
}
