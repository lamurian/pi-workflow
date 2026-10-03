import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { Type } from "typebox";
import { loadContent, renderTemplate } from "./utils.ts";
import {
  loadState,
  transitionTo,
  updateUi,
  saveState,
  type WorkflowState,
  type TaskContract,
} from "./state.ts";
import {
  parseTestOutput,
  evaluateCompletionGate,
  renderTaskContract,
} from "./task-contract.ts";

/**
 * Start the TDD implementation phase from a finalizing task contract.
 *
 * Valid only from the finalizing phase. Consumes state.task, transitions
 * to implementing, and hands the agent a TDD prompt built from the
 * contract, with the optional engineer's note appended as guidance.
 *
 * @param args - Optional note appended to the TDD prompt.
 * @param pi   - ExtensionAPI reference.
 * @param ctx  - Extension context.
 */
export async function runImplement(
  args: string,
  pi: ExtensionAPI,
  ctx: ExtensionContext,
): Promise<void> {
  const state = loadState(ctx);
  if (!state || state.phase !== "finalizing") {
    ctx.ui.notify(
      "/implement is only valid after /finalize. Run /discuss then /finalize first.",
      "warning",
    );
    return;
  }
  const task = state.task;
  if (!task) {
    ctx.ui.notify("No task contract found. Run /finalize to create one.", "warning");
    return;
  }
  transitionTo(pi, state, "implementing");
  updateUi(state, ctx);
  let prompt = await buildTddPrompt(task);
  const note = args.trim();
  if (note) {
    prompt +=
      `\n\n## Engineer's note\n\n${note}` +
      "\n\nGuidance on top of the authoritative contract. If it implies changes " +
      "beyond the contract, report that and tell the user to run /finalize — " +
      "do not implement beyond the contract.";
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
export async function buildTddPrompt(task: TaskContract): Promise<string> {
  const template = await loadContent("tdd-prompt.md");
  return renderTemplate(template, { task: renderTaskContract(task) });
}

/**
 * Detect the project's test command by checking for common config files.
 *
 * @param cwd - Project working directory.
 * @returns [command, args[]] tuple, or ["npm", ["test"]] as fallback.
 */
function detectTestCommand(cwd: string): [string, string[]] {
  if (existsSync(resolve(cwd, "vitest.config.ts"))) return ["npx", ["vitest", "run"]];
  if (existsSync(resolve(cwd, "jest.config.ts"))) return ["npx", ["jest"]];
  if (existsSync(resolve(cwd, "jest.config.js"))) return ["npx", ["jest"]];
  if (existsSync(resolve(cwd, ".mocharc.yml"))) return ["npx", ["mocha"]];
  return ["npm", ["test"]];
}

/**
 * Register the `run_tests` AI tool.
 *
 * Runs the detected test command and records the result in workflow state.
 * The exit code is the primary pass/fail signal; counts/coverage are
 * best-effort. The agent must call this before mark_task_done.
 *
 * @param pi - ExtensionAPI reference.
 */
export function registerRunTestsTool(pi: ExtensionAPI): void {
  pi.registerTool({
    name: "run_tests",
    label: "Run Tests",
    description:
      "Run the project's test command and record the result. Call this " +
      "after implementing a test behavior and before mark_task_done.",
    parameters: Type.Object({}),

    async execute(_toolCallId, _params, _signal, _onUpdate, ctx) {
      const state = loadState(ctx);
      if (!state || state.phase !== "implementing") {
        return {
          content: [{ type: "text", text: "run_tests requires the implementing phase." }],
          isError: true,
        };
      }
      const [cmd, cmdArgs] = detectTestCommand(ctx.cwd);
      let exitCode = 1;
      let stdout = "";
      try {
        const result = await pi.exec(cmd, cmdArgs, { cwd: ctx.cwd, timeout: 120_000 });
        exitCode = result.exitCode ?? 0;
        stdout = result.stdout ?? "";
      } catch (err) {
        stdout = String((err as Error).message ?? err);
      }
      const parsed = parseTestOutput(exitCode, stdout);
      state.lastTestResults = parsed;
      saveState(pi, state);
      updateUi(state, ctx);
      return {
        content: [
          {
            type: "text",
            text: `Tests ${exitCode === 0 ? "passed" : "failed"} (exit ${exitCode}). passed=${parsed.passed} failed=${parsed.failed}` +
              (parsed.coveragePercent !== undefined ? ` coverage=${parsed.coveragePercent}%` : ""),
          },
        ],
      };
    },
  });
}

/**
 * Register the `mark_task_done` AI tool.
 *
 * Marks a single behavior as done after the agent has implemented it and
 * run the tests. Records evidence in the session for the final report.
 *
 * @param pi - ExtensionAPI reference.
 */
export function registerMarkTaskDoneTool(pi: ExtensionAPI): void {
  pi.registerTool({
    name: "mark_task_done",
    label: "Mark Task Done",
    description:
      "Mark one behavior as done after implementing it and running tests. " +
      "Pass the behavior id and a short evidence note.",
    parameters: Type.Object({
      behaviorId: Type.String({ description: "The behavior id, e.g. T1" }),
      evidence: Type.String({ description: "Short note on how it was verified" }),
    }),

    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const state = loadState(ctx);
      if (!state || state.phase !== "implementing") {
        return {
          content: [{ type: "text", text: "mark_task_done requires the implementing phase." }],
          isError: true,
        };
      }
      const task = state.task;
      const behavior = task?.behaviors.find((b) => b.id === params.behaviorId);
      if (!task || !behavior) {
        return {
          content: [
            { type: "text", text: `mark_task_done rejected: behavior not in contract (${params.behaviorId}).` },
          ],
          isError: true,
        };
      }
      if (behavior.status === "removed") {
        return { content: [{ type: "text", text: `mark_task_done rejected: behavior ${params.behaviorId} is removed.` }], isError: true };
      }
      behavior.status = "done";
      saveState(pi, state);
      updateUi(state, ctx);
      return { content: [{ type: "text", text: `${params.behaviorId} marked done. Evidence: ${params.evidence}` }] };
    },
  });
}

/**
 * Register the `complete_implementation` AI tool.
 *
 * Ends the implementing phase and returns the workflow to idle. Refuses
 * while any behavior is still active or the last test run had failures.
 *
 * @param pi - ExtensionAPI reference.
 */
export function registerCompleteImplementationTool(pi: ExtensionAPI): void {
  pi.registerTool({
    name: "complete_implementation",
    label: "Complete Implementation",
    description:
      "Finalize implementation. Ends the implementing phase and returns " +
      "the workflow to idle. Call this ONLY after all behaviors are done " +
      "and all tests pass.",

    parameters: Type.Object({}),

    async execute(_toolCallId, _params, _signal, _onUpdate, ctx) {
      const state = loadState(ctx);
      if (!state || state.phase !== "implementing") {
        return {
          content: [{ type: "text", text: "Not in implementing phase. Nothing to finalize." }],
          isError: true,
        };
      }
      const refusal = evaluateCompletionGate(state);
      if (refusal) {
        return {
          content: [{ type: "text", text: `Cannot complete: ${refusal}.` }],
          isError: true,
        };
      }
      transitionTo(pi, state, "idle");
      updateUi(null, ctx);
      return {
        content: [{ type: "text", text: "## Implementation Complete\n\nThe workflow has returned to idle." }],
      };
    },
  });
}

/**
 * Build a completion report from the workflow state.
 *
 * @param state - Current workflow state.
 * @returns A markdown report string.
 */
export function generateReport(state: WorkflowState): string {
  const task = state.task;
  const results = state.lastTestResults;
  const lines: string[] = [];
  lines.push("# Implementation Report");
  if (task) {
    lines.push("", `## ${task.title}`, "", renderTaskContract(task));
  }
  lines.push("", "## Test Results");
  lines.push(`- Passed: ${results?.passed ?? 0}`);
  lines.push(`- Failed: ${results?.failed ?? 0}`);
  if (results?.coveragePercent !== undefined) {
    lines.push(`- Coverage: ${results.coveragePercent}%`);
  }
  return lines.join("\n");
}
