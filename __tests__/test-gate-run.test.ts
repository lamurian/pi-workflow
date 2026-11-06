import { describe, it } from "vitest";
import assert from "node:assert/strict";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { runTaskScopeGate } from "../extensions/test-gate-run.ts";
import { renderGateReport, SKIPPED_TAIL, isSkippedSuite } from "../extensions/test-gate-report.ts";
import type { ContractV2 } from "../extensions/state.ts";
import type { TestSuite } from "../extensions/test-tool-detect.ts";

const GO_SUITE: TestSuite = { label: "go (go test ./...)", argv: ["go", "test", "./..."] };
const PY_SUITE: TestSuite = {
  label: "python (pytest)",
  argv: ["pytest", "{tests}"],
  scope: "files",
  cwd: "svc",
};
interface ExecCall {
  cmd: string;
  args: string[];
  cwd: string;
}

/** Mock pi whose exec logs every call and succeeds unless overridden. */
function mockPi(
  fail: (call: ExecCall) => boolean = () => false,
): ExtensionAPI & { calls: ExecCall[] } {
  const calls: ExecCall[] = [];
  return {
    exec: (async (cmd: string, args: string[], opts: { cwd: string }) => {
      const call = { cmd, args, cwd: opts.cwd };
      calls.push(call);
      return fail(call)
        ? { stdout: "", stderr: "--- FAIL: TestX", code: 1, killed: false }
        : { stdout: "ok", stderr: "", code: 0, killed: false };
    }) as ExtensionAPI["exec"],
    calls,
  } as unknown as ExtensionAPI & { calls: ExecCall[] };
}

/** v2 contract where T1 owns a Go test file and a Python test file. */
function contract(): ContractV2 {
  return {
    title: "Gate Task",
    instruction: "do things",
    done: "all green",
    sources: [{ path: "pkg/foo/foo.go", tasks: ["T1"] }],
    tests: [
      { path: "pkg/foo/foo_test.go", status: "A", tasks: ["T1"] },
      { path: "svc/tests/test_a.py", status: "A", tasks: ["T1"] },
    ],
    tasks: [
      { id: "T1", description: "first behavior", expectedOutput: ["e1"], status: "active" },
    ],
  };
}

describe("runTaskScopeGate", () => {
  it("runs each scoped suite with the routed argv in that suite's cwd", async () => {
    const pi = mockPi();
    const suites = [GO_SUITE, PY_SUITE];

    const gate = await runTaskScopeGate(pi, "/repo", contract(), suites, "T1");

    assert.ok(gate, "a task owning test paths gets a scope gate");
    const go = pi.calls.find((c) => c.cmd === "go");
    assert.ok(go, "the go suite executed");
    assert.deepEqual(go!.args, ["test", "./pkg/foo/..."], "go ran the routed package pattern");
    assert.equal(go!.cwd, "/repo", "a suite without cwd runs at the repo root");
    const py = pi.calls.find((c) => c.cmd === "pytest");
    assert.ok(py, "the pytest suite executed");
    assert.deepEqual(py!.args, ["tests/test_a.py"], "pytest ran the file routed to its cwd");
    assert.equal(py!.cwd, "/repo/svc", "the suite runs in its own cwd with routed paths rel to it");
  });

  it("does not execute scoped suites with no routed paths and lists them as skipped", async () => {
    const pi = mockPi();
    // Only the Go path is owned — no path routes to the pytest suite.
    const c = contract();
    c.tests = [{ path: "pkg/foo/foo_test.go", status: "A", tasks: ["T1"] }];

    const gate = await runTaskScopeGate(pi, "/repo", c, [GO_SUITE, PY_SUITE], "T1");

    assert.ok(gate);
    assert.ok(!pi.calls.some((c2) => c2.cmd === "pytest"), "no routed paths → not executed");
    const skipped = gate!.suites.find((s) => s.label === PY_SUITE.label);
    assert.ok(skipped, "the skipped suite still carries a verdict");
    assert.ok(isSkippedSuite(skipped!), "the verdict records the skip marker");
    assert.equal(skipped!.tail, SKIPPED_TAIL);
    const report = renderGateReport(gate!, "scope gate");
    assert.match(report, /python \(pytest\) SKIP/, "the gate report lists the skipped suite");
  });

  it("full-scope suites run unfiltered at every scope gate", async () => {
    const pi = mockPi();
    const full: TestSuite = { label: "make test", argv: ["make", "test", "{tests}"] };

    const gate = await runTaskScopeGate(pi, "/repo", contract(), [GO_SUITE, full], "T1");

    assert.ok(gate);
    const make = pi.calls.find((c) => c.cmd === "make");
    assert.ok(make, "the full-scope suite executes even though no path routes to it");
    assert.deepEqual(make!.args, ["test"], "it runs unfiltered with placeholders stripped");
    const verdict = gate!.suites.find((s) => s.label === "make test");
    assert.ok(verdict && !isSkippedSuite(verdict), "a full-scope suite is never listed as skipped");
  });

  it("GateResult.scope records the routed test paths", async () => {
    const pi = mockPi();

    const gate = await runTaskScopeGate(pi, "/repo", contract(), [GO_SUITE, PY_SUITE], "T1");

    assert.ok(gate);
    assert.deepEqual(
      gate!.scope,
      ["pkg/foo/foo_test.go", "svc/tests/test_a.py"],
      "scope records the owned non-D test paths, not package dirs",
    );
  });

  it("a task owning no test paths still gets no scope gate", async () => {
    const pi = mockPi();
    const c = contract();
    c.tests = [];
    c.sources = [{ path: "pkg/foo/foo.go", tasks: ["T1"] }];

    const gate = await runTaskScopeGate(pi, "/repo", c, [GO_SUITE, PY_SUITE], "T1");

    assert.equal(gate, null, "no owned test paths → no gate at all");
    assert.equal(pi.calls.length, 0, "nothing is executed");
  });

  it("a red routed suite fails the gate and carries its output tail", async () => {
    const pi = mockPi((call) => call.cmd === "go");

    const gate = await runTaskScopeGate(pi, "/repo", contract(), [GO_SUITE, PY_SUITE], "T1");

    assert.ok(gate);
    assert.equal(gate!.passed, false, "a failing routed suite turns the gate red");
    const go = gate!.suites.find((s) => s.label === GO_SUITE.label);
    assert.match(go!.tail, /--- FAIL: TestX/, "the failing suite carries its output tail");
  });
});
