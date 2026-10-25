import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { loadState, transitionTo, updateUi, saveState } from "./state.ts";
import { evaluateCompletionGate } from "./task-contract.ts";
import { readGitHead } from "./git-ops.ts";
import { runTestGate } from "./test-gate-run.ts";
import { formatGateEvidenceLine } from "./test-gate-report.ts";
import {
  formatImplementerActivity,
  type ImplementerActivityData,
} from "./implementer-activity.ts";

/**
 * Register the transcript renderer for relayed implementer activity entries.
 *
 * Custom entries (pi.appendEntry) are not sent to the LLM, so the relay costs
 * zero main-process tokens; this renderer only affects how they look in the
 * transcript. pi-tui is imported lazily inside a try/catch: when it cannot be
 * resolved (e.g. unit tests), registration degrades gracefully — entries are
 * still persisted, just not custom-rendered.
 *
 * @param pi - ExtensionAPI reference.
 * @returns True when the renderer was registered, false when degraded.
 */
export async function registerImplementerActivityRenderer(pi: ExtensionAPI): Promise<boolean> {
  try {
    if (typeof pi.registerEntryRenderer !== "function") return false;
    const piTui = (await import("@earendil-works/pi-tui")) as {
      Box: new (
        w: number,
        h: number,
        bg?: (text: string) => string,
      ) => { addChild: (child: unknown) => void };
      Text: new (text: string, x?: number, y?: number) => unknown;
    };
    pi.registerEntryRenderer<ImplementerActivityData>(
      "implementer-activity",
      (entry, { expanded }, theme) => {
        const data = entry.data;
        if (!data) return undefined;
        const box = new piTui.Box(1, 1, (text: string) => theme.bg("customMessageBg", text));
        box.addChild(
          new piTui.Text(`${theme.fg("dim", `[${data.behaviorId}]`)} ${formatImplementerActivity(data)}`, 0, 0),
        );
        if (expanded) {
          box.addChild(new piTui.Text(theme.fg("dim", data.at), 0, 0));
        }
        return box as never;
      },
    );
    return true;
  } catch {
    return false;
  }
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
      // T8: gate-backed evidence — for a task with tests refs the evidence
      // carries the orchestrator's gate result line (scope + pass/fail),
      // not the unit's self-report. The gate result is written by the
      // behavior loop's per-task scope gate after each landed commit.
      const gateResult = state.gateResults?.[params.behaviorId];
      const gateLine = gateResult
        ? `\nOrchestrator gate: ${formatGateEvidenceLine(gateResult)}`
        : "";
      // T2 soft-warn: HEAD unchanged since the previous mark (or the
      // /implement baseline) means no commit landed for the last behavior.
      const head = await readGitHead(pi, ctx.cwd);
      let warning = "";
      if (head !== null) {
        const previous = state.lastMarkedHead ?? state.baselineHead;
        if (previous !== undefined && head === previous) {
          warning =
            "\nWarning: no commit detected since the previous behavior — " +
            "consider calling commit_changes.";
        }
        state.lastMarkedHead = head;
      }
      saveState(pi, state);
      updateUi(state, ctx);
      return {
        content: [
          {
            type: "text",
            text: `${params.behaviorId} marked done. Evidence: ${params.evidence}${gateLine}${warning}`,
          },
        ],
      };
    },
  });
}

/**
 * Register the `complete_implementation` AI tool.
 *
 * Ends the implementing phase and returns the workflow to idle. Refuses
 * while any behavior is still active. Before completing, runs the FULL
 * GATE: every suite from state.testTool unfiltered, orchestrator-run — a
 * red gate blocks completion, naming the failing suite and its output tail.
 *
 * @param pi - ExtensionAPI reference.
 */
export function registerCompleteImplementationTool(pi: ExtensionAPI): void {
  pi.registerTool({
    name: "complete_implementation",
    label: "Complete Implementation",
    description:
      "Finalize implementation. Ends the implementing phase and returns " +
      "the workflow to idle. Call this ONLY after all behaviors are done. " +
      "Test outcomes are not checked here — the project's commit hooks own verification.",

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
      // T8: FULL GATE — the orchestrator runs ALL suites unfiltered before
      // completion; red blocks completion, naming the failing suite and its
      // output tail. Runs outside any unit's tool call.
      const suites = state.testTool?.suites ?? [];
      if (suites.length > 0) {
        const gate = await runTestGate(pi, ctx.cwd, suites);
        if (!gate.passed) {
          const failing = gate.suites.filter((s) => !s.passed);
          const detail = failing
            .map((s) => `### ${s.label} (FAIL) — output tail\n\n${s.tail}`)
            .join("\n\n");
          return {
            content: [
              {
                type: "text",
                text:
                  `Cannot complete: the full test gate is red — ` +
                  `${failing.length}/${gate.suites.length} suite(s) failed.\n\n${detail}\n\n` +
                  `Fix the failing suite and re-run complete_implementation.`,
              },
            ],
            isError: true,
          };
        }
      }
      transitionTo(pi, state, "idle");
      updateUi(null, ctx);
      return {
        content: [{ type: "text", text: "## Implementation Complete\n\nThe workflow has returned to idle." }],
      };
    },
  });
}
