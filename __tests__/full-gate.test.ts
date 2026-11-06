import { describe, it } from "vitest";
import assert from "node:assert/strict";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
  resolveFinalGateSuites,
  runFinalGate,
  runAndPersistFinalGate,
} from "../extensions/full-gate.ts";
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
 * Mock pi recording every exec call (cmd/args/opts) and every persisted
 * state entry; `respond` overrides the per-call result (or throws).
 *
 * @param respond - Optional per-call responder.
 * @returns The mock with its call and save logs.
 */
function mockPi(
  respond?: (call: ExecCall) => ExecResult | Promise<ExecResult>,
): ExtensionAPI & { calls: ExecCall[]; saved: Array<[string, WorkflowState]> } {
  const calls: ExecCall[] = [];
  const saved: Array<[string, WorkflowState]> = [];
  return {
    exec: (async (cmd: string, args: string[], opts: Record<string, unknown>) => {
      const call = { cmd, args, opts };
      calls.push(call);
      return respond ? await respond(call) : OK;
    }) as ExtensionAPI["exec"],
    appendEntry: ((type: string, data: WorkflowState) => {
      saved.push([type, structuredClone(data)]);
    }) as ExtensionAPI["appendEntry"],
    calls,
    saved,
  } as unknown as ExtensionAPI & {
    calls: ExecCall[];
    saved: Array<[string, WorkflowState]>;
  };
}

describe("resolveFinalGateSuites", () => {
  it("prefers the recorded full-suite list over the scoped suites", () => {
    const scoped: TestSuite = {
      label: "js (scoped)",
      argv: ["npm", "run", "test", "--", "{tests}"],
      scope: "files",
    };
    const full: TestSuite = { label: "go (full)", argv: ["go", "test", "./..."] };
    const testTool: TestToolInfo = { source: "detected", suites: [scoped], fullSuites: [full] };

    assert.deepEqual(
      resolveFinalGateSuites(testTool).map((s) => s.label),
      ["go (full)"],
      "the recorded full list wins when present",
    );
  });

  it("falls back to the scoped suites with unfiltered argv when no full list is recorded", () => {
    const testTool: TestToolInfo = {
      source: "detected",
      suites: [
        { label: "go", argv: ["go", "test", "{pkgs}"], scope: "packages" },
        { label: "py", argv: ["pytest", "{tests}"], scope: "files", cwd: "svc" },
      ],
    };

    const resolved = resolveFinalGateSuites(testTool);

    assert.deepEqual(
      resolved.map((s) => s.argv),
      [["go", "test", "./..."], ["pytest"]],
      "{pkgs} maps to ./... and {tests} is dropped",
    );
    assert.deepEqual(
      resolveFinalGateSuites(undefined),
      [],
      "a session without test wiring resolves to no suites",
    );
  });
});

describe("runFinalGate", () => {
  it("runs the recorded full suite list when present, not the scoped suites", async () => {
    const scoped: TestSuite = {
      label: "js (scoped)",
      argv: ["npm", "run", "test", "--", "{tests}"],
      scope: "files",
    };
    const full: TestSuite = { label: "go (full)", argv: ["go", "test", "./..."] };
    const testTool: TestToolInfo = { source: "detected", suites: [scoped], fullSuites: [full] };
    const pi = mockPi();

    const gate = await runFinalGate(pi, "/repo", testTool);

    assert.deepEqual(
      pi.calls.map((c) => ({ cmd: c.cmd, args: c.args })),
      [{ cmd: "go", args: ["test", "./..."] }],
      "only the recorded full list runs",
    );
    assert.equal(gate.passed, true);
    assert.deepEqual(
      gate.suites.map((s) => s.label),
      ["go (full)"],
      "verdicts carry the full-suite labels",
    );
  });

  it("runs the fallback scoped suites unfiltered, each in join(cwd, suite.cwd)", async () => {
    const testTool: TestToolInfo = {
      source: "detected",
      suites: [
        { label: "go", argv: ["go", "test", "{pkgs}"], scope: "packages" },
        { label: "py", argv: ["pytest", "{tests}"], scope: "files", cwd: "svc" },
      ],
    };
    const pi = mockPi();

    await runFinalGate(pi, "/repo", testTool);

    assert.deepEqual(
      pi.calls.map((c) => ({ cmd: c.cmd, args: c.args, cwd: c.opts["cwd"] })),
      [
        { cmd: "go", args: ["test", "./..."], cwd: "/repo" },
        { cmd: "pytest", args: [], cwd: "/repo/svc" },
      ],
      "suites run unfiltered in their own cwd",
    );
  });

  it("runs the suites strictly sequentially", async () => {
    const suites: TestSuite[] = [
      GO_SUITE,
      { label: "python (pytest)", argv: ["pytest"], cwd: "svc" },
      { label: "js", argv: ["npm", "run", "test"], cwd: "packages/web" },
    ];
    let active = 0;
    let maxActive = 0;
    const pi = mockPi(async () => {
      active++;
      maxActive = Math.max(maxActive, active);
      await new Promise((resolve) => setTimeout(resolve, 5));
      active--;
      return OK;
    });

    await runFinalGate(pi, "/repo", { source: "detected", suites });

    assert.equal(maxActive, 1, "suites run one after another, never concurrently");
    assert.deepEqual(
      pi.calls.map((c) => c.opts["cwd"]),
      ["/repo", "/repo/svc", "/repo/packages/web"],
      "each suite runs in join(cwd, suite.cwd) in declaration order",
    );
  });

  it("passes no timeout to exec and forwards the supplied AbortSignal", async () => {
    const signal = new AbortController().signal;
    const pi = mockPi();

    await runFinalGate(pi, "/repo", { source: "detected", suites: [GO_SUITE, JS_SUITE] }, signal);

    assert.equal(pi.calls.length, 2, "both suites ran");
    for (const call of pi.calls) {
      assert.ok(
        !("timeout" in call.opts),
        `the final gate must pass no timeout, got: ${JSON.stringify(call.opts)}`,
      );
      assert.equal(call.opts["signal"], signal, "the supplied AbortSignal is forwarded to exec");
    }
  });

  it("reports a killed run as not passed and carries its output tail", async () => {
    const pi = mockPi(() => ({ stdout: "", stderr: "--- FAIL: TestFoo", code: 137, killed: true }));

    const gate = await runFinalGate(pi, "/repo", { source: "detected", suites: [GO_SUITE] });

    assert.equal(gate.passed, false, "a killed run counts as not passed");
    assert.equal(gate.suites[0]!.passed, false);
    assert.match(gate.suites[0]!.tail, /--- FAIL: TestFoo/, "the killed suite keeps its tail");
  });

  it("reports an aborted run as not passed", async () => {
    const controller = new AbortController();
    controller.abort();
    const pi = mockPi(() => OK);

    const gate = await runFinalGate(
      pi,
      "/repo",
      { source: "detected", suites: [GO_SUITE] },
      controller.signal,
    );

    assert.equal(gate.passed, false, "an aborted run is reported as not passed");
    assert.equal(gate.suites[0]!.passed, false);
  });

  it("fails the gate with a spawn-failed tail when exec throws", async () => {
    const pi = mockPi(() => {
      throw new Error("spawn ENOENT");
    });

    const gate = await runFinalGate(pi, "/repo", { source: "detected", suites: [GO_SUITE] });

    assert.equal(gate.passed, false);
    assert.match(gate.suites[0]!.tail, /spawn failed: spawn ENOENT/);
  });
});

describe("runAndPersistFinalGate", () => {
  it("persists the final-gate result on state with pass flag, per-suite tails and timestamp", async () => {
    const state: WorkflowState = {
      phase: "implementing",
      specText: "topic",
      testTool: { source: "detected", suites: [GO_SUITE, JS_SUITE] },
    };
    const pi = mockPi((call) =>
      call.cmd === "go"
        ? { stdout: "", stderr: "--- FAIL: TestFoo", code: 1, killed: false }
        : OK,
    );

    const result = await runAndPersistFinalGate(pi, "/repo", state);

    assert.equal(result.passed, false, "the red verdict is returned");
    const persisted = state.finalGate;
    assert.ok(persisted, "the result lands on state.finalGate");
    assert.equal(persisted!.passed, false, "the pass flag is persisted");
    assert.equal(persisted!.suites.length, 2, "every suite carries a verdict");
    const go = persisted!.suites.find((s) => s.label === GO_SUITE.label);
    assert.match(go!.tail, /--- FAIL: TestFoo/, "the failing suite's tail is persisted");
    const js = persisted!.suites.find((s) => s.label === JS_SUITE.label);
    assert.match(js!.tail, /ok/, "passing suites carry their tails too");
    assert.ok(!Number.isNaN(Date.parse(persisted!.at)), "an ISO timestamp is persisted");

    const last = pi.saved[pi.saved.length - 1];
    assert.ok(last, "the result is persisted through saveState");
    assert.equal(last![0], "workflow-state");
    assert.equal(last![1].finalGate?.passed, false, "the persisted entry carries the verdict");
    assert.equal(typeof last![1].finalGate?.at, "string", "the persisted entry carries the timestamp");
  });
});
