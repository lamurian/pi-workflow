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
 * Build the path-scoped commit instruction from the task contract's
 * declared file paths. Stages via `git add -- <paths>` and commits with a
 * conventional subject; never mentions `commit_changes` or blanket staging.
 *
 * @param task - The task contract.
 * @returns The rendered `## Commits` section (never empty).
 */
function buildCommitInstruction(task: TaskContract): string {
  const declared = task.files.map((f) => f.path);
  const addCommand =
    declared.length > 0 ? `git add -- ${declared.join(" ")}` : "git add -- <paths>";
  return (
    "\n## Commits\n\n" +
    "After each `mark_task_done`, stage the contract's declared paths explicitly " +
    "and commit them yourself — the extension never commits in this mode.\n\n" +
    "1. Stage ONLY the declared paths (never the whole working tree):\n\n" +
    `   ${addCommand}\n\n` +
    "   The form is always `git add -- <paths>`: pass the contract's declared " +
    "paths from above, space-separated after `--`, including newly added test files.\n" +
    "2. Commit them with a conventional subject line:\n\n" +
    '   `git commit -m "type(scope): description"`\n\n' +
    "The subject must follow the conventional format (`type(scope): description`, " +
    "≤75 chars) and describe what the behavior changed. " +
    "Do NOT include the behavior id in the subject.\n"
  );
}

/**
 * Build the TDD prompt from the task contract. The rendered prompt carries
 * the contract's declared file paths plus path-scoped staging instructions
 * (`git add -- <paths>`, then `git commit` with a conventional subject).
 *
 * @param task - The task contract.
 * @returns The rendered TDD prompt string.
 */
export async function buildTddPrompt(task: TaskContract): Promise<string> {
  const template = await loadContent("tdd-prompt.md");
  return renderTemplate(template, {
    task: formatTask(task),
    commitInstruction: buildCommitInstruction(task),
  });
}
