import { describe, it } from "vitest";
import assert from "node:assert/strict";
import { setTaskStatus } from "../extensions/task-status.ts";
import { registerMarkTaskDoneTool } from "../extensions/implement-tools.ts";
import { runSaveTask } from "../extensions/save-task-core.ts";
import type { WorkflowState } from "../extensions/state.ts";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

interface Harness {
  pi: ExtensionAPI;
  ctx: ExtensionContext;
  tools: Map<string, { execute: (...a: unknown[]) => Promise<{ isError?: boolean }> }>;
}

function harness(initial: WorkflowState): Harness {
  const branch: unknown[] = [{ type: "custom", customType: "workflow-state", data: initial }];
  const tools = new Map();
  const pi = {
    appendEntry: (customType: string, data: unknown) =>
      branch.push({ type: "custom", customType, data: structuredClone(data) }),
    getActiveTools: () => [],
    setActiveTools: () => {},
    registerTool: (t: { name: string }) => tools.set(t.name, t),
    exec: async () => ({ stdout: "", stderr: "", code: 1, killed: false }),
  } as unknown as ExtensionAPI;
  const ctx = {
    cwd: "/tmp/test",
    sessionManager: { getBranch: () => branch },
    ui: {
      notify: () => {},
      setStatus: () => {},
      setWidget: () => {},
      setTitle: () => {},
      theme: { fg: (_c: string, t: string) => t },
    },
  } as unknown as ExtensionContext;
  return { pi, ctx, tools };
}

const PAYLOAD = {
  title: "T",
  instruction: "i",
  done: "d",
  sources: [{ path: "src/a.ts", tasks: ["T1"] }],
  tests: [{ path: "tests/a.test.ts", tasks: ["T1"] }],
  tasks: [{ id: "T1", description: "x", expectedOutput: ["y"], status: "active" }],
};

describe("setTaskStatus", () => {
  it("sets status on contractV2 task and task behavior", () => {
    const s = {
      phase: "implementing",
      contractV2: { tasks: [{ id: "T1", description: "x", expectedOutput: ["y"], status: "active" }] },
      task: { behaviors: [{ id: "T1", description: "x", expectedOutput: "y", kind: "test", status: "active" }] },
    } as unknown as WorkflowState;
    setTaskStatus(s, "T1", "done");
    assert.equal(s.contractV2!.tasks[0]!.status, "done");
    assert.equal(s.task!.behaviors[0]!.status, "done");
  });

  it("updates only the view when contractV2 is absent", () => {
    const s = {
      phase: "implementing",
      task: { behaviors: [{ id: "T1", description: "x", expectedOutput: "y", kind: "test", status: "active" }] },
    } as unknown as WorkflowState;
    assert.doesNotThrow(() => setTaskStatus(s, "T1", "done"));
    assert.equal(s.task!.behaviors[0]!.status, "done");
  });

  it("mark_task_done status survives a re-save with same description and expectedOutput", async () => {
    const s: WorkflowState = { phase: "discussing", specText: "t" };
    const h0 = harness(s);
    const saved = await runSaveTask(s, PAYLOAD, { caller: "agent", pi: h0.pi, ctx: h0.ctx });
    assert.equal(saved.ok, true, saved.text);
    s.phase = "implementing";
    const h = harness(s);
    registerMarkTaskDoneTool(h.pi);
    const res = await h.tools.get("mark_task_done")!.execute("id", { behaviorId: "T1", evidence: "e" }, undefined, undefined, h.ctx);
    assert.notEqual(res.isError, true);
    assert.equal(s.contractV2!.tasks[0]!.status, "done");
    s.phase = "finalizing";
    const again = await runSaveTask(s, PAYLOAD, { caller: "agent", pi: h.pi, ctx: h.ctx });
    assert.equal(again.ok, true, again.text);
    assert.equal(s.contractV2!.tasks[0]!.status, "done");
    assert.equal(s.task!.behaviors[0]!.status, "done");
  });
});
