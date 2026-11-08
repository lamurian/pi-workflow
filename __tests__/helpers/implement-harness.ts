import assert from "node:assert/strict";
import { runImplement } from "../../extensions/implement.ts";
import type { OrchestratorResult, UnitRunner } from "../../extensions/implement-loop.ts";
import type { WorkflowState } from "../../extensions/state.ts";
import type {
  ExtensionAPI,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";

/** Default active tool names used by mockPi. */
export const DEFAULT_ACTIVE_TOOLS = ["read", "bash", "write", "edit", "commit_changes"];

/**
 * Build a mock ExtensionAPI that records calls.
 * @param activeTools - Tool names reported as active.
 * @returns Mock API with a `calls` record.
 */
export function mockPi(activeTools: string[] = DEFAULT_ACTIVE_TOOLS): ExtensionAPI & { calls: Record<string, unknown[]> } {
  const calls: Record<string, unknown[]> = {};
  const record = (name: string) => {
    calls[name] = [];
    return (...args: unknown[]) => {
      calls[name]!.push(args);
    };
  };
  return {
    on: record("on") as ExtensionAPI["on"],
    registerCommand: record("registerCommand") as ExtensionAPI["registerCommand"],
    registerTool: record("registerTool") as ExtensionAPI["registerTool"],
    appendEntry: record("appendEntry") as ExtensionAPI["appendEntry"],
    sendUserMessage: record("sendUserMessage") as ExtensionAPI["sendUserMessage"],
    getActiveTools: () => [...activeTools],
    getAllTools: () => activeTools.map((name) => ({ name })),
    setActiveTools: record("setActiveTools") as ExtensionAPI["setActiveTools"],
    exec: async () => ({ stdout: "", stderr: "", code: 0, killed: false }),
    calls,
  } as unknown as ExtensionAPI & { calls: typeof calls };
}

/**
 * Build a mock context whose session branch carries the given state.
 * @param state - Workflow state or null.
 * @returns Mock extension context.
 */
export function ctxWithState(state: WorkflowState | null): ExtensionContext {
  return {
    cwd: "/tmp/test",
    sessionManager: {
      getBranch: () =>
        state
          ? [{ type: "custom", customType: "workflow-state", data: state }]
          : [],
    },
    ui: {
      notify: () => {},
      setStatus: () => {},
      setWidget: () => {},
      setTitle: () => {},
      theme: { fg: (_c: string, t: string) => t },
      addAutocompleteProvider: () => {},
    },
  } as unknown as ExtensionContext;
}

/**
 * Build a minimal finalizing-phase workflow state.
 * @returns Workflow state with one active test behavior.
 */
export function finalizingState(): WorkflowState {
  return {
    phase: "finalizing",
    specText: "topic",
    task: {
      title: "My Task",
      instruction: "do the thing",
      files: [{ path: "src/a.ts", status: "M" }],
      done: "tests pass",
      behaviors: [
        { id: "T1", description: "x", expectedOutput: "y", kind: "test", status: "active" },
      ],
    },
  };
}

/**
 * Find a registered tool definition by name.
 * @param pi   - Mock API with recorded calls.
 * @param name - Tool name.
 * @returns The tool definition or undefined.
 */
export function getTool(pi: ExtensionAPI & { calls: Record<string, unknown[]> }, name: string) {
  const entries = (pi.calls["registerTool"] ?? []) as Array<[{ name: string; execute: Function }]>;
  return entries.find(([d]) => d.name === name)?.[0];
}

/**
 * Run the orchestrated /implement path (B1 fire-and-forget): launch through
 * runImplement, capture the background promise via the onBackground seam,
 * and await settlement before returning so assertions see loop outcomes.
 *
 * @param pi     - ExtensionAPI reference (mock with recorded calls).
 * @param ctx    - Extension context carrying the workflow state.
 * @param runner - Unit runner injected into the orchestrator loop.
 * @param args   - Optional /implement args (defaults to "").
 * @returns The settled orchestrator result.
 */
export async function runOrchestratedViaSeam(
  pi: ExtensionAPI,
  ctx: ExtensionContext,
  runner: UnitRunner,
  args = "",
): Promise<OrchestratorResult> {
  let settled: Promise<OrchestratorResult> | undefined;
  await runImplement(args, pi, ctx, runner, (background) => {
    settled = background;
  });
  assert.ok(settled, "onBackground seam must receive the background promise");
  return settled;
}
