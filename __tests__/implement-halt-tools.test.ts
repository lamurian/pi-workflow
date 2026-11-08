import { describe, it } from "vitest";
import assert from "node:assert/strict";
import {
  registerMarkTaskDoneTool,
  registerCompleteImplementationTool,
} from "../extensions/implement-tools.ts";
import type { WorkflowState, TaskContract } from "../extensions/state.ts";
import type { ImplementerReport } from "../extensions/implementer-report.ts";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
  mockPi,
  ctxWithState,
  finalizingState,
  getTool,
  runOrchestratedViaSeam,
} from "./helpers/implement-harness.ts";

// ═══ T6: exception safety — no unhandled rejection escapes /implement ═══
describe("T6: exception safety in runImplement", () => {
  function oneBehavior(): TaskContract {
    return {
      title: "Crash Task",
      instruction: "do things",
      files: [{ path: "src/a.ts", status: "M" }],
      done: "all green",
      behaviors: [
        { id: "T1", description: "first behavior", expectedOutput: "e1", kind: "test", status: "active" },
      ],
    };
  }

  it("catches a raw throw from the unit runner, persists lastHalt, keeps implementing", async () => {
    const pi = mockPi();
    const state: WorkflowState = { phase: "finalizing", specText: "topic", task: oneBehavior() };
    const ctx = ctxWithState(state);
    const notifyCalls: string[] = [];
    ctx.ui.notify = (msg: string) => {
      notifyCalls.push(msg);
    };

    // No rejection expected: the safety wrapper must absorb the crash.
    await runOrchestratedViaSeam(pi, ctx, async () => {
      throw new Error("subprocess exploded");
    });

    assert.equal(state.phase, "implementing", "phase stays implementing for resume");
    assert.equal(state.task!.behaviors[0]!.status, "active");

    const append = pi.calls["appendEntry"] ?? [];
    const lastSaved = append[append.length - 1] as [string, WorkflowState];
    assert.equal(lastSaved[0], "workflow-state");
    const halt = lastSaved[1].lastHalt;
    assert.equal(halt?.behaviorId, "T1", "lastHalt names the active behavior");
    assert.match(halt?.error ?? "", /orchestrator crashed: subprocess exploded/);
    assert.equal(typeof halt?.at, "string");

    const report = notifyCalls[notifyCalls.length - 1]!;
    assert.match(report, /Orchestration halted on T1: orchestrator crashed: subprocess exploded/, "user sees the crash in the halt handoff");
    assert.match(report, /lastHalt/, "user is told the handoff was persisted");
    assert.match(report, /\/implement again to resume/, "user is told how to resume");
  });

  it("halt path persists lastHalt before runImplement returns (covered with T3; smoke here)", async () => {
    const pi = mockPi();
    pi.exec = (async (cmd: string, args: string[]) => {
      if (cmd === "git" && args[0] === "rev-parse") return { stdout: "headA\n", stderr: "", code: 0, killed: false };
      if (cmd === "git" && args[0] === "status") return { stdout: " M src/a.ts\n", stderr: "", code: 0, killed: false };
      if (cmd === "git" && args[0] === "diff") return { stdout: " src/a.ts | 2 +-\n", stderr: "", code: 0, killed: false };
      if (cmd === "git" && args[0] === "commit") return { stdout: "", stderr: "golangci-lint run failed", code: 1, killed: false };
      return { stdout: "", stderr: "", code: 0, killed: false };
    }) as ExtensionAPI["exec"];
    const state: WorkflowState = { phase: "finalizing", specText: "topic", task: oneBehavior() };
    const ctx = ctxWithState(state);

    await runOrchestratedViaSeam(pi, ctx, async () => ({
      summary: "attempt",
      suggestedCommit: "feat(core): add first behavior",
    }));

    const append = pi.calls["appendEntry"] ?? [];
    const lastSaved = append[append.length - 1] as [string, WorkflowState];
    assert.equal(lastSaved[1].lastHalt?.behaviorId, "T1", "halt persisted handoff as the final entry");
    assert.match(lastSaved[1].lastHalt?.error ?? "", /golangci-lint/);
  });
});

// ═══ T4: retry once, halt with handoff, resume on re-run ═══
describe("T4: retry once, halt with handoff, resume on re-run", () => {
  function t4Task(): TaskContract {
    return {
      title: "T4 Task",
      instruction: "do things",
      files: [{ path: "src/a.ts", status: "M" }],
      done: "all green",
      behaviors: [
        { id: "T1", description: "first behavior", expectedOutput: "e1", kind: "test", status: "active" },
        { id: "T2", description: "second behavior", expectedOutput: "e2", kind: "test", status: "active" },
      ],
    };
  }

  interface ExecLogEntry { cmd: string; args: string[] }

  function piWithExecLog(): { pi: ExtensionAPI & { calls: Record<string, unknown[]> }; execLog: ExecLogEntry[] } {
    const pi = mockPi();
    const execLog: ExecLogEntry[] = [];
    let headCounter = 0;
    pi.exec = (async (cmd: string, args: string[]) => {
      execLog.push({ cmd, args });
      if (cmd === "git" && args[0] === "rev-parse") {
        return { stdout: `head${++headCounter}\n`, stderr: "", code: 0, killed: false };
      }
      if (cmd === "git" && args[0] === "status") {
        return { stdout: " M src/a.ts\n", stderr: "", code: 0, killed: false };
      }
      if (cmd === "git" && args[0] === "commit") {
        return { stdout: "committed", stderr: "", code: 0, killed: false };
      }
      if (cmd === "npm") {
        return { stdout: "2 passed", stderr: "", code: 0, killed: false };
      }
      return { stdout: "", stderr: "", code: 0, killed: false };
    }) as ExtensionAPI["exec"];
    return { pi, execLog };
  }

  interface Spawn { behaviorId: string; taskText: string }

  function failingThenSucceedingRunner(
    spawns: Spawn[],
    failOn: string,
    error: string,
  ) {
    const attempts: Record<string, number> = {};
    return async (unit: Spawn): Promise<ImplementerReport & { error?: string }> => {
      spawns.push({ behaviorId: unit.behaviorId, taskText: unit.taskText });
      attempts[unit.behaviorId] = (attempts[unit.behaviorId] ?? 0) + 1;
      if (unit.behaviorId === failOn && attempts[unit.behaviorId] === 1) {
        return { summary: "", error };
      }
      return {
        summary: `implemented ${unit.behaviorId}`,
        suggestedCommit: `feat(core): add ${unit.behaviorId === "T1" ? "first behavior" : "second behavior"}`,
      };
    };
  }

  it("retries once with the failure output appended to the task text", async () => {
    const { pi } = piWithExecLog();
    const state: WorkflowState = { phase: "finalizing", specText: "topic", task: t4Task() };
    state.task!.behaviors = [state.task!.behaviors[0]!];
    const ctx = ctxWithState(state);
    const spawns: Spawn[] = [];

    await runOrchestratedViaSeam(pi, ctx, failingThenSucceedingRunner(spawns, "T1", "boom: cannot write file"));

    assert.equal(spawns.length, 2, "one retry after the first failure");
    assert.match(
      spawns[1]!.taskText,
      /Previous attempt failed/,
      "retry task text must carry the failure section",
    );
    assert.match(
      spawns[1]!.taskText,
      /boom: cannot write file/,
      "retry task text must contain the failure output",
    );
    assert.equal(state.phase, "idle", "recovered retry completes the workflow");
    assert.equal(state.task!.behaviors[0]!.status, "done");
  });

  it("retries a failing unit up to 5 times, then halts with a persisted handoff", async () => {
    const { pi } = piWithExecLog();
    const state: WorkflowState = { phase: "finalizing", specText: "topic", task: t4Task() };
    const ctx = ctxWithState(state);
    const notifyCalls: string[] = [];
    ctx.ui.notify = (msg: string) => {
      notifyCalls.push(msg);
    };
    const spawns: Spawn[] = [];

    await runOrchestratedViaSeam(
      pi,
      ctx,
      async (unit: Spawn): Promise<ImplementerReport & { error?: string }> => {
        spawns.push({ behaviorId: unit.behaviorId, taskText: unit.taskText });
        if (unit.behaviorId === "T2") {
          return { summary: "", error: "EACCES: permission denied" };
        }
        return {
          summary: `implemented ${unit.behaviorId}`,
          suggestedCommit: "feat(core): add first behavior",
        };
      },
    );

    assert.deepEqual(
      spawns.map((s) => s.behaviorId),
      ["T1", "T2", "T2", "T2", "T2", "T2", "T2"],
      "T1 once; T2 initial + exactly 5 retries, then stop",
    );
    assert.match(spawns[2]!.taskText, /retry 1\/5/, "first retry carries the budget header");
    assert.match(spawns[6]!.taskText, /retry 5\/5/, "fifth retry is the last allowed");
    assert.equal(state.phase, "implementing", "halt must not complete the workflow");
    assert.equal(state.task!.behaviors[0]!.status, "done");
    assert.equal(state.task!.behaviors[1]!.status, "active");

    // Handoff persisted: appendEntry carried workflow-state with lastHalt.
    const append = pi.calls["appendEntry"] ?? [];
    const lastSaved = append[append.length - 1] as [string, WorkflowState];
    assert.equal(lastSaved[0], "workflow-state");
    assert.equal(lastSaved[1].lastHalt?.behaviorId, "T2");
    assert.match(lastSaved[1].lastHalt?.error ?? "", /EACCES: permission denied/);
    assert.ok(Array.isArray(lastSaved[1].lastHalt?.landedCommits));
    assert.equal(typeof lastSaved[1].lastHalt?.at, "string");

    const report = notifyCalls[notifyCalls.length - 1]!;
    assert.match(report, /T2/, "report names the failed unit");
    assert.match(report, /EACCES: permission denied/, "report carries the error");
    assert.match(report, /lastHalt/, "report says the handoff was persisted");
    assert.match(report, /\/implement again to resume/, "report tells the user how to resume");
  });

  it("re-running /implement resumes from the first active behavior only", async () => {
    const { pi } = piWithExecLog();
    const task = t4Task();
    task.behaviors[0]!.status = "done"; // simulate partial progress from a prior run
    const state: WorkflowState = { phase: "implementing", specText: "topic", task };
    const ctx = ctxWithState(state);
    const spawns: Spawn[] = [];

    await runOrchestratedViaSeam(pi, ctx, async (unit: Spawn) => {
      spawns.push({ behaviorId: unit.behaviorId, taskText: unit.taskText });
      return {
        summary: `implemented ${unit.behaviorId}`,
        suggestedCommit: "feat(core): add second behavior",
      };
    });

    assert.deepEqual(
      spawns.map((s) => s.behaviorId),
      ["T2"],
      "done behaviors are skipped on resume — only active ones spawn",
    );
    assert.equal(state.phase, "idle", "resume completes once remaining units are done");
    assert.equal(task.behaviors[1]!.status, "done");
  });
});

// ═══ T6: manual behaviors flagged in the final report ═══
describe("T6: manual behaviors flagged in the final report", () => {
  it("lists completed manual behaviors under 'Manual verification required'", async () => {
    const { generateReport } = await import("../extensions/implement-report.ts");
    const state: WorkflowState = {
      phase: "idle",
      specText: "topic",
      lastTestResults: { passed: 4, failed: 0, coveragePercent: 92 },
      task: {
        title: "Ship the thing",
        instruction: "do the thing",
        files: [{ path: "src/a.ts", status: "M" }],
        done: "tests green + docs updated",
        behaviors: [
          { id: "T1", description: "adds retry backoff", expectedOutput: "retries", kind: "test", status: "done" },
          { id: "M1", description: "updates README usage section", expectedOutput: "docs show new flag", kind: "manual", status: "done" },
          { id: "M2", description: "regenerates the changelog", expectedOutput: "changelog lists the release", kind: "manual", status: "done" },
        ],
      },
    };

    const report = generateReport(state);

    assert.match(report, /Manual verification required/);
    assert.match(report, /M1/);
    assert.match(report, /updates README usage section/);
    assert.match(report, /M2/);
    assert.match(report, /regenerates the changelog/);
  });

  it("keeps test behaviors under Test Results and omits the manual section when none completed", async () => {
    const { generateReport } = await import("../extensions/implement-report.ts");
    const state: WorkflowState = {
      phase: "idle",
      specText: "topic",
      lastTestResults: { passed: 4, failed: 0 },
      task: {
        title: "Ship the thing",
        instruction: "do the thing",
        files: [{ path: "src/a.ts", status: "M" }],
        done: "tests green",
        behaviors: [
          { id: "T1", description: "adds retry backoff", expectedOutput: "retries", kind: "test", status: "done" },
        ],
      },
    };

    const report = generateReport(state);

    assert.match(report, /Test Results/);
    assert.match(report, /Passed:\s*4/);
    assert.match(report, /adds retry backoff/);
    assert.doesNotMatch(report, /Manual verification required/);
  });
});

// ═══ tool registration ═══
describe("implement tool registration", () => {
  it("registers mark_task_done and complete_implementation; run_tests is gone (T10)", async () => {
    const pi = mockPi();
    const mod = await import("../extensions/implement-tools.ts");
    (mod as unknown as Record<string, Function>)["registerMarkTaskDoneTool"]!(pi);
    (mod as unknown as Record<string, Function>)["registerCompleteImplementationTool"]!(pi);

    const names = ((pi.calls["registerTool"] ?? []) as Array<[{ name: string }]>)
      .map(([d]) => d.name);
    assert.deepEqual(names.sort(), [
      "complete_implementation",
      "mark_task_done",
    ]);
    assert.ok(!names.includes("run_tests"), "run_tests must not be registered");
  });

  it("registerRunTestsTool is not exported from implement.ts (T10)", async () => {
    const mod = await import("../extensions/implement.ts");
    assert.equal(
      (mod as unknown as Record<string, unknown>)["registerRunTestsTool"],
      undefined,
    );
  });

  it("back_to_finalize is not exported from implement.ts (T8)", async () => {
    const mod = await import("../extensions/implement.ts");
    assert.equal(
      (mod as unknown as Record<string, unknown>)["registerBackToFinalizeTool"],
      undefined,
    );
  });
});

// ═══ complete_implementation gate ═══
describe("complete_implementation", () => {
  async function runComplete(state: WorkflowState) {
    const pi = mockPi();
    registerCompleteImplementationTool(pi);
    const ctx = ctxWithState(state);
    return getTool(pi, "complete_implementation")!.execute("c1", {}, undefined, undefined, ctx);
  }

  it("refuses while a behavior is still active", async () => {
    const s = finalizingState();
    s.phase = "implementing";
    const res = await runComplete(s);
    assert.equal(res.isError, true);
    assert.match(res.content[0].text, /active/);
    assert.equal(s.phase, "implementing");
  });

  it("succeeds when all behaviors are done even with stale failing results (T9)", async () => {
    const s = finalizingState();
    s.phase = "implementing";
    s.task!.behaviors[0].status = "done";
    s.lastTestResults = { passed: 1, failed: 2 };
    const res = await runComplete(s);
    assert.notEqual(res.isError, true);
    assert.equal(s.phase, "idle");
  });

  it("succeeds when all behaviors are done with no test run recorded (T9)", async () => {
    const s = finalizingState();
    s.phase = "implementing";
    s.task!.behaviors[0].status = "done";
    const res = await runComplete(s);
    assert.notEqual(res.isError, true);
    assert.equal(s.phase, "idle");
  });

  it("succeeds and returns to idle when all done and tests green", async () => {
    const s = finalizingState();
    s.phase = "implementing";
    s.task!.behaviors[0].status = "done";
    s.lastTestResults = { passed: 3, failed: 0 };
    const res = await runComplete(s);
    assert.notEqual(res.isError, true);
    assert.equal(s.phase, "idle");
  });
});

// ═══ mark_task_done ═══
describe("mark_task_done", () => {
  it("marks a behavior done", async () => {
    const pi = mockPi();
    registerMarkTaskDoneTool(pi);
    const s = finalizingState();
    s.phase = "implementing";
    const ctx = ctxWithState(s);

    const res = await getTool(pi, "mark_task_done")!.execute(
      "c1",
      { behaviorId: "T1", evidence: "tests passed" },
      undefined,
      undefined,
      ctx,
    );

    assert.notEqual(res.isError, true);
    assert.equal(s.task!.behaviors[0].status, "done");
  });

  it("rejects a behaviorId not in the contract", async () => {
    const pi = mockPi();
    registerMarkTaskDoneTool(pi);
    const s = finalizingState();
    s.phase = "implementing";
    const ctx = ctxWithState(s);

    const res = await getTool(pi, "mark_task_done")!.execute(
      "c1",
      { behaviorId: "T99", evidence: "x" },
      undefined,
      undefined,
      ctx,
    );

    assert.equal(res.isError, true);
    assert.match(res.content[0].text, /not in contract/);
  });
});
