import { describe, it } from "vitest";
import assert from "node:assert/strict";
import { registerSaveTaskTool, runFinalize } from "../extensions/finalize.ts";
import type { WorkflowState } from "../extensions/state.ts";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

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
        state ? [{ type: "custom", customType: "workflow-state", data: state }] : [],
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

function discussingState(): WorkflowState {
  return { phase: "discussing", specText: "topic" };
}

function getSaveTask(pi: ExtensionAPI & { calls: Record<string, unknown[]> }) {
  const entries = (pi.calls["registerTool"] ?? []) as Array<[{ name: string; execute: Function }]>;
  return entries.find(([d]) => d.name === "save_task")![0];
}

const VALID = {
  title: "My Task",
  instruction: "do the thing",
  files: ["src/a.ts"],
  done: "tests pass",
  behaviors: [
    { id: "T1", description: "x", expectedOutput: "y", kind: "test", status: "active" },
  ],
};

describe("save_task", () => {
  it("transitions discussing → finalizing on a valid payload (T2)", async () => {
    const pi = mockPi();
    registerSaveTaskTool(pi);
    const s = discussingState();
    const ctx = ctxWithState(s);

    const res = await getSaveTask(pi).execute("c1", VALID, undefined, undefined, ctx);

    assert.notEqual(res.isError, true);
    assert.equal(s.phase, "finalizing");
    assert.ok(s.task);
    assert.equal(s.task!.title, "My Task");
  });

  it("result message says read-only and wait for the user to run /implement (T3)", async () => {
    const pi = mockPi();
    registerSaveTaskTool(pi);
    const s = discussingState();
    const ctx = ctxWithState(s);

    const res = await getSaveTask(pi).execute("c1", VALID, undefined, undefined, ctx);

    assert.match(res.content[0].text, /Phase: finalizing/);
    assert.match(res.content[0].text, /Wait for the user to run \/implement/);
  });

  it("rejects a malformed payload and stays in discussing", async () => {
    const pi = mockPi();
    registerSaveTaskTool(pi);
    const s = discussingState();
    const ctx = ctxWithState(s);

    const res = await getSaveTask(pi).execute(
      "c1",
      { ...VALID, behaviors: [{ id: "T1", description: "x", expectedOutput: "y", kind: "bad" }] },
      undefined,
      undefined,
      ctx,
    );

    assert.equal(res.isError, true);
    assert.match(res.content[0].text, /rejected/);
    assert.equal(s.phase, "discussing");
    assert.equal(s.task, undefined);
  });

  it("is idempotent: updates the contract when already finalizing", async () => {
    const pi = mockPi();
    registerSaveTaskTool(pi);
    const s = discussingState();
    const ctx = ctxWithState(s);
    const tool = getSaveTask(pi);

    await tool.execute("c1", VALID, undefined, undefined, ctx);
    assert.equal(s.phase, "finalizing");

    const updated = { ...VALID, title: "Renamed" };
    const res = await tool.execute("c2", updated, undefined, undefined, ctx);
    assert.notEqual(res.isError, true);
    assert.equal(s.phase, "finalizing");
    assert.equal(s.task!.title, "Renamed");
  });

  it("notifies once on the discussing -> finalizing entry", async () => {
    const pi = mockPi();
    registerSaveTaskTool(pi);
    const s = discussingState();
    const ctx = ctxWithState(s);
    const notifyCalls: string[] = [];
    ctx.ui.notify = (msg: string) => {
      notifyCalls.push(msg);
    };

    await getSaveTask(pi).execute("c1", VALID, undefined, undefined, ctx);

    assert.equal(notifyCalls.length, 1, "entry save should notify exactly once");
    assert.match(notifyCalls[0], /finalizing/);
    assert.ok(notifyCalls[0].includes("/implement"));
  });

  it("stays silent on contract updates while already finalizing", async () => {
    const pi = mockPi();
    registerSaveTaskTool(pi);
    const s = discussingState();
    const ctx = ctxWithState(s);
    await getSaveTask(pi).execute("c1", VALID, undefined, undefined, ctx);

    const notifyCalls: string[] = [];
    ctx.ui.notify = (msg: string) => {
      notifyCalls.push(msg);
    };
    await getSaveTask(pi).execute("c2", { ...VALID, title: "Renamed" }, undefined, undefined, ctx);

    assert.equal(notifyCalls.length, 0, "update saves while finalizing must stay silent");
    assert.equal(s.task!.title, "Renamed");
  });

  it("rejects when not in a workflow phase", async () => {
    const pi = mockPi();
    registerSaveTaskTool(pi);
    const ctx = ctxWithState(null);

    const res = await getSaveTask(pi).execute("c1", VALID, undefined, undefined, ctx);

    assert.equal(res.isError, true);
    assert.match(res.content[0].text, /discussing or finalizing/);
  });

  it("does not touch the active toolset (T1)", async () => {
    const pi = mockPi();
    registerSaveTaskTool(pi);
    const s = discussingState();
    const ctx = ctxWithState(s);

    await getSaveTask(pi).execute("c1", VALID, undefined, undefined, ctx);

    const setCalls = pi.calls["setActiveTools"] ?? [];
    assert.equal(setCalls.length, 0);
  });
});

describe("runFinalize (T5)", () => {
  it("refuses outside the discussing phase", async () => {
    const pi = mockPi();
    const ctx = ctxWithState({ phase: "finalizing", specText: "t" });

    await runFinalize("note", pi, ctx);

    assert.equal((pi.calls["sendUserMessage"] ?? []).length, 0);
  });

  it("appends an Engineer's note when args are provided", async () => {
    const pi = mockPi();
    const ctx = ctxWithState(discussingState());

    await runFinalize("also add T7", pi, ctx);

    const send = pi.calls["sendUserMessage"] ?? [];
    assert.equal(send.length, 1);
    const [text] = send[0] as [string];
    assert.match(text, /## Engineer's note/);
    assert.match(text, /also add T7/);
    assert.match(text, /Fold this note into the contract where relevant/);
  });

  it("sends no note section when args are empty", async () => {
    const pi = mockPi();
    const ctx = ctxWithState(discussingState());

    await runFinalize("", pi, ctx);

    const send = pi.calls["sendUserMessage"] ?? [];
    assert.equal(send.length, 1);
    const [text] = send[0] as [string];
    assert.doesNotMatch(text, /## Engineer's note/);
  });
});
