import { describe, it } from "vitest";
import assert from "node:assert/strict";
import { runSaveTask } from "../extensions/save-task-core.ts";
import type { WorkflowState } from "../extensions/state.ts";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

function mockPi(): ExtensionAPI {
  const noop = () => {};
  return {
    appendEntry: noop,
    getActiveTools: () => [],
    setActiveTools: noop,
    exec: async () => ({ stdout: "", stderr: "", code: 0, killed: false }),
  } as unknown as ExtensionAPI;
}

function mockCtx(): ExtensionContext {
  return {
    cwd: "/tmp/test",
    sessionManager: { getBranch: () => [] },
    ui: {
      notify: () => {},
      setStatus: () => {},
      setWidget: () => {},
      setTitle: () => {},
      theme: { fg: (_c: string, t: string) => t },
    },
  } as unknown as ExtensionContext;
}

interface TaskDraft {
  id: string;
  description: string;
  expectedOutput: string[];
  status?: string;
  commit?: string;
}

function payload(tasks: TaskDraft[]) {
  return {
    title: "T",
    instruction: "i",
    done: "d",
    sources: [{ path: "src/a.ts", tasks: [tasks[0]!.id] }],
    tests: [{ path: "tests/a.test.ts", tasks: [tasks[0]!.id] }],
    tasks,
  };
}

async function save(tasks: TaskDraft[]) {
  const state: WorkflowState = { phase: "discussing", specText: "t" };
  const res = await runSaveTask(state, payload(tasks), {
    caller: "agent",
    pi: mockPi(),
    ctx: mockCtx(),
  });
  return { state, res };
}

describe("save_task per-task commit field", () => {
  const badCommits: { name: string; commit: string; rule: RegExp }[] = [
    {
      name: "multi-line",
      commit: "feat(save): first line\nsecond line",
      rule: /single line/,
    },
    {
      name: "longer than 75 characters",
      commit: "feat(save): " + "x".repeat(70),
      rule: /75 characters/,
    },
    {
      name: "not in conventional form",
      commit: "just a message",
      rule: /conventional/,
    },
    {
      name: "containing a declared task id",
      commit: "feat(save): implement T1 now",
      rule: /task id/,
    },
  ];
  for (const c of badCommits) {
    it(`rejects a commit ${c.name}, naming the task and the violated rule`, async () => {
      const { state, res } = await save([
        { id: "T1", description: "x", expectedOutput: ["y"], commit: c.commit },
      ]);
      assert.equal(res.ok, false, res.text);
      assert.match(res.text, /save_task rejected/);
      assert.match(res.text, /T1/);
      assert.match(res.text, c.rule);
      assert.equal(state.contractV2, undefined);
    });
  }

  it("rejects two non-removed tasks sharing a commit, naming both ids", async () => {
    const shared = "feat(shared): same message";
    const { state, res } = await save([
      { id: "T1", description: "x", expectedOutput: ["y"], commit: shared },
      { id: "T2", description: "z", expectedOutput: ["w"], commit: shared },
    ]);
    assert.equal(res.ok, false, res.text);
    assert.match(res.text, /T1/);
    assert.match(res.text, /T2/);
    assert.match(res.text, /share the same commit/);
    assert.equal(state.contractV2, undefined);
  });

  it("allows a removed task to share a commit with an active one", async () => {
    const shared = "feat(shared): same message";
    const { res } = await save([
      { id: "T1", description: "x", expectedOutput: ["y"], commit: shared },
      { id: "T2", description: "z", expectedOutput: ["inspect: the removed task keeps the shared commit"], status: "removed", commit: shared },
    ]);
    assert.equal(res.ok, true, res.text);
  });

  it("persists a valid task commit on the saved contract task", async () => {
    const commit = "feat(save-task): add per-task commit field";
    const { state, res } = await save([
      { id: "T1", description: "x", expectedOutput: ["y"], commit },
      { id: "T2", description: "z", expectedOutput: ["inspect: the distinct commit lands on the saved task"], commit: "fix(save): distinct message" },
    ]);
    assert.equal(res.ok, true, res.text);
    assert.equal(state.contractV2?.tasks[0]?.commit, commit);
    assert.equal(state.contractV2?.tasks[1]?.commit, "fix(save): distinct message");
  });
});
