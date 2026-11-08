import { describe, it } from "vitest";
import assert from "node:assert/strict";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { captureBaselineFailures } from "../extensions/baseline-failures.ts";
import type { WorkflowState } from "../extensions/state.ts";
import type { TestSuite } from "../extensions/test-tool-detect.ts";

const A: TestSuite = { label: "a", argv: ["npm", "test"] };
const B: TestSuite = { label: "b", argv: ["npx", "vitest"] };

interface ExecResult {
  stdout: string;
  stderr: string;
  code: number;
  killed: boolean;
}

function mockPi(
  results: ExecResult[],
): ExtensionAPI & { calls: string[]; saved: WorkflowState[] } {
  const calls: string[] = [];
  const saved: WorkflowState[] = [];
  let i = 0;
  return {
    exec: (async (cmd: string) => {
      calls.push(cmd);
      return results[i++] ?? { stdout: "", stderr: "", code: 0, killed: false };
    }) as ExtensionAPI["exec"],
    appendEntry: ((_t: string, data: WorkflowState) => {
      saved.push(structuredClone(data));
    }) as ExtensionAPI["appendEntry"],
    calls,
    saved,
  } as unknown as ExtensionAPI & { calls: string[]; saved: WorkflowState[] };
}

function state(extra: Partial<WorkflowState>): WorkflowState {
  return { ...extra } as WorkflowState;
}

describe("captureBaselineFailures", () => {
  it("stores sorted unique failing paths of red full suites and persists", async () => {
    const pi = mockPi([
      { stdout: "FAIL __tests__/z.test.ts > x\nFAIL __tests__/a.test.ts > y", stderr: "", code: 1, killed: false },
      { stdout: "FAIL __tests__/a.test.ts > q", stderr: "", code: 1, killed: false },
    ]);
    const s = state({ testTool: { source: "detected", suites: [], fullSuites: [A, B] } });
    await captureBaselineFailures(pi, "/repo", s);
    assert.equal(pi.calls.length, 2);
    assert.deepEqual(s.baselineFailures, ["__tests__/a.test.ts", "__tests__/z.test.ts"]);
    assert.equal(pi.saved.length, 1);
    assert.deepEqual(pi.saved[0]?.baselineFailures, s.baselineFailures);
  });

  it("stores an empty array when every full suite is green", async () => {
    const pi = mockPi([]);
    const s = state({ testTool: { source: "detected", suites: [], fullSuites: [A, B] } });
    await captureBaselineFailures(pi, "/repo", s);
    assert.equal(pi.calls.length, 2);
    assert.deepEqual(s.baselineFailures, []);
    assert.equal(pi.saved.length, 1);
  });

  it("runs nothing when baseline already set or no full suites recorded", async () => {
    const pi = mockPi([]);
    const set = state({
      baselineFailures: ["x"],
      testTool: { source: "detected", suites: [], fullSuites: [A] },
    });
    await captureBaselineFailures(pi, "/repo", set);
    assert.deepEqual(set.baselineFailures, ["x"]);
    const none = state({ testTool: { source: "detected", suites: [A], fullSuites: [] } });
    await captureBaselineFailures(pi, "/repo", none);
    await captureBaselineFailures(pi, "/repo", state({}));
    assert.equal(pi.calls.length, 0);
    assert.equal(pi.saved.length, 0);
  });
});
