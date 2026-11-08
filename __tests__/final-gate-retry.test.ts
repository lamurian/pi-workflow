// R2a: final-gate retry — runFinalGate re-runs each red suite once (never
// after an aborted signal), a green re-run records a flaky note naming the
// first run's failing paths, and the completion report lists the gate notes
// recorded on state by scope gates and by the final gate.

import { describe, it } from "vitest";
import assert from "node:assert/strict";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { runFinalGate, runAndPersistFinalGate } from "../extensions/full-gate.ts";
import { generateReport } from "../extensions/implement-report.ts";
import type { WorkflowState } from "../extensions/state.ts";
import type { TestToolInfo } from "../extensions/state-types.ts";
import type { TestSuite } from "../extensions/test-tool-detect.ts";

const GO_SUITE: TestSuite = { label: "go (go test ./...)", argv: ["go", "test", "./..."] };
const JS_SUITE: TestSuite = { label: "javascript (npm run test)", argv: ["npm", "run", "test"] };

interface ExecCall {
  cmd: string;
  args: string[];
  opts: Record<string, unknown>;
}

interface ExecResult {
  stdout: string;
  stderr: string;
  code: number;
  killed: boolean;
}

const OK: ExecResult = { stdout: "ok", stderr: "", code: 0, killed: false };

/**
 * Mock pi recording every exec call (cmd/args/opts); `respond` overrides the
 * per-call result (or throws).
 *
 * @param respond - Optional per-call responder.
 * @returns The mock with its call log.
 */
function mockPi(
  respond?: (call: ExecCall, index: number) => ExecResult | Promise<ExecResult>,
): ExtensionAPI & { calls: ExecCall[] } {
  const calls: ExecCall[] = [];
  return {
    exec: (async (cmd: string, args: string[], opts: Record<string, unknown>) => {
      const call = { cmd, args, opts };
      calls.push(call);
      return respond ? await respond(call, calls.length - 1) : OK;
    }) as ExtensionAPI["exec"],
    appendEntry: (() => undefined) as ExtensionAPI["appendEntry"],
    calls,
  } as unknown as ExtensionAPI & { calls: ExecCall[] };
}

describe("final-gate retry (R2a)", () => {
  it("re-runs each red suite once and passes on a green re-run, recording a flaky note naming the first run's failing paths", async () => {
    const state: WorkflowState = {
      phase: "implementing",
      specText: "topic",
      testTool: { source: "detected", suites: [GO_SUITE, JS_SUITE] },
    };
    let goRuns = 0;
    const pi = mockPi((call) => {
      if (call.cmd === "go") {
        goRuns++;
        return goRuns === 1
          ? { stdout: "", stderr: "FAIL  __tests__/mine.test.ts > suite > test", code: 1, killed: false }
          : OK;
      }
      return OK;
    });

    const run = await runAndPersistFinalGate(pi, "/repo", state);

    assert.equal(
      pi.calls.filter((c) => c.cmd === "go").length,
      2,
      "the red suite runs once, then exactly one re-run",
    );
    assert.equal(pi.calls.filter((c) => c.cmd === "npm").length, 1, "a green suite is not re-run");
    assert.equal(run.passed, true, "the gate passes when the re-run is green");
    assert.ok(
      run.suites.every((s) => s.passed),
      "every recorded suite verdict is green",
    );
    assert.equal(run.notes.length, 1, "exactly one retry note is recorded");
    assert.match(run.notes[0]!, /^flaky: /, "the note is a flaky note");
    assert.match(
      run.notes[0]!,
      /go \(go test \.\/\.\.\.\)/,
      "the note names the re-run suite",
    );
    assert.match(
      run.notes[0]!,
      /__tests__\/mine\.test\.ts/,
      "the note names the first run's failing test path",
    );
    assert.deepEqual(
      state.finalGate?.notes,
      run.notes,
      "the notes land on state.finalGate with the persisted result",
    );
  });

  it("reports an aborted run as not passed without a second exec for that suite", async () => {
    const controller = new AbortController();
    controller.abort();
    const pi = mockPi(() => ({
      stdout: "",
      stderr: "FAIL  __tests__/mine.test.ts > suite > test",
      code: 1,
      killed: false,
    }));

    const run = await runFinalGate(
      pi,
      "/repo",
      { source: "detected", suites: [GO_SUITE] },
      controller.signal,
    );

    assert.equal(run.passed, false, "an aborted run is reported as not passed");
    assert.equal(run.suites[0]!.passed, false, "the aborted suite verdict stays red");
    assert.equal(pi.calls.length, 1, "no second exec runs after the aborted signal");
    assert.deepEqual(run.notes, [], "no retry note is recorded without a re-run");
  });

  it("the completion report lists the flaky and deferred gate notes recorded by scope gates and by the final gate", () => {
    const scopeFlaky =
      "flaky: javascript (npm run test) failed then passed on re-run: __tests__/a.test.ts";
    const scopeDeferred =
      "foreign: javascript (npm run test) failures outside task tests deferred to final gate: __tests__/other.test.ts";
    const finalFlaky =
      "flaky: go (go test ./...) failed then passed on re-run: __tests__/mine.test.ts";
    const state: WorkflowState = {
      phase: "idle",
      specText: "topic",
      gateResults: {
        T1: {
          behaviorId: "T1",
          scope: ["__tests__/a.test.ts"],
          passed: true,
          suites: [],
          notes: [scopeFlaky, scopeDeferred],
          at: new Date().toISOString(),
        },
      },
      finalGate: {
        passed: true,
        suites: [],
        notes: [finalFlaky],
        at: new Date().toISOString(),
      },
    };

    const report = generateReport(state);

    assert.match(report, /Gate notes/, "the report has a gate-notes section");
    for (const note of [scopeFlaky, scopeDeferred, finalFlaky]) {
      assert.ok(report.includes(note), `the report lists the note: ${note}`);
    }
    assert.ok(
      report.indexOf(scopeFlaky) < report.indexOf(finalFlaky),
      "scope-gate notes are listed before the final-gate notes",
    );
  });
});
