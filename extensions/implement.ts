import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { Type } from "typebox";
import { loadContent, renderTemplate } from "./utils.ts";
import { readLatestAdr } from "./adr.ts";
import { detectDiscussionTopic, getLatestAssistantMessage } from "./discuss.ts";
import {
  type WorkflowState,
  loadState,
  transitionTo,
  updateUi,
} from "./state.ts";
import { onPlanImplemented, archivePlan } from "./plan.ts";

/**
 * Resolve the specification source when /implement is called without
 * any arguments (bare).
 *
 * Priority:
 * 1. Latest assistant (AI) message — the finalized plan from a discussion
 * 2. Discussion topic (from /discuss state or /discuss message) 
 * 3. Latest ADR content
 * 4. null — nothing to implement
 *
 * @param ctx - Extension context with session manager access.
 * @returns The resolved spec content, or null if nothing found.
 */
export async function resolveImplementSpec(ctx: ExtensionContext): Promise<string | null> {
  // Priority 1: latest assistant message (finalized plan from discussion)
  const assistantMsg = getLatestAssistantMessage(ctx);
  if (assistantMsg) {
    return assistantMsg;
  }

  // Priority 2: discussion topic
  const discussionTopic = detectDiscussionTopic(ctx);
  if (discussionTopic) {
    return discussionTopic;
  }

  // Priority 3: latest ADR
  const latestAdr = await readLatestAdr(ctx.cwd);
  if (latestAdr) {
    return [
      `Title: ${latestAdr.title}`,
      `Description: ${latestAdr.description}`,
      `Context: ${latestAdr.context}`,
      `Decision: ${latestAdr.decision}`,
      `Impact: ${latestAdr.impact}`,
    ].join("\n");
  }

  return null;
}

/**
 * Warning shown when /implement is called with no args and
 * no prior discussion or ADR exists.
 *
 * Guides the user to the right starting point.
 */
export const NO_INPUT_WARNING =
  "No spec provided and no ADR found. Run /brainstorm <topic> " +
  "to start the full workflow, or /discuss <topic> for a " +
  "lightweight discussion-then-implement flow.";

/**
 * Start the TDD implementation phase.
 *
 * 1. Builds a TDD system prompt from the specification
 * 2. Transitions state to "implementing"
 * 3. Saves pending plan path (if any) for later finalization
 * 4. Injects the TDD context into the next agent turn
 *   via pi.sendUserMessage
 *
 * The actual TDD enforcement (test-first, run tests) is driven
 * by the system prompt injected in before_agent_start.
 * The plan is NOT archived here — it stays in place until the
 * agent calls complete_implementation after all tasks are done.
 *
 * @param spec     - Full specification text (usually from an ADR).
 * @param pi       - ExtensionAPI reference.
 * @param ctx      - Current extension context.
 * @param planPath - Optional path to a plan file to finalize later.
 */
export async function startTdd(
  spec: string,
  pi: ExtensionAPI,
  ctx: ExtensionContext,
  planPath?: string,
): Promise<void> {
  const state: WorkflowState = {
    phase: "implementing",
    specText: spec,
    adrFiles: [],
    pendingPlanPath: planPath,
  };

  const latestAdr = await readLatestAdr(ctx.cwd);
  if (latestAdr) {
    state.adrFiles = [latestAdr.title];
  }

  transitionTo(pi, state, "implementing");
  updateUi(state, ctx);

  const tddPrompt = await buildTddPrompt(spec);

  ctx.ui.notify("Starting TDD implementation.", "info");

  // Send the TDD prompt as a user message to kick off the agent
  pi.sendUserMessage(tddPrompt, { deliverAs: "steer" });
}

/**
 * Build the TDD-mode system prompt by loading the template
 * and substituting the specification.
 *
 * @param spec - Specification text to inject.
 * @returns The rendered TDD prompt string.
 */
export async function buildTddPrompt(spec: string): Promise<string> {
  const template = await loadContent("tdd-prompt.md");
  return renderTemplate(template, { spec });
}

/**
 * Generate an end-of-implementation report.
 *
 * Reads test results from state and compares against the spec.
 *
 * @param state - Current workflow state with test results.
 * @param ctx   - Extension context.
 * @returns A markdown report string.
 */
export async function generateReport(
  state: WorkflowState,
  _ctx: ExtensionContext,
): Promise<string> {
  const template = await loadContent("report-template.md");
  const results = state.lastTestResults;

  const coverageRows = state.adrFiles
    .map((f) => `| ${f} | Implemented |`)
    .join("\n");

  return renderTemplate(template, {
    summary: "Implementation complete. See details below.",
    coverageRows: coverageRows || "| (no ADR reference) | Implemented |",
    passed: String(results?.passed ?? 0),
    failed: String(results?.failed ?? 0),
    coveragePercent: String(results?.coveragePercent ?? 0),
    gaps: "Review the ADR for any unimplemented edge cases.",
  });
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
 * Run the project's test command and return results.
 *
 * Detects common test frameworks by checking for config files.
 * Falls back to "npm test". Parses output for pass/fail counts.
 *
 * @param pi  - ExtensionAPI reference for execution.
 * @param ctx - Extension context (for cwd).
 * @returns Object with pass/fail counts.
 */
export async function runTests(
  pi: ExtensionAPI,
  ctx: ExtensionContext,
): Promise<{ passed: number; failed: number; coveragePercent?: number }> {
  ctx.ui.notify("Running tests...", "info");

  const [cmd, args] = detectTestCommand(ctx.cwd);
  try {
    const result = await pi.exec(cmd, args, { cwd: ctx.cwd, timeout: 120_000 });
    const stdout = result.stdout ?? "";

    // Parse test counts from common output formats (Mocha/Jest)
    const passMatch = stdout.match(/(\d+)\s+passing/);
    const failMatch = stdout.match(/(\d+)\s+failing/);
    // Parse coverage from istanbul/lcov summary line
    const coverageMatch = stdout.match(/All files\s+\|[^|]+\|[^|]+\|\s*([\d.]+)/);

    return {
      passed: passMatch ? parseInt(passMatch[1], 10) : 0,
      failed: failMatch ? parseInt(failMatch[1], 10) : 0,
      coveragePercent: coverageMatch ? parseFloat(coverageMatch[1]) : undefined,
    };
  } catch {
    return { passed: 0, failed: 1 };
  }
}

/**
 * Get the "Not Yet Implemented" gaps from the session.
 *
 * @param _ctx - Extension context.
 * @returns Array of gap descriptions.
 */
export async function getGaps(
  _ctx: ExtensionContext,
): Promise<string[]> {
  // TODO: scan session for unimplemented items vs ADR
  return [];
}

/**
 * Register the `complete_implementation` AI tool.
 *
 * Called by the agent after all TDD tasks are done and all tests pass.
 * Reads the pending plan path from workflow state (or accepts one directly),
 * updates spec/ADR status via onPlanImplemented, archives the plan file,
 * and transitions out of the implementing phase.
 *
 * @param pi - ExtensionAPI reference.
 */
export function registerCompleteImplementationTool(pi: ExtensionAPI): void {
  pi.registerTool({
    name: "complete_implementation",
    label: "Complete Implementation",
    description:
      "Finalize implementation of the current plan. Archives the plan file, " +
      "updates the related spec's remaining count and status, and cascades " +
      "to the parent ADR. Call this ONLY after all plan tasks are complete " +
      "and all tests pass.",

    parameters: Type.Object({
      planFile: Type.Optional(Type.String({
        description:
          "Path to the plan file to finalize. If omitted, reads from " +
          "workflow state (set by /implement @docs/plans/<file>).",
      })),
    }),

    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const state = loadState(ctx);
      if (!state || state.phase !== "implementing") {
        return {
          content: [
            { type: "text", text: "Not in implementing phase. Nothing to finalize." },
          ],
          isError: true,
        };
      }

      // Determine plan path: explicit param > state > nothing
      let planPath: string | undefined = params.planFile;
      if (!planPath) {
        planPath = state.pendingPlanPath;
      }

      if (!planPath) {
        // No plan to archive — free-form TDD session, just clean up
        transitionTo(pi, state, "idle");
        updateUi(null, ctx);
        return {
          content: [
            {
              type: "text",
              text:
                "## Implementation Complete\n\n" +
                "No plan file to finalize. The implementation phase is now " +
                "complete and the workflow has returned to idle.",
            },
          ],
        };
      }

      const resolvedPath = isAbsolute(planPath)
        ? planPath
        : resolve(ctx.cwd, planPath);

      // Verify the plan file still exists
      if (!existsSync(resolvedPath)) {
        ctx.ui.notify(
          `Plan file not found: ${resolvedPath}. Already archived?`,
          "warning",
        );
        state.pendingPlanPath = undefined;
        transitionTo(pi, state, "idle");
        updateUi(null, ctx);
        return {
          content: [
            {
              type: "text",
              text:
                `Plan file ${resolvedPath} no longer exists (already archived?). ` +
                "Cleaning up state and returning to idle.",
            },
          ],
        };
      }

      // 1. Update spec/ADR status (decrements remaining, cascades)
      ctx.ui.notify("Updating spec and ADR status...", "info");
      await onPlanImplemented(resolvedPath, ctx.cwd);

      // 2. Archive the plan file
      ctx.ui.notify("Archiving plan...", "info");
      const archived = await archivePlan(resolvedPath, ctx.cwd);
      ctx.ui.notify(`Plan archived: ${archived}`, "info");

      // 3. Clean up state and transition to idle
      state.pendingPlanPath = undefined;
      transitionTo(pi, state, "idle");
      updateUi(null, ctx);

      return {
        content: [
          {
            type: "text",
            text:
              "## Implementation Complete\n\n" +
              "- Plan archived\n" +
              "- Spec and ADR status updated\n\n" +
              "The implementation is finalized. The workflow has returned to idle.",
          },
        ],
      };
    },
  });
}
