import { describe, it } from "vitest";
import assert from "node:assert/strict";
import {
  runImplement,
  registerRunTestsTool,
  registerMarkTaskDoneTool,
  registerCompleteImplementationTool,
} from "../extensions/implement.ts";
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
      setTitle: () => {},
      theme: { fg: (_c: string, t: string) => t },
      addAutocompleteProvider: () => {},
    },
  } as unknown as ExtensionContext;
}

function finalizingState(): WorkflowState {
  return {
    phase: "finalizing",
    specText: "topic",
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
  it("transitions finalizing → implementing and consumes state.task (T2)", async () => {
    const pi = mockPi();
    const state = finalizingState();
    const ctx = ctxWithState(state);

    await runImplement("", pi, ctx);

    assert.equal(state.phase, "implementing");
    const append = pi.calls["appendEntry"] ?? [];
    const [, saved] = append[append.length - 1] as [string, WorkflowState];
    assert.equal(saved.phase, "implementing");
  });

  it("sends a steer message", async () => {
    const pi = mockPi();
    const ctx = ctxWithState(finalizingState());

    await runImplement("", pi, ctx);

    const send = pi.calls["sendUserMessage"] ?? [];
    assert.ok(send.length >= 1);
    const [, opts] = send[0] as [string, { deliverAs: string }];
    assert.equal(opts.deliverAs, "steer");
  });

  it("does not touch the active toolset (T1)", async () => {
    const pi = mockPi();
    const ctx = ctxWithState(finalizingState());

    await runImplement("", pi, ctx);

    const setCalls = pi.calls["setActiveTools"] ?? [];
    assert.equal(setCalls.length, 0);
  });

  it("does nothing when not in the finalizing phase", async () => {
    const pi = mockPi();
    const s = finalizingState();
    s.phase = "discussing";
    const ctx = ctxWithState(s);

    await runImplement("", pi, ctx);

    assert.equal(s.phase, "discussing");
    assert.equal((pi.calls["sendUserMessage"] ?? []).length, 0);
  });

  it("appends an Engineer's note when args are provided (T5)", async () => {
    const pi = mockPi();
    const ctx = ctxWithState(finalizingState());

    await runImplement("also wire the retry", pi, ctx);

    const send = pi.calls["sendUserMessage"] ?? [];
    assert.equal(send.length, 1);
    const [text] = send[0] as [string];
    assert.match(text, /## Engineer's note/);
    assert.match(text, /also wire the retry/);
    assert.match(text, /authoritative contract/);
    assert.match(text, /tell the user to run \/finalize/);
  });

  it("sends no note section when args are empty", async () => {
    const pi = mockPi();
    const ctx = ctxWithState(finalizingState());

    await runImplement("", pi, ctx);

    const send = pi.calls["sendUserMessage"] ?? [];
    const [text] = send[0] as [string];
    assert.doesNotMatch(text, /## Engineer's note/);
  });

  it("notifies with the aligned TDD entry message", async () => {
    const pi = mockPi();
    const ctx = ctxWithState(finalizingState());
    const notifyCalls: string[] = [];
    ctx.ui.notify = (msg: string) => {
      notifyCalls.push(msg);
    };

    await runImplement("", pi, ctx);

    assert.equal(notifyCalls.length, 1, "runImplement should notify exactly once");
    assert.match(notifyCalls[0], /Starting TDD implementation/);
    assert.match(notifyCalls[0], /behavior by behavior/);
  });
});

// ═══ tool registration (T8) ═══
describe("implement tool registration", () => {
  it("registers exactly run_tests, mark_task_done, complete_implementation", () => {
    const pi = mockPi();
    registerRunTestsTool(pi);
    registerMarkTaskDoneTool(pi);
    registerCompleteImplementationTool(pi);

    const names = ((pi.calls["registerTool"] ?? []) as Array<[{ name: string }]>)
      .map(([d]) => d.name);
    assert.deepEqual(names.sort(), [
      "complete_implementation",
      "mark_task_done",
      "run_tests",
    ]);
  });

  it("back_to_finalize is not exported from implement.ts (T8)", async () => {
    const mod = await import("../extensions/implement.ts");
    assert.equal(
      (mod as unknown as Record<string, unknown>)["registerBackToFinalizeTool"],
      undefined,
    );
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
    const s = finalizingState();
    s.phase = "implementing";
    const res = await runComplete(s);
    assert.equal(res.isError, true);
    assert.match(res.content[0].text, /active/);
    assert.equal(s.phase, "implementing");
  });

  it("refuses when a test behavior exists but tests are failing", async () => {
    const s = finalizingState();
    s.phase = "implementing";
    s.task!.behaviors[0].status = "done";
    s.lastTestResults = { passed: 1, failed: 2 };
    const res = await runComplete(s);
    assert.equal(res.isError, true);
    assert.match(res.content[0].text, /failing/);
    assert.equal(s.phase, "implementing");
  });

  it("succeeds and returns to idle when all done and tests green", async () => {
    const s = finalizingState();
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
    const s = finalizingState();
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
    const s = finalizingState();
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
