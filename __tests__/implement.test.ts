import { describe, it } from "vitest";
import assert from "node:assert/strict";
import {
  runImplement,
  registerRunTestsTool,
  registerMarkTaskDoneTool,
  registerCompleteImplementationTool,
} from "../extensions/implement.ts";
import type { WorkflowState, TaskContract } from "../extensions/state.ts";
import type { ImplementerReport } from "../extensions/subagent-runner.ts";
import type {
  ExtensionAPI,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";

const DEFAULT_ACTIVE_TOOLS = ["read", "bash", "write", "edit", "commit_changes"];

function mockPi(activeTools: string[] = DEFAULT_ACTIVE_TOOLS): ExtensionAPI & { calls: Record<string, unknown[]> } {
  const calls: Record<string, unknown[]> = {};
  const record = (name: string) => {
    calls[name] = [];
    return (...args: unknown[]) => {
      calls[name]!.push(args);
    };
  };
  return {
    on: record("on") as ExtensionAPI["on"],
    registerCommand: record("registerCommand") as ExtensionAPI["registerCommand"],
    registerTool: record("registerTool") as ExtensionAPI["registerTool"],
    appendEntry: record("appendEntry") as ExtensionAPI["appendEntry"],
    sendUserMessage: record("sendUserMessage") as ExtensionAPI["sendUserMessage"],
    getActiveTools: () => [...activeTools],
    getAllTools: () => activeTools.map((name) => ({ name })),
    setActiveTools: record("setActiveTools") as ExtensionAPI["setActiveTools"],
    exec: async () => ({ stdout: "", stderr: "", exitCode: 0 }),
    calls,
  } as unknown as ExtensionAPI & { calls: typeof calls };
}

function ctxWithState(state: WorkflowState | null): ExtensionContext {
  return {
    cwd: "/tmp/test",
    sessionManager: {
      getBranch: () =>
        state
          ? [{ type: "custom", customType: "workflow-state", data: state }]
          : [],
    },
    ui: {
      notify: () => {},
      setStatus: () => {},
      setWidget: () => {},
      setTitle: () => {},
      theme: { fg: (_c: string, t: string) => t },
      addAutocompleteProvider: () => {},
    },
  } as unknown as ExtensionContext;
}

function finalizingState(): WorkflowState {
  return {
    phase: "finalizing",
    specText: "topic",
    task: {
      title: "My Task",
      instruction: "do the thing",
      files: ["src/a.ts"],
      done: "tests pass",
      behaviors: [
        { id: "T1", description: "x", expectedOutput: "y", kind: "test", status: "active" },
      ],
    },
  };
}

function getTool(pi: ExtensionAPI & { calls: Record<string, unknown[]> }, name: string) {
  const entries = (pi.calls["registerTool"] ?? []) as Array<[{ name: string; execute: Function }]>;
  return entries.find(([d]) => d.name === name)?.[0];
}

// ═══ runImplement ═══
describe("runImplement", () => {
  it("transitions finalizing → implementing and consumes state.task (T2)", async () => {
    const pi = mockPi();
    const state = finalizingState();
    const ctx = ctxWithState(state);

    await runImplement("--solo", pi, ctx);

    assert.equal(state.phase, "implementing");
    const append = pi.calls["appendEntry"] ?? [];
    const [, saved] = append[append.length - 1] as [string, WorkflowState];
    assert.equal(saved.phase, "implementing");
  });

  it("sends a steer message", async () => {
    const pi = mockPi();
    const ctx = ctxWithState(finalizingState());

    await runImplement("--solo", pi, ctx);

    const send = pi.calls["sendUserMessage"] ?? [];
    assert.ok(send.length >= 1);
    const [, opts] = send[0] as [string, { deliverAs: string }];
    assert.equal(opts.deliverAs, "steer");
  });

  it("does not touch the active toolset (T1)", async () => {
    const pi = mockPi();
    const ctx = ctxWithState(finalizingState());

    await runImplement("--solo", pi, ctx);

    const setCalls = pi.calls["setActiveTools"] ?? [];
    assert.equal(setCalls.length, 0);
  });

  it("does nothing when not in the finalizing phase", async () => {
    const pi = mockPi();
    const s = finalizingState();
    s.phase = "discussing";
    const ctx = ctxWithState(s);

    await runImplement("", pi, ctx);

    assert.equal(s.phase, "discussing");
    assert.equal((pi.calls["sendUserMessage"] ?? []).length, 0);
  });

  it("appends an Engineer's note when args are provided (T5)", async () => {
    const pi = mockPi();
    const ctx = ctxWithState(finalizingState());

    await runImplement("--solo also wire the retry", pi, ctx);

    const send = pi.calls["sendUserMessage"] ?? [];
    assert.equal(send.length, 1);
    const [text] = send[0] as [string];
    assert.match(text, /## Engineer's note/);
    assert.match(text, /also wire the retry/);
    assert.match(text, /authoritative contract/);
    assert.match(text, /tell the user to run \/finalize/);
  });

  it("sends no note section when args are empty", async () => {
    const pi = mockPi();
    const ctx = ctxWithState(finalizingState());

    await runImplement("--solo", pi, ctx);

    const send = pi.calls["sendUserMessage"] ?? [];
    const [text] = send[0] as [string];
    assert.doesNotMatch(text, /## Engineer's note/);
  });

  it("notifies with the aligned TDD entry message", async () => {
    const pi = mockPi();
    const ctx = ctxWithState(finalizingState());
    const notifyCalls: string[] = [];
    ctx.ui.notify = (msg: string) => {
      notifyCalls.push(msg);
    };

    await runImplement("--solo", pi, ctx);

    assert.equal(notifyCalls.length, 1, "runImplement should notify exactly once");
    assert.match(notifyCalls[0], /Starting TDD implementation/);
    assert.match(notifyCalls[0], /behavior by behavior/);
  });
});

// ═══ T1: capability-conditional commit instruction ═══
describe("T1: capability-conditional commit instruction", () => {
  it("buildTddPrompt(task, true) instructs commit_changes after each mark, no behavior id", async () => {
    const { buildTddPrompt } = await import("../extensions/implement.ts");
    const prompt = await buildTddPrompt(finalizingState().task!, true);
    assert.match(prompt, /commit_changes/);
    assert.match(prompt, /conventional/i);
    assert.match(prompt, /after each `mark_task_done`/i);
    assert.match(prompt, /Do NOT include the behavior id/i);
  });

  it("buildTddPrompt(task, false) contains no commit instruction", async () => {
    const { buildTddPrompt } = await import("../extensions/implement.ts");
    const prompt = await buildTddPrompt(finalizingState().task!, false);
    assert.doesNotMatch(prompt, /commit_changes/);
  });

  it("runImplement injects the instruction when commit_changes is registered", async () => {
    const pi = mockPi(["read", "commit_changes"]);
    const ctx = ctxWithState(finalizingState());

    await runImplement("--solo", pi, ctx);

    const [text] = (pi.calls["sendUserMessage"] ?? [])[0] as [string];
    assert.match(text, /commit_changes/);
  });

  it("runImplement omits the instruction when commit_changes is absent", async () => {
    const pi = mockPi(["read", "bash"]);
    const ctx = ctxWithState(finalizingState());

    await runImplement("--solo", pi, ctx);

    const [text] = (pi.calls["sendUserMessage"] ?? [])[0] as [string];
    assert.doesNotMatch(text, /commit_changes/);
  });
});

// ═══ T2: HEAD tracking and soft warn ═══
describe("T2: HEAD tracking and soft warn", () => {
  function implementingState(overrides: Partial<WorkflowState> = {}): WorkflowState {
    return { ...finalizingState(), phase: "implementing", ...overrides };
  }

  function piWithHead(head: string | null): ExtensionAPI & { calls: Record<string, unknown[]> } {
    const pi = mockPi();
    pi.exec = async () => {
      if (head === null) throw new Error("not a git repository");
      return { stdout: `${head}\n`, stderr: "", exitCode: 0 };
    };
    return pi;
  }

  it("runImplement records baselineHead at start", async () => {
    const pi = piWithHead("abc123");
    const state = finalizingState();
    const ctx = ctxWithState(state);

    await runImplement("--solo", pi, ctx);

    assert.equal(state.baselineHead, "abc123");
  });

  it("runImplement leaves baselineHead undefined when git fails", async () => {
    const pi = piWithHead(null);
    const state = finalizingState();
    const ctx = ctxWithState(state);

    await runImplement("--solo", pi, ctx);

    assert.equal(state.baselineHead, undefined);
  });

  async function mark(pi: ExtensionAPI, state: WorkflowState, behaviorId = "T1") {
    registerMarkTaskDoneTool(pi);
    const ctx = ctxWithState(state);
    return getTool(pi, "mark_task_done")!.execute(
      "c1",
      { behaviorId, evidence: "verified" },
      undefined,
      undefined,
      ctx,
    );
  }

  it("warns suggesting commit_changes when HEAD unchanged since baseline", async () => {
    const pi = piWithHead("abc");
    const state = implementingState({ baselineHead: "abc" });

    const res = await mark(pi, state);

    assert.notEqual(res.isError, true, "mark must still succeed");
    assert.match(res.content[0].text, /no commit detected/i);
    assert.match(res.content[0].text, /commit_changes/);
    assert.equal(state.task!.behaviors[0].status, "done");
  });

  it("no warning when HEAD advanced since the previous mark", async () => {
    const pi = piWithHead("def");
    const state = implementingState({ baselineHead: "abc" });

    const res = await mark(pi, state);

    assert.notEqual(res.isError, true);
    assert.doesNotMatch(res.content[0].text, /no commit detected/i);
    assert.equal(state.lastMarkedHead, "def", "lastMarkedHead should record the advanced head");
  });

  it("warns on the second mark when HEAD unchanged since previous mark", async () => {
    const pi = piWithHead("def");
    const state = implementingState({
      baselineHead: "abc",
      lastMarkedHead: "def",
      task: {
        ...finalizingState().task!,
        behaviors: [
          { id: "T1", description: "x", expectedOutput: "y", kind: "test", status: "done" },
          { id: "T2", description: "z", expectedOutput: "w", kind: "test", status: "active" },
        ],
      },
    });

    const res = await mark(pi, state, "T2");

    assert.notEqual(res.isError, true);
    assert.match(res.content[0].text, /no commit detected/i);
  });

  it("succeeds with no warning when git rev-parse fails", async () => {
    const pi = piWithHead(null);
    const state = implementingState({ baselineHead: "abc" });

    const res = await mark(pi, state);

    assert.notEqual(res.isError, true, "mark must succeed even when git fails");
    assert.doesNotMatch(res.content[0].text, /no commit detected/i);
    assert.equal(state.task!.behaviors[0].status, "done");
  });

  it("loads and marks cleanly on sessions persisted before the HEAD fields existed", async () => {
    const pi = piWithHead("abc");
    // Legacy shape: no baselineHead / lastMarkedHead fields at all.
    const legacy = {
      phase: "implementing",
      specText: "old",
      task: finalizingState().task,
    } as WorkflowState;

    const res = await mark(pi, legacy);

    assert.notEqual(res.isError, true);
    assert.equal(legacy.task!.behaviors[0].status, "done");
  });
});

// ═══ T3: orchestrator default loop ═══
describe("T3: orchestrator default loop", () => {
  function orchTask(): TaskContract {
    return {
      title: "Orch Task",
      instruction: "do things",
      files: ["src/a.ts"],
      done: "all green",
      behaviors: [
        { id: "T1", description: "first behavior", expectedOutput: "e1", kind: "test", status: "active" },
        { id: "T2", description: "second behavior", expectedOutput: "e2", kind: "test", status: "active" },
        { id: "T3", description: "removed one", expectedOutput: "e3", kind: "test", status: "removed" },
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
        return { stdout: `head${++headCounter}\n`, stderr: "", exitCode: 0 };
      }
      if (cmd === "git" && args[0] === "status") {
        return { stdout: " M src/a.ts\n", stderr: "", exitCode: 0 };
      }
      if (cmd === "git" && args[0] === "commit") {
        return { stdout: "committed", stderr: "", exitCode: 0 };
      }
      if (cmd === "npm") {
        return { stdout: "2 passed", stderr: "", exitCode: 0 };
      }
      return { stdout: "", stderr: "", exitCode: 0 };
    }) as ExtensionAPI["exec"];
    return { pi, execLog };
  }

  function recordingRunner(
    calls: string[],
    _taskTexts: string[],
    maxActiveRef: { value: number },
  ) {
    let active = 0;
    return async (unit: { behaviorId: string }): Promise<ImplementerReport> => {
      active++;
      maxActiveRef.value = Math.max(maxActiveRef.value, active);
      calls.push(unit.behaviorId);
      await new Promise((r) => setTimeout(r, 5));
      active--;
      return {
        summary: `implemented ${unit.behaviorId}`,
        suggestedCommit: `feat(core): add ${unit.behaviorId === "T1" ? "first behavior" : "second behavior"}`,
      };
    };
  }

  it("default /implement runs one sequential unit per active behavior: verify → commit → mark", async () => {
    const { pi, execLog } = piWithExecLog();
    const state: WorkflowState = { phase: "finalizing", specText: "topic", task: orchTask() };
    const ctx = ctxWithState(state);
    const calls: string[] = [];
    const maxActiveRef = { value: 0 };

    await runImplement("", pi, ctx, recordingRunner(calls, [], maxActiveRef));

    assert.deepEqual(calls, ["T1", "T2"], "one spawn per active behavior, in order, removed skipped");
    assert.equal(maxActiveRef.value, 1, "units must run strictly sequentially");
    assert.equal(state.phase, "idle", "orchestrator completes the workflow on its own");
    assert.ok(
      state.task!.behaviors.every((b) => b.status !== "active"),
      "all non-removed behaviors should be done",
    );
    assert.deepEqual(state.lastTestResults, { passed: 2, failed: 0 });

    const seq = execLog
      .filter((e) => e.cmd === "npm" || (e.cmd === "git" && e.args[0] === "commit"))
      .map((e) => (e.cmd === "npm" ? "test" : `commit:${e.args[2]}`));
    assert.deepEqual(
      seq,
      [
        "test",
        "commit:feat(core): add first behavior",
        "test",
        "commit:feat(core): add second behavior",
      ],
      "each unit must be verified with run_tests before its commit, using the suggested conventional subject",
    );
  });

  it("--solo restores the in-session steer loop", async () => {
    const { pi, execLog } = piWithExecLog();
    const state: WorkflowState = { phase: "finalizing", specText: "topic", task: orchTask() };
    const ctx = ctxWithState(state);

    await runImplement("--solo", pi, ctx);

    const send = pi.calls["sendUserMessage"] ?? [];
    assert.equal(send.length, 1, "solo mode steers the in-session agent");
    const [, opts] = send[0] as [string, { deliverAs: string }];
    assert.equal(opts.deliverAs, "steer");
    assert.equal(state.phase, "implementing", "solo mode does not self-complete");
    assert.ok(
      !execLog.some((e) => e.cmd === "git" && e.args[0] === "commit"),
      "solo mode must not commit from extension code",
    );
  });
});

// ═══ T4: retry once, halt with handoff, resume on re-run ═══
describe("T4: retry once, halt with handoff, resume on re-run", () => {
  function t4Task(): TaskContract {
    return {
      title: "T4 Task",
      instruction: "do things",
      files: ["src/a.ts"],
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
        return { stdout: `head${++headCounter}\n`, stderr: "", exitCode: 0 };
      }
      if (cmd === "git" && args[0] === "status") {
        return { stdout: " M src/a.ts\n", stderr: "", exitCode: 0 };
      }
      if (cmd === "git" && args[0] === "commit") {
        return { stdout: "committed", stderr: "", exitCode: 0 };
      }
      if (cmd === "npm") {
        return { stdout: "2 passed", stderr: "", exitCode: 0 };
      }
      return { stdout: "", stderr: "", exitCode: 0 };
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

    await runImplement("", pi, ctx, failingThenSucceedingRunner(spawns, "T1", "boom: cannot write file"));

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

  it("halts after the second failure with a handoff report; phase stays implementing", async () => {
    const { pi } = piWithExecLog();
    const state: WorkflowState = { phase: "finalizing", specText: "topic", task: t4Task() };
    const ctx = ctxWithState(state);
    const notifyCalls: string[] = [];
    ctx.ui.notify = (msg: string) => {
      notifyCalls.push(msg);
    };
    const spawns: Spawn[] = [];

    await runImplement(
      "",
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
      ["T1", "T2", "T2"],
      "T1 once, T2 twice (attempt + one retry), then stop — no further spawns",
    );
    assert.equal(state.phase, "implementing", "halt must not complete the workflow");
    assert.equal(state.task!.behaviors[0]!.status, "done");
    assert.equal(state.task!.behaviors[1]!.status, "active");

    const report = notifyCalls[notifyCalls.length - 1]!;
    assert.match(report, /T2/, "report names the failed unit");
    assert.match(report, /EACCES: permission denied/, "report carries the error");
    assert.match(report, /M src\/a\.ts/, "report carries the tree state");
    assert.match(
      report,
      /feat\(core\): add first behavior/,
      "report lists commits landed so far",
    );
    assert.match(report, /\/implement again to resume/, "report tells the user how to resume");
  });

  it("re-running /implement resumes from the first active behavior only", async () => {
    const { pi } = piWithExecLog();
    const task = t4Task();
    task.behaviors[0]!.status = "done"; // simulate partial progress from a prior run
    const state: WorkflowState = { phase: "implementing", specText: "topic", task };
    const ctx = ctxWithState(state);
    const spawns: Spawn[] = [];

    await runImplement("", pi, ctx, async (unit: Spawn) => {
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
    const { generateReport } = await import("../extensions/implement.ts");
    const state: WorkflowState = {
      phase: "idle",
      specText: "topic",
      lastTestResults: { passed: 4, failed: 0, coveragePercent: 92 },
      task: {
        title: "Ship the thing",
        instruction: "do the thing",
        files: ["src/a.ts"],
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
    const { generateReport } = await import("../extensions/implement.ts");
    const state: WorkflowState = {
      phase: "idle",
      specText: "topic",
      lastTestResults: { passed: 4, failed: 0 },
      task: {
        title: "Ship the thing",
        instruction: "do the thing",
        files: ["src/a.ts"],
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

// ═══ tool registration (T8) ═══
describe("implement tool registration", () => {
  it("registers exactly run_tests, mark_task_done, complete_implementation", () => {
    const pi = mockPi();
    registerRunTestsTool(pi);
    registerMarkTaskDoneTool(pi);
    registerCompleteImplementationTool(pi);

    const names = ((pi.calls["registerTool"] ?? []) as Array<[{ name: string }]>)
      .map(([d]) => d.name);
    assert.deepEqual(names.sort(), [
      "complete_implementation",
      "mark_task_done",
      "run_tests",
    ]);
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

  it("refuses when a test behavior exists but tests are failing", async () => {
    const s = finalizingState();
    s.phase = "implementing";
    s.task!.behaviors[0].status = "done";
    s.lastTestResults = { passed: 1, failed: 2 };
    const res = await runComplete(s);
    assert.equal(res.isError, true);
    assert.match(res.content[0].text, /failing/);
    assert.equal(s.phase, "implementing");
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
