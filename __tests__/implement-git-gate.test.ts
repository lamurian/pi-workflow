import { describe, it } from "vitest";
import assert from "node:assert/strict";
import { runImplement } from "../extensions/implement.ts";
import { registerMarkTaskDoneTool } from "../extensions/implement-tools.ts";
import { runOrchestratedImplement } from "../extensions/implement-loop.ts";
import { readGitHead } from "../extensions/git-ops.ts";
import type { WorkflowState, TaskContract } from "../extensions/state.ts";
import type { ImplementerReport } from "../extensions/implementer-report.ts";
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

// ═══ T2: retry spawns carry escalating thinking floors ═══
describe("T2: retry escalation of the child thinking floor", () => {
  it("the first unit carries no floor, retry 1 'medium', retries 2+ 'high'", async () => {
    const pi = mockPi();
    const state = finalizingState();
    const ctx = ctxWithState(state);
    const floors: Array<string | undefined> = [];

    const result = await runOrchestratedViaSeam(pi, ctx, async (unit) => {
      floors.push(unit.thinking);
      return { summary: "", error: "always-fails: unit subprocess died" };
    });

    assert.equal(result.complete, false, "the always-failing run halts");
    assert.equal(floors.length, 6, "initial run + exactly 5 retries exhaust the budget");
    assert.equal(floors[0], undefined, "the first attempt carries no escalation floor");
    assert.equal(floors[1], "medium", "retry 1 escalates to medium");
    assert.deepEqual(
      floors.slice(2),
      ["high", "high", "high", "high"],
      "retries 2+ escalate to high",
    );
  });
});

// ═══ T10: solo prompt commits each task via commit_changes with its task id ═══
describe("T10: solo prompt commit_changes instruction", () => {
  it("buildTddPrompt instructs calling commit_changes with the task id right after each mark_task_done", async () => {
    const { buildTddPrompt } = await import("../extensions/implement-solo.ts");
    const prompt = await buildTddPrompt(finalizingState().task!);
    assert.match(prompt, /Files: src\/a\.ts \(M\)/, "declared paths render in the contract block");
    assert.match(prompt, /commit_changes/, "the prompt names the commit_changes tool");
    assert.match(prompt, /taskId/, "the prompt names the taskId parameter");
    assert.match(prompt, /right after each `mark_task_done`/i, "the commit lands right after each mark");
    assert.match(prompt, /conventional/i, "the commit subject stays conventional");
  });

  it("no longer instructs raw `git add` or `git commit` commands", async () => {
    const { buildTddPrompt } = await import("../extensions/implement-solo.ts");
    const prompt = await buildTddPrompt(finalizingState().task!);
    assert.doesNotMatch(prompt, /`git add/, "no backticked git add command is instructed");
    assert.doesNotMatch(prompt, /git add --/, "no path-scoped staging instruction");
    assert.doesNotMatch(prompt, /`git commit/, "no backticked git commit command is instructed");
    assert.doesNotMatch(prompt, /git commit -m/, "no raw commit -m instruction");
    assert.doesNotMatch(prompt, /git add --all/, "no blanket add --all instruction");
    assert.doesNotMatch(prompt, /git add -A/, "no blanket add -A instruction");
  });

  it("keeps the subject rules: no behavior id, subject ≤75 chars", async () => {
    const { buildTddPrompt } = await import("../extensions/implement-solo.ts");
    const prompt = await buildTddPrompt(finalizingState().task!);
    assert.match(prompt, /≤75 chars/, "the subject length cap is retained");
    assert.match(prompt, /Do NOT include the behavior id/i, "the behavior id stays out of the subject");
  });

  it("retains the pre-existing tdd-prompt.md wording", async () => {
    const { buildTddPrompt } = await import("../extensions/implement-solo.ts");
    const prompt = await buildTddPrompt(finalizingState().task!);
    assert.match(prompt, /run_precommit_check/, "hook-verification direction retained");
    assert.match(prompt, /authoritative/i, "contract-authoritative clause retained");
    assert.match(prompt, /mark_task_done/);
    assert.match(prompt, /immediately/i, "mark-immediately clause retained");
    assert.match(prompt, /prompt discipline/i, "solo prompt-only guard wording retained");
    assert.doesNotMatch(prompt, /run_tests/, "no reference to the deleted run_tests tool");
    assert.doesNotMatch(prompt, /back_to_finalize/, "no back_to_finalize reference");
  });

  it("runImplement steers the commit_changes instruction regardless of tool registration", async () => {
    for (const tools of [["read", "commit_changes"], ["read", "bash"]]) {
      const pi = mockPi(tools);
      const ctx = ctxWithState(finalizingState());

      await runImplement("--solo", pi, ctx);

      const [text] = (pi.calls["sendUserMessage"] ?? [])[0] as [string];
      assert.match(text, /commit_changes/, `commit_changes instruction present for tools: ${tools.join(",")}`);
      assert.match(text, /taskId/, `taskId named for tools: ${tools.join(",")}`);
      assert.doesNotMatch(text, /git add --/, `no raw staging instruction for tools: ${tools.join(",")}`);
      assert.doesNotMatch(text, /`git commit/, `no raw commit instruction for tools: ${tools.join(",")}`);
    }
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
      return { stdout: `${head}\n`, stderr: "", code: 0, killed: false };
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

// ═══ T1: git gate reads ExecResult.code ═══
describe("T1: git gate reads ExecResult.code", () => {
  function oneBehaviorTask(): TaskContract {
    return {
      title: "Code Task",
      instruction: "do things",
      files: [{ path: "src/a.ts", status: "M" }],
      done: "all green",
      behaviors: [
        { id: "T1", description: "first behavior", expectedOutput: "e1", kind: "test", status: "active" },
        { id: "T2", description: "second behavior", expectedOutput: "e2", kind: "test", status: "active" },
      ],
    };
  }

  it("readGitHead returns the trimmed HEAD hash when git rev-parse exits 0", async () => {
    const pi = mockPi();
    pi.exec = (async () => ({
      stdout: "abc123\n",
      stderr: "",
      code: 0,
      killed: false,
    })) as ExtensionAPI["exec"];

    const head = await readGitHead(pi, "/tmp/test");

    assert.equal(head, "abc123", "code-0 exec yields the trimmed stdout as HEAD");
  });

  it("readGitHead returns null when the exec reports a non-zero code", async () => {
    const pi = mockPi();
    pi.exec = (async () => ({
      stdout: "",
      stderr: "fatal: not a git repository",
      code: 128,
      killed: false,
    })) as ExtensionAPI["exec"];

    const head = await readGitHead(pi, "/tmp/test");

    assert.equal(head, null);
  });

  it("readGitHead returns null when the exec throws", async () => {
    const pi = mockPi();
    pi.exec = (async () => {
      throw new Error("spawn ENOENT");
    }) as ExtensionAPI["exec"];

    const head = await readGitHead(pi, "/tmp/test");

    assert.equal(head, null);
  });

  it("loop-level: code-shaped exec mock whose git commit advances HEAD completes with zero retries and no lastHalt", async () => {
    // Regression: with the exitCode-shape bug, readGitHead always returned
    // null, HEAD movement was never detected, and a successful commit was
    // misclassified as no-changes → RETRY_BUDGET retries → halt.
    const pi = mockPi();
    const execLog: Array<{ cmd: string; args: string[] }> = [];
    let headCounter = 0;
    pi.exec = (async (cmd: string, args: string[]) => {
      execLog.push({ cmd, args });
      if (cmd === "git" && args[0] === "rev-parse") {
        return { stdout: `head${headCounter}\n`, stderr: "", code: 0, killed: false };
      }
      if (cmd === "git" && args[0] === "commit") {
        headCounter++;
        return { stdout: "[main abc] committed", stderr: "", code: 0, killed: false };
      }
      return { stdout: "", stderr: "", code: 0, killed: false };
    }) as ExtensionAPI["exec"];

    const state: WorkflowState = { phase: "finalizing", specText: "topic", task: oneBehaviorTask() };
    const ctx = ctxWithState(state);
    const spawns: string[] = [];

    const result = await runOrchestratedImplement(pi, ctx, state, state.task!, async (unit) => {
      spawns.push(unit.behaviorId);
      return {
        summary: `implemented ${unit.behaviorId}`,
        suggestedCommit: `feat(core): add ${unit.behaviorId === "T1" ? "first behavior" : "second behavior"}`,
      };
    });

    assert.equal(result.complete, true, "successful commits must complete, not halt");
    assert.deepEqual(spawns, ["T1", "T2"], "zero retries: exactly one spawn per active behavior");
    assert.equal(result.unitsRun, 2);
    assert.equal(result.landedCommits.length, 2, "both commits are recorded as landed");
    assert.equal(state.lastHalt, undefined, "no phantom no-changes halt");
    assert.equal(state.phase, "idle");
    assert.ok(
      state.task!.behaviors.every((b) => b.status === "done"),
      "every behavior is marked done when its commit lands",
    );
    const commits = execLog
      .filter((e) => e.cmd === "git" && e.args[0] === "commit")
      .map((e) => e.args[2]);
    assert.deepEqual(
      commits,
      ["feat(core): add first behavior", "feat(core): add second behavior"],
      "one commit per behavior, with the suggested subject",
    );
  });
});

// ═══ T1: HEAD-gate success path ═══
describe("T1: HEAD-gate success path", () => {
  function orchTask(): TaskContract {
    return {
      title: "Orch Task",
      instruction: "do things",
      files: [{ path: "src/a.ts", status: "M" }],
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
        return { stdout: `head${headCounter}\n`, stderr: "", code: 0, killed: false };
      }
      if (cmd === "git" && args[0] === "status") {
        return { stdout: "", stderr: "", code: 0, killed: false };
      }
      if (cmd === "git" && args[0] === "add") {
        return { stdout: "", stderr: "", code: 0, killed: false };
      }
      if (cmd === "git" && args[0] === "commit") {
        headCounter++;
        return { stdout: "[main abc] committed", stderr: "", code: 0, killed: false };
      }
      return { stdout: "", stderr: "", code: 0, killed: false };
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

    await runOrchestratedViaSeam(pi, ctx, recordingRunner(calls, maxActiveRef));

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
        ["rev-parse", "status", "add", "diff", "commit"].includes(c),
        `only git plumbing is allowed, got: ${c}`,
      );
    }
  });

  it("emits per-unit progress before each run and a landed notification per commit (T3)", async () => {
    const { pi } = piWithGit();
    const state: WorkflowState = { phase: "finalizing", specText: "topic", task: orchTask() };
    const ctx = ctxWithState(state);
    const timeline: string[] = [];
    ctx.ui.notify = ((msg: string) => {
      timeline.push(`notify:${msg}`);
    }) as unknown as ExtensionContext["ui"]["notify"];

    const runner = async (unit: { behaviorId: string }): Promise<ImplementerReport> => {
      timeline.push(`unit:${unit.behaviorId}`);
      return {
        summary: `implemented ${unit.behaviorId}`,
        suggestedCommit: `feat(core): add ${unit.behaviorId === "T1" ? "first behavior" : "second behavior"}`,
      };
    };

    await runOrchestratedViaSeam(pi, ctx, runner);

    const unitIdx = (id: string) => timeline.indexOf(`unit:${id}`);
    const notifyIdx = (needle: string) =>
      timeline.findIndex((e) => e.startsWith("notify:") && e.includes(needle));

    assert.ok(unitIdx("T1") >= 0 && unitIdx("T2") >= 0, "both units ran");
    assert.ok(notifyIdx("T1") >= 0, "T1 progress notification emitted");
    assert.ok(notifyIdx("T2") >= 0, "T2 progress notification emitted");
    assert.ok(notifyIdx("T1") < unitIdx("T1"), "T1 progress precedes its unit run");
    assert.ok(notifyIdx("T2") < unitIdx("T2"), "T2 progress precedes its unit run");
    const landed = timeline.filter((e) => e.startsWith("notify:") && /landed/i.test(e));
    assert.equal(landed.length, 2, "one landed-commit notification per behavior");
    assert.ok(
      landed.some((e) => e.includes("T1")) && landed.some((e) => e.includes("T2")),
      "landed notifications name the behavior",
    );
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

  /** Exec mock where the pre-commit hook always rejects (output varies per attempt, T4): HEAD never moves, tree dirty. */
  function piWithRejectingHook() {
    const pi = mockPi();
    let commitAttempts = 0;
    const execLog: Array<{ cmd: string; args: string[] }> = [];
    pi.exec = (async (cmd: string, args: string[]) => {
      execLog.push({ cmd, args });
      if (cmd === "git" && args[0] === "rev-parse") {
        return { stdout: "headA\n", stderr: "", code: 0, killed: false };
      }
      if (cmd === "git" && args[0] === "status") {
        return { stdout: " M src/a.ts\n", stderr: "", code: 0, killed: false };
      }
      if (cmd === "git" && args[0] === "diff") {
        return { stdout: " src/a.ts | 2 +-\n", stderr: "", code: 0, killed: false };
      }
      if (cmd === "git" && args[0] === "commit") {
        commitAttempts++;
        return { stdout: "", stderr: `${HOOK_STDERR} (attempt ${commitAttempts})`, code: 1, killed: false };
      }
      return { stdout: "", stderr: "", code: 0, killed: false };
    }) as ExtensionAPI["exec"];
    return { pi, execLog };
  }

  function oneBehaviorTask(): TaskContract {
    return {
      title: "Hook Task",
      instruction: "do things",
      files: [{ path: "src/a.ts", status: "M" }],
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
    await runOrchestratedViaSeam(pi, ctx, async (unit) => {
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

    await runOrchestratedViaSeam(pi, ctx, async (unit) => {
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
        return { stdout: "headA\n", stderr: "", code: 0, killed: false };
      }
      if (cmd === "git" && args[0] === "status") {
        return { stdout: "", stderr: "", code: 0, killed: false };
      }
      if (cmd === "git" && args[0] === "diff") {
        return { stdout: "", stderr: "", code: 0, killed: false };
      }
      if (cmd === "git" && args[0] === "commit") {
        return { stdout: "", stderr: "nothing to commit, working tree clean", code: 1, killed: false };
      }
      return { stdout: "", stderr: "", code: 0, killed: false };
    }) as ExtensionAPI["exec"];

    const state: WorkflowState = { phase: "finalizing", specText: "topic", task: oneBehaviorTask() };
    const ctx = ctxWithState(state);
    const spawns: Array<{ taskText: string }> = [];

    await runOrchestratedViaSeam(pi, ctx, async (unit) => {
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
        return { stdout: "headA\n", stderr: "", code: 0, killed: false };
      }
      if (cmd === "git" && args[0] === "commit") {
        // Simulate pi.exec hitting the timeout budget.
        throw new Error("Command timed out after 300000ms: git commit");
      }
      return { stdout: "", stderr: "", code: 0, killed: false };
    }) as ExtensionAPI["exec"];

    const state: WorkflowState = { phase: "finalizing", specText: "topic", task: oneBehaviorTask() };
    const ctx = ctxWithState(state);
    const notifyCalls: string[] = [];
    ctx.ui.notify = (msg: string) => {
      notifyCalls.push(msg);
    };
    const spawns: Array<{ taskText: string }> = [];

    await runOrchestratedViaSeam(pi, ctx, async (unit) => {
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
        files: [{ path: "src/a.ts", status: "M" }],
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
        return { stdout: `head${headCounter}\n`, stderr: "", code: 0, killed: false };
      }
      if (cmd === "git" && args[0] === "status") {
        return { stdout: statusOutput, stderr: "", code: 0, killed: false };
      }
      if (cmd === "git" && args[0] === "commit") {
        headCounter++;
        return { stdout: "[main abc] committed", stderr: "", code: 0, killed: false };
      }
      return { stdout: "", stderr: "", code: 0, killed: false };
    }) as ExtensionAPI["exec"];
    return pi;
  }

  it("appends the dirty-tree output to the first resumed unit's task text", async () => {
    const pi = piWith(" M src/a.ts\n?? src/new.ts\n");
    const state = resumingState();
    const ctx = ctxWithState(state);
    const spawns: Array<{ taskText: string }> = [];

    await runOrchestratedViaSeam(pi, ctx, async (unit) => {
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

    await runOrchestratedViaSeam(pi, ctx, async (unit) => {
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
