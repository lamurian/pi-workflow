import { describe, it } from "vitest";
import assert from "node:assert/strict";
import {
  registerMarkTaskDoneTool,
  registerCompleteImplementationTool,
} from "../extensions/implement-tools.ts";
import { composeCompletionReport } from "../extensions/implement-report.ts";
import { isOutOfRepoBehavior } from "../extensions/git-ops.ts";
import type { WorkflowState, TaskContract, Behavior } from "../extensions/state.ts";
import type {
  ExtensionAPI,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import {
  mockPi,
  ctxWithState,
  finalizingState,
  getTool,
  runOrchestratedViaSeam,
} from "./helpers/implement-harness.ts";

// ═══ out-of-repo behaviors: path-inferred never-commit ═══
describe("out-of-repo behaviors skip the commit gate", () => {
  const behaviorBase = { description: "d", expectedOutput: "e", kind: "test", status: "active" } as const;

  it("isOutOfRepoBehavior resolves the sourceFile against cwd; no sourceFile keeps the commit path", () => {
    assert.equal(
      isOutOfRepoBehavior({ ...behaviorBase, id: "T1", sourceFile: "../gateway-sdk-go/service.go" }, "/tmp/test"),
      true,
      "a sibling-directory sourceFile is out of repo",
    );
    assert.equal(
      isOutOfRepoBehavior({ ...behaviorBase, id: "T2", sourceFile: "src/a.ts" }, "/tmp/test"),
      false,
      "an in-repo sourceFile stays on the commit path",
    );
    assert.equal(
      isOutOfRepoBehavior({ ...behaviorBase, id: "T3", sourceFile: "/abs/outside.go" }, "/tmp/test"),
      true,
      "an absolute path outside cwd is out of repo",
    );
    assert.equal(
      isOutOfRepoBehavior({ ...behaviorBase, id: "T4" }, "/tmp/test"),
      false,
      "behaviors without sourceFile keep the commit path",
    );
  });

  function mixedTask(): TaskContract {
    return {
      title: "Mixed Task",
      instruction: "do things",
      files: [{ path: "src/a.ts", status: "M" }],
      done: "all green",
      behaviors: [
        {
          id: "T1",
          description: "outside behavior",
          expectedOutput: "e1",
          kind: "test",
          status: "active",
          sourceFile: "../gateway-sdk-go/service.go",
        },
        {
          id: "T2",
          description: "inside behavior",
          expectedOutput: "e2",
          kind: "test",
          status: "active",
          sourceFile: "src/a.ts",
        },
      ],
    };
  }

  it("marks the out-of-repo behavior done with zero git add/commit for it, records leftUncommitted, and the in-repo behavior still commits", async () => {
    const pi = mockPi();
    const timeline: string[] = [];
    let headCounter = 0;
    pi.exec = (async (cmd: string, args: string[]) => {
      if (cmd === "git" && args[0] === "rev-parse") {
        return { stdout: `head${headCounter}\n`, stderr: "", code: 0, killed: false };
      }
      if (cmd === "git" && args[0] === "add") {
        timeline.push("exec:git add");
        return { stdout: "", stderr: "", code: 0, killed: false };
      }
      if (cmd === "git" && args[0] === "commit") {
        headCounter++;
        timeline.push("exec:git commit");
        return { stdout: "[main abc] committed", stderr: "", code: 0, killed: false };
      }
      return { stdout: "", stderr: "", code: 0, killed: false };
    }) as ExtensionAPI["exec"];

    const state: WorkflowState = { phase: "finalizing", specText: "topic", task: mixedTask() };
    const ctx = ctxWithState(state);
    const notifyCalls: string[] = [];
    ctx.ui.notify = ((msg: string) => {
      notifyCalls.push(msg);
    }) as unknown as ExtensionContext["ui"]["notify"];

    const result = await runOrchestratedViaSeam(pi, ctx, async (unit) => {
      timeline.push(`unit:${unit.behaviorId}`);
      return {
        summary: `implemented ${unit.behaviorId}`,
        suggestedCommit: `feat(core): add ${unit.behaviorId === "T1" ? "outside" : "inside"} behavior`,
      };
    });

    assert.equal(result.complete, true, "the run completes");
    assert.equal(state.phase, "idle");
    assert.ok(
      state.task!.behaviors.every((b: Behavior) => b.status === "done"),
      "both behaviors are marked done",
    );

    // No commit-gate exec between the out-of-repo unit run and the in-repo unit run.
    const between = timeline.slice(timeline.indexOf("unit:T1"), timeline.indexOf("unit:T2"));
    assert.ok(!between.includes("exec:git add"), "no git add for the out-of-repo behavior");
    assert.ok(!between.includes("exec:git commit"), "no git commit for the out-of-repo behavior");
    assert.equal(
      timeline.filter((e) => e === "exec:git commit").length,
      1,
      "only the in-repo behavior lands a commit",
    );

    assert.deepEqual(
      result.leftUncommitted,
      [{ behaviorId: "T1", sourceFile: "../gateway-sdk-go/service.go" }],
      "the out-of-repo behavior is recorded as left uncommitted",
    );
    assert.ok(
      notifyCalls.some((m) => /T1/.test(m) && /left uncommitted/i.test(m)),
      "a notification names the left-uncommitted behavior",
    );

    const report = composeCompletionReport(result, state.task!);
    const section = report.slice(report.indexOf("Left uncommitted"));
    assert.match(report, /Left uncommitted — commit these manually/);
    assert.match(section, /T1: \.\.\/gateway-sdk-go\/service\.go/);
    assert.doesNotMatch(section, /T2/, "only the out-of-repo behavior is listed");
  });

  it("an out-of-repo behavior never feeds the no-changes fix task on retry", async () => {
    const pi = mockPi();
    // Clean tree, HEAD never moves — the classic no-changes trigger for in-repo behaviors.
    pi.exec = (async (cmd: string, args: string[]) => {
      if (cmd === "git" && args[0] === "rev-parse") {
        return { stdout: "headA\n", stderr: "", code: 0, killed: false };
      }
      return { stdout: "", stderr: "", code: 0, killed: false };
    }) as ExtensionAPI["exec"];

    const state: WorkflowState = {
      phase: "finalizing",
      specText: "topic",
      task: {
        title: "Outside Only",
        instruction: "do things",
        files: [{ path: "src/a.ts", status: "M" }],
        done: "all green",
        behaviors: [
          {
            id: "T1",
            description: "outside behavior",
            expectedOutput: "e1",
            kind: "test",
            status: "active",
            sourceFile: "../gateway-sdk-go/service.go",
          },
        ],
      },
    };
    const ctx = ctxWithState(state);
    const spawns: string[] = [];

    const result = await runOrchestratedViaSeam(pi, ctx, async (unit) => {
      spawns.push(unit.taskText);
      return { summary: "implemented T1", suggestedCommit: "feat: outside" };
    });

    assert.equal(spawns.length, 1, "no fix-task retry is spawned for an out-of-repo behavior");
    assert.doesNotMatch(spawns[0] ?? "", /No changes detected/, "no impossible-verdict retry text");
    assert.equal(result.complete, true);
    assert.deepEqual(result.leftUncommitted, [{ behaviorId: "T1", sourceFile: "../gateway-sdk-go/service.go" }]);
  });
});

// ═══ T8: orchestrator test gates ═══
describe("T8: orchestrator test gates", () => {
  const GO_SUITE = { label: "go (go test ./...)", argv: ["go", "test", "./..."] };
  const JS_SUITE = { label: "javascript (npm run test)", argv: ["npm", "run", "test"] };

  /** v2-gated state: one test-kind behavior owning a Go source + test file. */
  function gatedState(): WorkflowState {
    return {
      phase: "finalizing",
      specText: "topic",
      testTool: { source: "detected", suites: [GO_SUITE, JS_SUITE] },
      contractV2: {
        title: "Gate Task",
        instruction: "do things",
        done: "all green",
        sources: [{ path: "pkg/foo/foo.go", tasks: ["T1"] }],
        tests: [{ path: "pkg/foo/foo_test.go", status: "A", tasks: ["T1"] }],
        tasks: [
          { id: "T1", description: "first behavior", expectedOutput: ["e1"], status: "active" },
        ],
      },
      task: {
        title: "Gate Task",
        instruction: "do things",
        files: [
          { path: "pkg/foo/foo.go", status: "M" },
          { path: "pkg/foo/foo_test.go", status: "A" },
        ],
        done: "all green",
        behaviors: [
          {
            id: "T1",
            description: "first behavior",
            expectedOutput: "e1",
            kind: "test",
            status: "active",
            sourceFile: "pkg/foo/foo.go",
          },
        ],
      },
    };
  }

  interface ExecLogEntry { cmd: string; args: string[] }

  /**
   * Exec mock: git commits advance HEAD; the go suite fails while
   * `goFailures` runs remain (gate-red rounds), then passes; npm always passes.
   */
  function piWithGateExec(goFailures: number): {
    pi: ExtensionAPI & { calls: Record<string, unknown[]> };
    execLog: ExecLogEntry[];
  } {
    const pi = mockPi();
    // Snapshot every persisted state entry: the loop mutates the live state
    // object, so historical assertions (a red gate persisted while the task
    // was still active) must see the state as it was at persist time.
    const realAppend = pi.appendEntry;
    pi.appendEntry = ((type: string, data: unknown) =>
      realAppend(type, structuredClone(data))) as ExtensionAPI["appendEntry"];
    const execLog: ExecLogEntry[] = [];
    let headCounter = 0;
    let goFailuresLeft = goFailures;
    pi.exec = (async (cmd: string, args: string[]) => {
      execLog.push({ cmd, args });
      if (cmd === "git" && args[0] === "rev-parse") {
        return { stdout: `head${headCounter}\n`, stderr: "", code: 0, killed: false };
      }
      if (cmd === "git" && (args[0] === "status" || args[0] === "add" || args[0] === "diff")) {
        return { stdout: "", stderr: "", code: 0, killed: false };
      }
      if (cmd === "git" && args[0] === "commit") {
        headCounter++;
        return { stdout: "[main abc] committed", stderr: "", code: 0, killed: false };
      }
      if (cmd === "go" && args[0] === "test") {
        if (goFailuresLeft > 0) {
          goFailuresLeft--;
          return {
            stdout: "",
            stderr: "--- FAIL: TestFoo (0.00s)\n    foo_test.go:12: boom\nFAIL\tpkg/foo",
            code: 1,
            killed: false,
          };
        }
        return { stdout: "ok\tpkg/foo", stderr: "", code: 0, killed: false };
      }
      if (cmd === "npm") {
        return { stdout: "ok", stderr: "", code: 0, killed: false };
      }
      return { stdout: "", stderr: "", code: 0, killed: false };
    }) as ExtensionAPI["exec"];
    return { pi, execLog };
  }

  it("scopeGateRunsRoutedPaths: after each task commit the orchestrator runs each scoped suite with the argv routed from the task's owned test paths, in that suite's cwd, and records skipped suites", async () => {
    const { pi, execLog } = piWithGateExec(0);
    const state = gatedState();
    const ctx = ctxWithState(state);

    await runOrchestratedViaSeam(pi, ctx, async (unit) => ({
      summary: `implemented ${unit.behaviorId}`,
      suggestedCommit: "feat(foo): add first behavior",
    }));

    // The filterable (Go) suite ran with the argv routed from the owned test
    // path — scoped package pattern, no -run filter, and NOT the unscoped ./....
    const goRuns = execLog.filter((e) => e.cmd === "go");
    assert.deepEqual(
      goRuns.map((e) => e.args),
      [["test", "./pkg/foo/..."], ["test", "./..."]],
      "one scoped scope-gate run per landed task commit, then the T7 final gate runs the suite unfiltered",
    );
    // The non-filterable (npm) suite ran unfiltered in both gates.
    const npmRuns = execLog.filter((e) => e.cmd === "npm");
    assert.equal(npmRuns.length, 2, "every non-filterable suite runs in the scope gate and again in the final gate");
    assert.ok(
      npmRuns.every((e) => e.args.join(" ") === "run test"),
      "non-filterable suites run their plain argv",
    );
    // The gate ran AFTER the task commit landed, from the orchestrator's own
    // exec log — the injected unit runner has no test tool at all.
    const commitIdx = execLog.findIndex((e) => e.cmd === "git" && e.args[0] === "commit");
    const goIdx = execLog.findIndex((e) => e.cmd === "go");
    assert.ok(goIdx > commitIdx, "the scope gate runs after the task commit lands");
    // The gate result is recorded per task with scope + pass/fail.
    const gate = state.gateResults?.T1;
    assert.ok(gate, "the orchestrator records the scope-gate result for the task");
    assert.deepEqual(
      gate!.scope,
      ["pkg/foo/foo_test.go"],
      "the gate result records the routed test paths",
    );
    assert.equal(gate!.passed, true, "a green gate passes");
    assert.equal(gate!.suites.length, 2, "every suite carries a verdict");
    assert.equal(state.task!.behaviors[0]!.status, "done");
    assert.equal(state.phase, "idle");
  });

  it("scopeGateRedSteersFixForward: a red scope gate keeps the task open and steers a fix-forward attempt through the retry path instead of marking it done", async () => {
    // Twice-red with an owned failing path (pkg/foo/foo_test.go): the retry
    // classifies it owned, the gate stays red, and fix-forward still steers.
    const { pi, execLog } = piWithGateExec(2); // first gate: red, red on re-run; after the fix: green
    const state = gatedState();
    const ctx = ctxWithState(state);
    const calls: string[] = [];
    const taskTexts: string[] = [];

    const result = await runOrchestratedViaSeam(pi, ctx, async (unit) => {
      calls.push(unit.behaviorId);
      taskTexts.push(unit.taskText);
      return {
        summary: `implemented ${unit.behaviorId}`,
        suggestedCommit: "feat(foo): add first behavior",
      };
    });

    assert.deepEqual(
      calls,
      ["T1", "T1"],
      "a red scope gate steers a fix-forward attempt instead of marking the task done",
    );
    assert.match(taskTexts[1] ?? "", /Orchestrator scope gate/, "the fix task names the scope gate");
    assert.match(taskTexts[1] ?? "", /go \(go test \.\/\.\.\.\) \(FAIL\)/, "the failing suite is named");
    assert.match(taskTexts[1] ?? "", /--- FAIL: TestFoo/, "the failing suite output tail is carried");

    // The RED result was persisted while the behavior was still active.
    const saved = (pi.calls["appendEntry"] ?? []) as Array<[string, WorkflowState]>;
    const redSaved = saved.filter(([, s]) => s.gateResults?.T1?.passed === false);
    assert.equal(redSaved.length, 1, "the red gate result is persisted exactly once");
    assert.equal(
      redSaved[0]![1].task!.behaviors[0]!.status,
      "active",
      "a red scope gate keeps the task open",
    );
    // The fix-forward attempt lands its own commit and the re-run gate is green.
    const commits = execLog.filter((e) => e.cmd === "git" && e.args[0] === "commit");
    assert.equal(commits.length, 2, "the fix-forward attempt lands its own commit");
    assert.equal(state.gateResults?.T1?.passed, true, "the re-run scope gate is green");
    assert.equal(state.task!.behaviors[0]!.status, "done");
    assert.equal(result.complete, true);
    assert.equal(state.phase, "idle");
  });

  it("completeImplementationBlocksOnRedFullGate: complete_implementation runs all suites unfiltered and blocks completion on red, naming the failing suite and its output tail", async () => {
    const pi = mockPi();
    registerCompleteImplementationTool(pi);
    const s = finalizingState();
    s.phase = "implementing";
    s.task!.behaviors[0]!.status = "done";
    s.testTool = { source: "detected", suites: [GO_SUITE, JS_SUITE] };
    const execLog: ExecLogEntry[] = [];
    pi.exec = (async (cmd: string, args: string[]) => {
      execLog.push({ cmd, args });
      if (cmd === "go") {
        return { stdout: "", stderr: "--- FAIL: TestGate\nFAIL\tpkg/foo", code: 1, killed: false };
      }
      return { stdout: "ok", stderr: "", code: 0, killed: false };
    }) as ExtensionAPI["exec"];
    const ctx = ctxWithState(s);

    const res = await getTool(pi, "complete_implementation")!.execute(
      "c1", {}, undefined, undefined, ctx,
    );

    assert.equal(res.isError, true, "a red full gate blocks completion");
    assert.match(res.content[0].text, /go \(go test \.\/\.\.\.\)/, "the failing suite is named");
    assert.match(res.content[0].text, /--- FAIL: TestGate/, "the failing suite output tail is carried");
    assert.equal(s.phase, "implementing", "a red full gate never transitions to idle");
    // T6: the final-gate result and the attempt counter land on state.
    assert.equal(s.finalGate?.passed, false, "the red result is persisted on state");
    assert.ok(
      s.finalGate!.suites.some((x) => /--- FAIL: TestGate/.test(x.tail)),
      "the persisted result carries the failing suite tail",
    );
    assert.ok(
      !Number.isNaN(Date.parse(s.finalGate!.at)),
      "the persisted result carries a timestamp",
    );
    assert.equal(s.finalGateAttempts, 1, "the first red increments the attempt counter");
    // ALL suites ran unfiltered: the Go suite keeps its plain ./... argv.
    const goRun = execLog.find((e) => e.cmd === "go");
    assert.deepEqual(goRun!.args, ["test", "./..."], "the full gate runs every suite unfiltered");
    assert.ok(execLog.some((e) => e.cmd === "npm"), "non-filterable suites run in the full gate too");

    // Green full gate: completion proceeds.
    pi.exec = (async () => ({ stdout: "ok", stderr: "", code: 0, killed: false })) as ExtensionAPI["exec"];
    const ok = await getTool(pi, "complete_implementation")!.execute(
      "c2", {}, undefined, undefined, ctx,
    );
    assert.notEqual(ok.isError, true, "a green full gate allows completion");
    assert.equal(s.phase, "idle");
    assert.equal(s.finalGate?.passed, true, "the green result replaces the red one");
    assert.equal(s.finalGateAttempts, 0, "a green final gate resets the attempt counter");
  });

  it("markDoneEvidenceCarriesGateResult: mark_task_done evidence for a task with tests refs carries the orchestrator gate result line (scope and pass/fail)", async () => {
    const pi = mockPi();
    registerMarkTaskDoneTool(pi);
    const s = gatedState();
    s.phase = "implementing";
    s.gateResults = {
      T1: {
        behaviorId: "T1",
        scope: ["pkg/foo"],
        passed: true,
        suites: [{ label: GO_SUITE.label, passed: true, tail: "ok\tpkg/foo" }],
        at: new Date().toISOString(),
      },
    };
    const ctx = ctxWithState(s);

    const res = await getTool(pi, "mark_task_done")!.execute(
      "c1",
      { behaviorId: "T1", evidence: "unit self-report: tests pass" },
      undefined,
      undefined,
      ctx,
    );

    assert.notEqual(res.isError, true);
    const text = res.content[0].text as string;
    assert.match(text, /orchestrator gate/i, "evidence carries the orchestrator gate line");
    assert.match(text, /pkg\/foo/, "the gate line carries the scope");
    assert.match(text, /passed/, "the gate line carries the pass verdict");

    // A red gate result renders the failed verdict.
    s.gateResults!.T1!.passed = false;
    const res2 = await getTool(pi, "mark_task_done")!.execute(
      "c2",
      { behaviorId: "T1", evidence: "x" },
      undefined,
      undefined,
      ctx,
    );
    assert.match(res2.content[0].text, /orchestrator gate/i);
    assert.match(res2.content[0].text, /failed/, "the gate line carries the fail verdict");
  });
});
