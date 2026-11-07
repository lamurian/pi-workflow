import { describe, it } from "vitest";
import assert from "node:assert/strict";
import { buildSlowTasks, composeCompletionReport, composeHaltReport } from "../extensions/implement-report.ts";
import type { OrchestratorResult } from "../extensions/implement-loop.ts";
import type { ContractV2 } from "../extensions/contract-types.ts";
import type { TaskContract } from "../extensions/state.ts";

const contract = {
  title: "t", instruction: "", done: "",
  sources: [{ path: "a.ts", tasks: ["T1"] }, { path: "b.ts", tasks: ["T2"] }],
  tests: [{ path: "a.test.ts", tasks: ["T1"] }],
  tasks: [
    { id: "T1", description: "", expectedOutput: ["x", "y"], status: "done" },
    { id: "T2", description: "", expectedOutput: ["z"], status: "done" },
  ],
} as unknown as ContractV2;

const sizes: Record<string, number> = { "a.ts": 100, "a.test.ts": 50, "b.ts": 7 };

describe("duration report", () => {
  it("lists only tasks over 7 minutes with calibration facts", () => {
    const slow = buildSlowTasks({ T1: 500, T2: 420 }, contract, (p) => sizes[p] ?? 0);
    assert.deepEqual(slow, [{ taskId: "T1", durationSec: 500, assertions: 2, paths: 2, ownedBytes: 150 }]);
  });

  it("renders slow tasks in completion and halt reports", () => {
    const slowTasks = buildSlowTasks({ T1: 500 }, contract, (p) => sizes[p] ?? 0);
    const result: OrchestratorResult = {
      complete: true, unitsRun: 1, landedCommits: [], satisfiedWithoutCommit: [], slowTasks,
    };
    const task = { behaviors: [] } as unknown as TaskContract;
    const line = "- T1: 8m 20s, 2 assertions, 2 paths, 150 bytes owned";
    assert.ok(composeCompletionReport(result, task).includes(line));
    assert.ok(composeHaltReport({ ...result, complete: false, haltedOn: "T1", error: "e" }).includes(line));
  });
});
