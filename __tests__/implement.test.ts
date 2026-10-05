import { describe, it } from "vitest";
import assert from "node:assert/strict";
import {
  runImplement,
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

// ═══ T1: HEAD-gate success path ═══
describe("T1: HEAD-gate success path", () => {
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

  /** Exec mock where git commit succeeds and HEAD advances on each commit. */
  function piWithGit(): { pi: ExtensionAPI & { calls: Record<string, unknown[]> }; execLog: ExecLogEntry[] } {
    const pi = mockPi();
    const execLog: ExecLogEntry[] = [];
    let headCounter = 0;
    pi.exec = (async (cmd: string, args: string[]) => {
      execLog.push({ cmd, args });
      if (cmd === "git" && args[0] === "rev-parse") {
        return { stdout: `head${headCounter}\n`, stderr: "", exitCode: 0 };
      }
      if (cmd === "git" && args[0] === "status") {
        return { stdout: "", stderr: "", exitCode: 0 };
      }
      if (cmd === "git" && args[0] === "add") {
        return { stdout: "", stderr: "", exitCode: 0 };
      }
      if (cmd === "git" && args[0] === "commit") {
        headCounter++;
        return { stdout: "[main abc] committed", stderr: "", exitCode: 0 };
      }
      return { stdout: "", stderr: "", exitCode: 0 };
    }) as ExtensionAPI["exec"];
    return { pi, execLog };
  }

  function recordingRunner(calls: string[], maxActiveRef: { value: number }) {
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

  it("runs one sequential unit per active behavior: commit → HEAD gate → mark", async () => {
    const { pi, execLog } = piWithGit();
    const state: WorkflowState = { phase: "finalizing", specText: "topic", task: orchTask() };
    const ctx = ctxWithState(state);
    const calls: string[] = [];
    const maxActiveRef = { value: 0 };

    await runImplement("", pi, ctx, recordingRunner(calls, maxActiveRef));

    assert.deepEqual(calls, ["T1", "T2"], "one spawn per active behavior, in order, removed skipped");
    assert.equal(maxActiveRef.value, 1, "units must run strictly sequentially");
    assert.equal(state.phase, "idle", "orchestrator completes the workflow on its own");
    assert.ok(
      state.task!.behaviors.every((b) => b.status !== "active"),
      "all non-removed behaviors should be done",
    );
    assert.equal(
      state.lastTestResults,
      undefined,
      "the loop never runs a test command — lastTestResults stays untouched",
    );

    const commits = execLog
      .filter((e) => e.cmd === "git" && e.args[0] === "commit")
      .map((e) => e.args[2]);
    assert.deepEqual(
      commits,
      ["feat(core): add first behavior", "feat(core): add second behavior"],
      "each unit commits with the suggested conventional subject",
    );

    const nonGit = execLog.filter((e) => e.cmd !== "git");
    assert.deepEqual(
      nonGit,
      [],
      "no test runner (or any non-git command) is ever exec'ed — hooks own verification",
    );

    const commands = execLog.map((e) => (e.cmd === "git" ? e.args[0] : e.cmd));
    for (const c of commands) {
      assert.ok(
        ["rev-parse", "status", "add", "commit"].includes(c),
        `only git plumbing is allowed, got: ${c}`,
      );
    }
  });

  it("--solo restores the in-session steer loop", async () => {
    const { pi, execLog } = piWithGit();
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

// ═══ T2: HEAD-gate hook-rejection path ═══
describe("T2: HEAD-gate hook-rejection path", () => {
  const HOOK_STDERR =
    "golangci-lint run failed\n" +
    "internal/app/services/sts/approve.go:42:1: undefined: Probe\n" +
    "exit status 1";

  /** Exec mock where the pre-commit hook always rejects: HEAD never moves, tree dirty. */
  function piWithRejectingHook() {
    const pi = mockPi();
    const execLog: Array<{ cmd: string; args: string[] }> = [];
    pi.exec = (async (cmd: string, args: string[]) => {
      execLog.push({ cmd, args });
      if (cmd === "git" && args[0] === "rev-parse") {
        return { stdout: "headA\n", stderr: "", exitCode: 0 };
      }
      if (cmd === "git" && args[0] === "status") {
        return { stdout: " M src/a.ts\n", stderr: "", exitCode: 0 };
      }
      if (cmd === "git" && args[0] === "diff") {
        return { stdout: " src/a.ts | 2 +-\n", stderr: "", exitCode: 0 };
      }
      if (cmd === "git" && args[0] === "commit") {
        return { stdout: "", stderr: HOOK_STDERR, exitCode: 1 };
      }
      return { stdout: "", stderr: "", exitCode: 0 };
    }) as ExtensionAPI["exec"];
    return { pi, execLog };
  }

  function oneBehaviorTask(): TaskContract {
    return {
      title: "Hook Task",
      instruction: "do things",
      files: ["src/a.ts"],
      done: "all green",
      behaviors: [
        { id: "T1", description: "first behavior", expectedOutput: "e1", kind: "test", status: "active" },
      ],
    };
  }

  it("spawns one fix subagent carrying the investigation, raw hook output, and original task", async () => {
    const { pi } = piWithRejectingHook();
    const state: WorkflowState = { phase: "finalizing", specText: "topic", task: oneBehaviorTask() };
    const ctx = ctxWithState(state);
    const spawns: Array<{ behaviorId: string; taskText: string }> = [];

    // Initial unit succeeds; the fix subagent crashes → loop halts via the
    // exception-safety path, leaving the behavior active with no commit.
    await runImplement("", pi, ctx, async (unit) => {
      spawns.push({ behaviorId: unit.behaviorId, taskText: unit.taskText });
      if (spawns.length === 1) {
        return { summary: "implemented T1", suggestedCommit: "feat(core): add first behavior" };
      }
      throw new Error("fix agent crashed");
    });

    assert.equal(spawns.length, 2, "initial unit + exactly one fix subagent");
    const fix = spawns[1]!;
    assert.equal(fix.behaviorId, "T1");
    assert.match(fix.taskText, /Previous attempt failed \(retry 1\/5\)/, "fix spawn is a budgeted retry");
    assert.match(fix.taskText, /Investigation: commit for T1 did not land/);
    assert.match(fix.taskText, /git commit exit code: 1/);
    assert.match(fix.taskText, /failing stage \(best-effort\): lint/);
    assert.match(fix.taskText, /git status --short: M src\/a\.ts/);
    assert.match(fix.taskText, /diff --stat: src\/a\.ts \| 2 \+-/);
    assert.match(fix.taskText, /Raw hook output/);
    assert.match(fix.taskText, /golangci-lint run failed/);
    assert.match(fix.taskText, /approve\.go:42/, "raw hook stderr tail is included");
    assert.match(fix.taskText, /Original task/);
    assert.match(fix.taskText, /Implement ONE behavior: T1\./, "original behavior task text preserved");

    assert.equal(state.task!.behaviors[0]!.status, "active", "behavior stays active after the halt");
    assert.equal(state.phase, "implementing", "phase stays implementing for resume");
    const commits = (pi.calls["appendEntry"] ?? []).length;
    assert.ok(commits >= 1, "state was persisted");
  });

  it("spawns exactly 5 fix subagents on persistent rejection, then halts with lastHalt carrying the investigation", async () => {
    const { pi } = piWithRejectingHook();
    const state: WorkflowState = { phase: "finalizing", specText: "topic", task: oneBehaviorTask() };
    const ctx = ctxWithState(state);
    const spawns: Array<{ behaviorId: string; taskText: string }> = [];

    await runImplement("", pi, ctx, async (unit) => {
      spawns.push({ behaviorId: unit.behaviorId, taskText: unit.taskText });
      return { summary: `attempt ${spawns.length}`, suggestedCommit: "feat(core): add first behavior" };
    });

    assert.deepEqual(
      spawns.map((s) => s.behaviorId),
      ["T1", "T1", "T1", "T1", "T1", "T1"],
      "initial + exactly 5 retries (RETRY_BUDGET), then the loop halts",
    );
    assert.match(spawns[5]!.taskText, /retry 5\/5/, "the fifth retry is the last allowed");

    assert.equal(state.phase, "implementing", "halt keeps the implementing phase");
    assert.equal(state.task!.behaviors[0]!.status, "active");

    const append = pi.calls["appendEntry"] ?? [];
    const lastSaved = append[append.length - 1] as [string, WorkflowState];
    const halt = lastSaved[1].lastHalt;
    assert.equal(lastSaved[0], "workflow-state", "handoff persisted as a session entry");
    assert.equal(halt?.behaviorId, "T1");
    assert.match(halt?.error ?? "", /pre-commit hook rejected the commit for T1 after 5 retries/);
    assert.match(halt?.error ?? "", /golangci-lint run failed/, "lastHalt.error carries the investigation incl. hook output");
    assert.ok(Array.isArray(halt?.landedCommits), "landedCommits recorded");
    assert.equal(typeof halt?.at, "string", "timestamp recorded");
    assert.equal(typeof halt?.treeState, "string", "tree state recorded");
  });

  it("no-changes anomaly: retry note, budget-counted, behavior never marked done", async () => {
    // Hook path irrelevant here: the unit lands no file changes, so the
    // commit finds nothing to commit — HEAD unchanged, tree clean.
    const pi = mockPi();
    pi.exec = (async (cmd: string, args: string[]) => {
      if (cmd === "git" && args[0] === "rev-parse") {
        return { stdout: "headA\n", stderr: "", exitCode: 0 };
      }
      if (cmd === "git" && args[0] === "status") {
        return { stdout: "", stderr: "", exitCode: 0 };
      }
      if (cmd === "git" && args[0] === "diff") {
        return { stdout: "", stderr: "", exitCode: 0 };
      }
      if (cmd === "git" && args[0] === "commit") {
        return { stdout: "", stderr: "nothing to commit, working tree clean", exitCode: 1 };
      }
      return { stdout: "", stderr: "", exitCode: 0 };
    }) as ExtensionAPI["exec"];

    const state: WorkflowState = { phase: "finalizing", specText: "topic", task: oneBehaviorTask() };
    const ctx = ctxWithState(state);
    const spawns: Array<{ taskText: string }> = [];

    await runImplement("", pi, ctx, async (unit) => {
      spawns.push({ taskText: unit.taskText });
      return { summary: `attempt ${spawns.length}`, suggestedCommit: "feat(core): add first behavior" };
    });

    assert.equal(spawns.length, 6, "initial + 5 budgeted retries for the no-changes anomaly");
    assert.match(spawns[1]!.taskText, /No changes detected for T1/, "first retry instruction names the anomaly");
    assert.match(spawns[1]!.taskText, /retry 1\/5/);
    assert.match(spawns[5]!.taskText, /retry 5\/5/);
    assert.equal(state.task!.behaviors[0]!.status, "active", "behavior is never marked done without changes");
    assert.equal(state.phase, "implementing");

    const append = pi.calls["appendEntry"] ?? [];
    const lastSaved = append[append.length - 1] as [string, WorkflowState];
    assert.match(lastSaved[1].lastHalt?.error ?? "", /no changes detected for T1 after 5 retries/);
    assert.match(lastSaved[1].lastHalt?.error ?? "", /No changes detected for T1/);
  });

  it("commit-process timeout halts as infrastructure failure — no fix subagent spawned", async () => {
    const pi = mockPi();
    pi.exec = (async (cmd: string, args: string[]) => {
      if (cmd === "git" && args[0] === "rev-parse") {
        return { stdout: "headA\n", stderr: "", exitCode: 0 };
      }
      if (cmd === "git" && args[0] === "commit") {
        // Simulate pi.exec hitting the timeout budget.
        throw new Error("Command timed out after 300000ms: git commit");
      }
      return { stdout: "", stderr: "", exitCode: 0 };
    }) as ExtensionAPI["exec"];

    const state: WorkflowState = { phase: "finalizing", specText: "topic", task: oneBehaviorTask() };
    const ctx = ctxWithState(state);
    const notifyCalls: string[] = [];
    ctx.ui.notify = (msg: string) => {
      notifyCalls.push(msg);
    };
    const spawns: Array<{ taskText: string }> = [];

    await runImplement("", pi, ctx, async (unit) => {
      spawns.push({ taskText: unit.taskText });
      return { summary: "implemented T1", suggestedCommit: "feat(core): add first behavior" };
    });

    assert.equal(spawns.length, 1, "timeout must NOT spawn a fix subagent — retrying cannot fix a slow hook");
    assert.equal(state.phase, "implementing", "halt keeps the implementing phase");
    assert.equal(state.task!.behaviors[0]!.status, "active");

    const append = pi.calls["appendEntry"] ?? [];
    const lastSaved = append[append.length - 1] as [string, WorkflowState];
    const halt = lastSaved[1].lastHalt;
    assert.equal(halt?.behaviorId, "T1");
    assert.match(halt?.error ?? "", /timed out after 300000ms/, "lastHalt.error names the timeout with the budget");
    assert.match(halt?.error ?? "", /PI_COMMIT_TIMEOUT_MS/);
    assert.match(halt?.error ?? "", /infrastructure failure, not a hook verdict/i);
    assert.doesNotMatch(
      halt?.error ?? "",
      /pre-commit hook rejected/,
      "a timeout must not be reported as a hook verdict",
    );

    const report = notifyCalls[notifyCalls.length - 1]!;
    assert.match(report, /timed out after 300000ms/, "handoff names the timeout");
  });
});

// ═══ T11: resume safety — dirty-tree context on resumed units ═══
describe("T11: resume safety", () => {
  function resumingState(): WorkflowState {
    return {
      phase: "implementing",
      specText: "topic",
      baselineHead: "headA",
      task: {
        title: "Resume Task",
        instruction: "do things",
        files: ["src/a.ts"],
        done: "all green",
        behaviors: [
          { id: "T1", description: "first behavior", expectedOutput: "e1", kind: "test", status: "active" },
        ],
      },
    };
  }

  function piWith(statusOutput: string) {
    const pi = mockPi();
    let headCounter = 0;
    pi.exec = (async (cmd: string, args: string[]) => {
      if (cmd === "git" && args[0] === "rev-parse") {
        return { stdout: `head${headCounter}\n`, stderr: "", exitCode: 0 };
      }
      if (cmd === "git" && args[0] === "status") {
        return { stdout: statusOutput, stderr: "", exitCode: 0 };
      }
      if (cmd === "git" && args[0] === "commit") {
        headCounter++;
        return { stdout: "[main abc] committed", stderr: "", exitCode: 0 };
      }
      return { stdout: "", stderr: "", exitCode: 0 };
    }) as ExtensionAPI["exec"];
    return pi;
  }

  it("appends the dirty-tree output to the first resumed unit's task text", async () => {
    const pi = piWith(" M src/a.ts\n?? src/new.ts\n");
    const state = resumingState();
    const ctx = ctxWithState(state);
    const spawns: Array<{ taskText: string }> = [];

    await runImplement("", pi, ctx, async (unit) => {
      spawns.push({ taskText: unit.taskText });
      return { summary: "done", suggestedCommit: "feat(core): add first behavior" };
    });

    assert.equal(spawns.length, 1);
    assert.match(spawns[0]!.taskText, /Working tree is dirty \(resumed session\)/);
    assert.match(spawns[0]!.taskText, /M src\/a\.ts/);
    assert.match(spawns[0]!.taskText, /src\/new\.ts/);
    assert.equal(state.phase, "idle", "resume completes the workflow");
  });

  it("appends no tree section when the tree is clean", async () => {
    const pi = piWith("");
    const state = resumingState();
    const ctx = ctxWithState(state);
    const spawns: Array<{ taskText: string }> = [];

    await runImplement("", pi, ctx, async (unit) => {
      spawns.push({ taskText: unit.taskText });
      return { summary: "done", suggestedCommit: "feat(core): add first behavior" };
    });

    assert.equal(spawns.length, 1);
    assert.doesNotMatch(spawns[0]!.taskText, /Working tree is dirty/);
  });
});

// ═══ T10: deletions — no test-command detection or execution in extensions/ ═══
describe("T10: test-runner machinery is fully deleted", () => {
  it("no detectTestCommand/verifyTests implementation or reference remains in extensions/", async () => {
    const { readdirSync, readFileSync } = await import("node:fs");
    const { resolve } = await import("node:path");
    const dir = resolve(import.meta.dirname!, "..", "extensions");
    const offenders: string[] = [];
    for (const name of readdirSync(dir)) {
      if (!name.endsWith(".ts")) continue;
      const src = readFileSync(resolve(dir, name), "utf-8");
      if (/detectTestCommand|verifyTests/.test(src)) {
        offenders.push(name);
      }
    }
    assert.deepEqual(offenders, [], "no extensions file may reference test-command detection/verify");
  });

  it("no code path in extensions/ execs a test runner", async () => {
    const { readdirSync, readFileSync } = await import("node:fs");
    const { resolve } = await import("node:path");
    const dir = resolve(import.meta.dirname!, "..", "extensions");
    const offenders: string[] = [];
    for (const name of readdirSync(dir)) {
      if (!name.endsWith(".ts")) continue;
      const src = readFileSync(resolve(dir, name), "utf-8");
      // pi.exec calls whose command names a test runner, in any form.
      if (/pi\.exec\([^)]*(vitest|jest|mocha|npm[^\n]*test|go[^\n]*test|pytest|cargo[^\n]*test)/i.test(src)) {
        offenders.push(name);
      }
    }
    assert.deepEqual(offenders, [], "extensions must never exec a test runner");
  });

  it("index.ts no longer imports or registers run_tests", async () => {
    const { readFileSync } = await import("node:fs");
    const { resolve } = await import("node:path");
    const src = readFileSync(resolve(import.meta.dirname!, "..", "extensions", "index.ts"), "utf-8");
    assert.doesNotMatch(src, /registerRunTestsTool/, "index.ts must not import/register run_tests");
    const mod = await import("../extensions/index.ts");
    assert.equal(mod["registerRunTestsTool"], undefined);
  });

  it("wiring asserts run_tests is NOT registered", async () => {
    const { readFileSync } = await import("node:fs");
    const { resolve } = await import("node:path");
    const wiring = readFileSync(resolve(import.meta.dirname!, "wiring.test.ts"), "utf-8");
    assert.match(wiring, /run_tests.*must NOT be registered|!tools\.includes\("run_tests"\)/);
    const tools = readFileSync(resolve(import.meta.dirname!, "tools.test.ts"), "utf-8");
    assert.doesNotMatch(tools, /registerRunTestsTool/);
  });
});

// ═══ T6: exception safety — no unhandled rejection escapes /implement ═══
describe("T6: exception safety in runImplement", () => {
  function oneBehavior(): TaskContract {
    return {
      title: "Crash Task",
      instruction: "do things",
      files: ["src/a.ts"],
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
    await runImplement("", pi, ctx, async () => {
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
      if (cmd === "git" && args[0] === "rev-parse") return { stdout: "headA\n", stderr: "", exitCode: 0 };
      if (cmd === "git" && args[0] === "status") return { stdout: " M src/a.ts\n", stderr: "", exitCode: 0 };
      if (cmd === "git" && args[0] === "diff") return { stdout: " src/a.ts | 2 +-\n", stderr: "", exitCode: 0 };
      if (cmd === "git" && args[0] === "commit") return { stdout: "", stderr: "golangci-lint run failed", exitCode: 1 };
      return { stdout: "", stderr: "", exitCode: 0 };
    }) as ExtensionAPI["exec"];
    const state: WorkflowState = { phase: "finalizing", specText: "topic", task: oneBehavior() };
    const ctx = ctxWithState(state);

    await runImplement("", pi, ctx, async () => ({
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

  it("retries a failing unit up to 5 times, then halts with a persisted handoff", async () => {
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

// ═══ tool registration ═══
describe("implement tool registration", () => {
  it("registers mark_task_done and complete_implementation; run_tests is gone (T10)", async () => {
    const pi = mockPi();
    const mod = await import("../extensions/implement.ts");
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
