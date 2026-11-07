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

const VALID = {
  title: "T",
  instruction: "i",
  done: "d",
  sources: [{ path: "src/a.ts", tasks: ["T1"] }],
  tests: [{ path: "tests/a.test.ts", tasks: ["T1"] }],
  tasks: [{ id: "T1", description: "x", expectedOutput: ["y"], status: "active" }],
};

describe("runSaveTask", () => {
  for (const phase of ["discussing", "finalizing"] as const) {
    for (const op of [undefined, "replace"]) {
      it(`succeeds in ${phase} with operation ${op ?? "(none)"}`, async () => {
        const s: WorkflowState = { phase, specText: "t" };
        const payload = op ? { ...VALID, operation: op } : VALID;
        const res = await runSaveTask(s, payload, { caller: "agent", pi: mockPi(), ctx: mockCtx() });
        assert.equal(res.ok, true, res.text);
        assert.equal(s.phase, "finalizing");
      });
    }
  }

  it("rejects in implementing naming allowed phases and operations", async () => {
    const s: WorkflowState = { phase: "implementing", specText: "t" };
    const res = await runSaveTask(s, { ...VALID, operation: "replace" }, {
      caller: "agent",
      pi: mockPi(),
      ctx: mockCtx(),
    });
    assert.equal(res.ok, false);
    assert.match(res.text, /discussing/);
    assert.match(res.text, /finalizing/);
    assert.match(res.text, /replace/);
    assert.equal(s.contractHistory, undefined);
  });

  it("appends a contractHistory entry per successful call", async () => {
    const s: WorkflowState = { phase: "discussing", specText: "t" };
    await runSaveTask(s, VALID, { caller: "agent", pi: mockPi(), ctx: mockCtx() });
    await runSaveTask(s, VALID, { caller: "orchestrator", pi: mockPi(), ctx: mockCtx() });
    assert.equal(s.contractHistory?.length, 2);
    assert.equal(s.contractHistory![0]!.operation, "replace");
    assert.equal(s.contractHistory![0]!.caller, "agent");
    assert.equal(s.contractHistory![1]!.caller, "orchestrator");
    assert.ok(!Number.isNaN(Date.parse(s.contractHistory![1]!.at)));
  });
});
