import { describe, it } from "vitest";
import assert from "node:assert/strict";
import { runSaveTask } from "../extensions/save-task-core.ts";
import type { WorkflowState } from "../extensions/state.ts";
import type { ContractV2 } from "../extensions/contract-types.ts";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

function mockPi(log: string[] = []): ExtensionAPI {
  const noop = () => {};
  return {
    appendEntry: noop,
    getActiveTools: () => [],
    setActiveTools: noop,
    exec: async (cmd: string, args: string[]) => {
      log.push([cmd, ...args].join(" "));
      return { stdout: "", stderr: "", code: 0, killed: false };
    },
  } as unknown as ExtensionAPI;
}

function mockCtx(): ExtensionContext {
  return {
    cwd: "/tmp/test-split-none",
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

function contract(): ContractV2 {
  return {
    title: "T",
    instruction: "i",
    done: "d",
    sources: [
      { path: "src/a.ts", tasks: ["T1"] },
      { path: "src/b.ts", tasks: ["T1", "T2"] },
      { path: "src/c.ts", tasks: ["T2"] },
    ],
    tests: [
      { path: "tests/a.test.ts", tasks: ["T1"] },
      { path: "tests/c.test.ts", tasks: ["T2"] },
    ],
    tasks: [
      { id: "T1", description: "one", expectedOutput: ["a1", "a2"], status: "active" },
      { id: "T2", description: "two", expectedOutput: ["b1"], status: "active" },
    ],
  };
}

const KIDS = [
  { description: "one-a", expectedOutput: ["a1"], paths: ["src/a.ts", "tests/a.test.ts"] },
  { description: "one-b", expectedOutput: ["a2"], paths: ["src/b.ts", "tests/a.test.ts"] },
];

function state(phase: WorkflowState["phase"] = "finalizing"): WorkflowState {
  return { phase, specText: "t", contractV2: contract() };
}

const split = (s: WorkflowState, tasks: unknown, caller: "agent" | "orchestrator" = "agent", parentId = "T1") =>
  runSaveTask(s, { operation: "split", parentId, tasks }, { caller, pi: mockPi(), ctx: mockCtx() });

describe("save_task split", () => {
  it("replaces the parent in place and rewrites path refs", async () => {
    const s = state();
    const res = await split(s, KIDS);
    assert.equal(res.ok, true, res.text);
    const c = s.contractV2!;
    assert.deepEqual(c.tasks.map((t) => t.id), ["T1.1", "T1.2", "T2"]);
    assert.deepEqual(c.tasks[2], contract().tasks[1]);
    assert.deepEqual(c.sources.map((e) => e.tasks), [["T1.1"], ["T1.2", "T2"], ["T2"]]);
    assert.deepEqual(c.tests.map((e) => e.tasks), [["T1.1", "T1.2"], ["T2"]]);
  });

  const bad: [string, unknown, string?][] = [
    ["drops", [KIDS[0], { ...KIDS[1], expectedOutput: [] }]],
    ["drops2", [KIDS[0], { ...KIDS[1], expectedOutput: ["a1"] }]],
    ["rewords", [KIDS[0], { ...KIDS[1], expectedOutput: ["a2 changed"] }]],
    ["duplicates", [KIDS[0], { ...KIDS[1], expectedOutput: ["a2", "a1"] }]],
    ["adds a path", [KIDS[0], { ...KIDS[1], paths: ["src/b.ts", "src/new.ts"] }]],
    ["adds a command", [KIDS[0], { ...KIDS[1], commands: ["deploy"] }]],
    ["leaves a path unowned", [KIDS[0], { ...KIDS[1], paths: ["tests/a.test.ts"] }]],
  ];
  for (const [name, kids] of bad) {
    it(`rejects a proposal that ${name}`, async () => {
      const s = state();
      const res = await split(s, kids);
      assert.equal(res.ok, false);
      assert.deepEqual(s.contractV2, contract());
    });
  }

  it("rejects splitting a split child", async () => {
    const s = state();
    assert.equal((await split(s, KIDS)).ok, true);
    const res = await split(s, [
      { description: "x", expectedOutput: ["a1"], paths: ["src/a.ts"] },
      { description: "y", expectedOutput: ["a1"], paths: ["tests/a.test.ts"] },
    ], "agent", "T1.1");
    assert.equal(res.ok, false);
    assert.match(res.text, /split child/);
  });

  it("is allowed for agent in finalizing and orchestrator in implementing only", async () => {
    const f = state("finalizing");
    assert.equal((await split(f, KIDS, "agent")).ok, true);
    assert.equal(f.phase, "finalizing");
    const i = state("implementing");
    assert.equal((await split(i, KIDS, "orchestrator")).ok, true);
    assert.equal(i.phase, "implementing");
    assert.equal((await split(state("implementing"), KIDS, "agent")).ok, false);
    assert.equal((await split(state("discussing"), KIDS, "agent")).ok, false);
    assert.equal((await split(state("discussing"), KIDS, "orchestrator")).ok, false);
  });

  it("skips the scan and test tool generation", async () => {
    const s = state();
    const log: string[] = [];
    const res = await runSaveTask(
      s,
      { operation: "split", parentId: "T1", tasks: KIDS },
      { caller: "agent", pi: mockPi(log), ctx: mockCtx() },
    );
    assert.equal(res.ok, true, res.text);
    assert.equal(s.testTool, undefined);
    assert.equal(s.runPlan, undefined);
    assert.equal(s.scanDigest, undefined);
    assert.ok(log.every((l) => l.startsWith("git ls-tree")), log.join("\n"));
  });
});
