import { describe, it } from "vitest";
import assert from "node:assert/strict";
import { runOrchestratedImplement, type UnitRunner } from "../extensions/implement-loop.ts";
import type { WorkflowState } from "../extensions/state.ts";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

function harness() {
  let head = 0;
  const pi = {
    on: () => {}, registerCommand: () => {}, registerTool: () => {}, appendEntry: () => {},
    sendUserMessage: () => {}, getActiveTools: () => ["read"], getAllTools: () => [{ name: "read" }],
    setActiveTools: () => {},
    exec: async (cmd: string, args: string[]) => {
      if (cmd === "git" && args[0] === "rev-parse") return { stdout: `head${head}\n`, stderr: "", code: 0, killed: false };
      if (cmd === "git" && args[0] === "commit") head++;
      return { stdout: "", stderr: "", code: 0, killed: false };
    },
  } as unknown as ExtensionAPI;
  const state: WorkflowState = {
    phase: "finalizing", specText: "topic",
    task: {
      title: "t", instruction: "do", files: [{ path: "src/a.ts", status: "M" }], done: "green",
      behaviors: [{ id: "T1", description: "b", expectedOutput: "e", kind: "test", status: "active" }],
    },
  };
  const ctx = {
    cwd: "/tmp/test",
    sessionManager: { getBranch: () => [{ type: "custom", customType: "workflow-state", data: state }] },
    ui: { notify: () => {}, setStatus: () => {}, setWidget: () => {}, setTitle: () => {}, theme: { fg: (_c: string, t: string) => t }, addAutocompleteProvider: () => {} },
  } as unknown as ExtensionContext;
  return { pi, state, ctx };
}

describe("timeout retry thinking floor (T14)", () => {
  it("a retry after a timed-out attempt carries no thinking floor", async () => {
    const { pi, state, ctx } = harness();
    const thinking: Array<string | undefined> = [];
    const runner: UnitRunner = async (unit) => {
      thinking.push((unit as { thinking?: string }).thinking);
      if (thinking.length === 1) return { summary: "", error: "timed out after 900000ms", timedOut: true };
      return { summary: "done", suggestedCommit: "feat(core): add" };
    };
    const result = await runOrchestratedImplement(pi, ctx, state, state.task!, runner);
    assert.equal(result.complete, true);
    assert.equal(thinking.length, 2);
    assert.equal(thinking[1], undefined);
  });

  it("retries after unit errors escalate to medium then high", async () => {
    const { pi, state, ctx } = harness();
    const thinking: Array<string | undefined> = [];
    const runner: UnitRunner = async (unit) => {
      thinking.push((unit as { thinking?: string }).thinking);
      if (thinking.length <= 2) return { summary: "", error: "boom" };
      return { summary: "done", suggestedCommit: "feat(core): add" };
    };
    const result = await runOrchestratedImplement(pi, ctx, state, state.task!, runner);
    assert.equal(result.complete, true);
    assert.deepEqual(thinking.slice(1), ["medium", "high"]);
  });
});
