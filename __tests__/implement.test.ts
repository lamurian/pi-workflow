import { describe, it } from "vitest";
import assert from "node:assert/strict";
import {
  runImplement,
  registerRunTestsTool,
  registerMarkTaskDoneTool,
  registerBackToFinalizeTool,
  registerCompleteImplementationTool,
} from "../extensions/implement.ts";
import { applyDiscussTools, resetToolsState } from "../extensions/tools.ts";
import type { WorkflowState } from "../extensions/state.ts";
import type {
  ExtensionAPI,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";

const DEFAULT_ACTIVE_TOOLS = ["read", "bash", "write", "edit", "commit_changes"];

function mockPi(activeTools: string[] = DEFAULT_ACTIVE_TOOLS): ExtensionAPI & { calls: Record<string, unknown[]> } {
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
    setActiveTools: record("setActiveTools") as ExtensionAPI["setActiveTools"],
    exec: async () => ({ stdout: "", stderr: "", exitCode: 0 }),
    calls,
  } as unknown as ExtensionAPI & { calls: typeof calls };
}

function ctxWithState(state: WorkflowState | null): ExtensionContext {
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
      theme: { fg: () => "" },
      addAutocompleteProvider: () => {},
    },
  } as unknown as ExtensionContext;
}

function finalizedState(): WorkflowState {
  return {
    phase: "finalized",
    specText: "topic",
    returnCount: 0,
    task: {
      title: "My Task",
      instruction: "do the thing",
      files: ["src/a.ts"],
      done: "tests pass",
      behaviors: [
        { id: "T1", description: "x", expectedOutput: "y", kind: "test", status: "active" },
      ],
    },
  };
}

function getTool(pi: ExtensionAPI & { calls: Record<string, unknown[]> }, name: string) {
  const entries = (pi.calls["registerTool"] ?? []) as Array<[{ name: string; execute: Function }]>;
  return entries.find(([d]) => d.name === name)?.[0];
}

// ═══ runImplement ═══
describe("runImplement", () => {
  it("transitions finalized → implementing and consumes state.task", async () => {
    resetToolsState();
    const pi = mockPi();
    const state = finalizedState();
    const ctx = ctxWithState(state);
    applyDiscussTools(pi); // simulate gated phase

    await runImplement(pi, ctx);

    assert.equal(state.phase, "implementing");
    const append = pi.calls["appendEntry"] ?? [];
    const [, saved] = append[append.length - 1] as [string, WorkflowState];
    assert.equal(saved.phase, "implementing");
  });

  it("sends a steer message", async () => {
    resetToolsState();
    const pi = mockPi();
    const ctx = ctxWithState(finalizedState());

    await runImplement(pi, ctx);

    const send = pi.calls["sendUserMessage"] ?? [];
    assert.ok(send.length >= 1);
    const [, opts] = send[0] as [string, { deliverAs: string }];
    assert.equal(opts.deliverAs, "steer");
  });

  it("restores the full toolset when implementing starts", async () => {
    resetToolsState();
    const pi = mockPi();
    const ctx = ctxWithState(finalizedState());
    applyDiscussTools(pi);

    await runImplement(pi, ctx);

    const setCalls = pi.calls["setActiveTools"] ?? [];
    const [restored] = setCalls[setCalls.length - 1] as [string[]];
    assert.deepEqual(restored, DEFAULT_ACTIVE_TOOLS);
  });

  it("does nothing when not in the finalized phase", async () => {
    resetToolsState();
    const pi = mockPi();
    const s = finalizedState();
    s.phase = "discussing";
    const ctx = ctxWithState(s);

    await runImplement(pi, ctx);

    assert.equal(s.phase, "discussing");
    assert.equal((pi.calls["sendUserMessage"] ?? []).length, 0);
  });
});

// ═══ tool registration ═══
describe("implement tool registration", () => {
  it("registers run_tests, mark_task_done, back_to_finalize, complete_implementation", () => {
    const pi = mockPi();
    registerRunTestsTool(pi);
    registerMarkTaskDoneTool(pi);
    registerBackToFinalizeTool(pi);
    registerCompleteImplementationTool(pi);

    for (const name of ["run_tests", "mark_task_done", "back_to_finalize", "complete_implementation"]) {
      assert.ok(getTool(pi, name), `${name} should be registered`);
    }
  });
});

// ═══ complete_implementation gate ═══
describe("complete_implementation", () => {
  async function runComplete(state: WorkflowState) {
    const pi = mockPi();
    registerCompleteImplementationTool(pi);
    const ctx = ctxWithState(state);
    return getTool(pi, "complete_implementation")!.execute("c1", {}, undefined, undefined, ctx);
  }

  it("refuses while a behavior is still active", async () => {
    const s = finalizedState();
    s.phase = "implementing";
    const res = await runComplete(s);
    assert.equal(res.isError, true);
    assert.match(res.content[0].text, /active/);
    assert.equal(s.phase, "implementing");
  });

  it("refuses when a test behavior exists but tests are failing", async () => {
    const s = finalizedState();
    s.phase = "implementing";
    s.task!.behaviors[0].status = "done";
    s.lastTestResults = { passed: 1, failed: 2 };
    const res = await runComplete(s);
    assert.equal(res.isError, true);
    assert.match(res.content[0].text, /failing/);
    assert.equal(s.phase, "implementing");
  });

  it("succeeds and returns to idle when all done and tests green", async () => {
    const s = finalizedState();
    s.phase = "implementing";
    s.task!.behaviors[0].status = "done";
    s.lastTestResults = { passed: 3, failed: 0 };
    const res = await runComplete(s);
    assert.notEqual(res.isError, true);
    assert.equal(s.phase, "idle");
  });
});

// ═══ mark_task_done ═══
describe("mark_task_done", () => {
  it("marks a behavior done", async () => {
    const pi = mockPi();
    registerMarkTaskDoneTool(pi);
    const s = finalizedState();
    s.phase = "implementing";
    const ctx = ctxWithState(s);

    const res = await getTool(pi, "mark_task_done")!.execute(
      "c1",
      { behaviorId: "T1", evidence: "tests passed" },
      undefined,
      undefined,
      ctx,
    );

    assert.notEqual(res.isError, true);
    assert.equal(s.task!.behaviors[0].status, "done");
  });

  it("rejects a behaviorId not in the contract", async () => {
    const pi = mockPi();
    registerMarkTaskDoneTool(pi);
    const s = finalizedState();
    s.phase = "implementing";
    const ctx = ctxWithState(s);

    const res = await getTool(pi, "mark_task_done")!.execute(
      "c1",
      { behaviorId: "T99", evidence: "x" },
      undefined,
      undefined,
      ctx,
    );

    assert.equal(res.isError, true);
    assert.match(res.content[0].text, /not in contract/);
  });
});
