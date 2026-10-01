import { describe, it } from "vitest";
import assert from "node:assert/strict";
import { registerSaveTaskTool } from "../extensions/finalize.ts";
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
      theme: { fg: () => "" },
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
  it("transitions discussing → finalized on a valid payload", async () => {
    const pi = mockPi();
    registerSaveTaskTool(pi);
    const s = discussingState();
    const ctx = ctxWithState(s);

    const res = await getSaveTask(pi).execute("c1", VALID, undefined, undefined, ctx);

    assert.notEqual(res.isError, true);
    assert.equal(s.phase, "finalized");
    assert.ok(s.task);
    assert.equal(s.task!.title, "My Task");
    assert.equal(s.returnCount, 0);
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

  it("is idempotent: updates the contract when already finalized", async () => {
    const pi = mockPi();
    registerSaveTaskTool(pi);
    const s = discussingState();
    const ctx = ctxWithState(s);
    const tool = getSaveTask(pi);

    await tool.execute("c1", VALID, undefined, undefined, ctx);
    assert.equal(s.phase, "finalized");

    const updated = { ...VALID, title: "Renamed" };
    const res = await tool.execute("c2", updated, undefined, undefined, ctx);
    assert.notEqual(res.isError, true);
    assert.equal(s.phase, "finalized");
    assert.equal(s.task!.title, "Renamed");
  });

  it("rejects when not in a workflow phase", async () => {
    const pi = mockPi();
    registerSaveTaskTool(pi);
    const ctx = ctxWithState(null);

    const res = await getSaveTask(pi).execute("c1", VALID, undefined, undefined, ctx);

    assert.equal(res.isError, true);
    assert.match(res.content[0].text, /discussing or finalized/);
  });
});
