import { describe, it } from "vitest";
import assert from "node:assert/strict";
import {
  runImplement,
  registerMarkTaskDoneTool,
  registerCompleteImplementationTool,
  composeCompletionReport,
} from "../extensions/implement.ts";
import {
  readGitHead,
  runOrchestratedImplement,
  type OrchestratorResult,
  type UnitRunner,
} from "../extensions/implement-loop.ts";
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
    exec: async () => ({ stdout: "", stderr: "", code: 0, killed: false }),
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

/**
 * Run the orchestrated /implement path (B1 fire-and-forget): launch through
 * runImplement, capture the background promise via the onBackground seam,
 * and await settlement before returning so assertions see loop outcomes.
 *
 * @param pi     - ExtensionAPI reference (mock with recorded calls).
 * @param ctx    - Extension context carrying the workflow state.
 * @param runner - Unit runner injected into the orchestrator loop.
 * @param args   - Optional /implement args (defaults to "").
 * @returns The settled orchestrator result.
 */
async function runOrchestratedViaSeam(
  pi: ExtensionAPI,
  ctx: ExtensionContext,
  runner: UnitRunner,
  args = "",
): Promise<OrchestratorResult> {
  let settled: Promise<OrchestratorResult> | undefined;
  await runImplement(args, pi, ctx, runner, (background) => {
    settled = background;
  });
  assert.ok(settled, "onBackground seam must receive the background promise");
  return settled;
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

// ═══ B1: fire-and-forget orchestration launch ═══
describe("B1: fire-and-forget orchestration launch", () => {
  function twoBehaviorTask(): TaskContract {
    return {
      title: "Fire Task",
      instruction: "do things",
      files: ["src/a.ts"],
      done: "all green",
      behaviors: [
        { id: "T1", description: "first behavior", expectedOutput: "e1", kind: "test", status: "active" },
        { id: "T2", description: "second behavior", expectedOutput: "e2", kind: "test", status: "active" },
      ],
    };
  }

  /** Exec mock where git commit advances HEAD so the loop can land commits. */
  function piWithAdvancingHead() {
    const pi = mockPi();
    let headCounter = 0;
    pi.exec = (async (cmd: string, args: string[]) => {
      if (cmd === "git" && args[0] === "rev-parse") {
        return { stdout: `head${headCounter}\n`, stderr: "", code: 0, killed: false };
      }
      if (cmd === "git" && args[0] === "commit") {
        headCounter++;
        return { stdout: "[main abc] committed", stderr: "", code: 0, killed: false };
      }
      return { stdout: "", stderr: "", code: 0, killed: false };
    }) as ExtensionAPI["exec"];
    return pi;
  }

  it("resolves while the first unit is pending, emits the start notification, continues in the background", async () => {
    const pi = piWithAdvancingHead();
    const state: WorkflowState = { phase: "finalizing", specText: "topic", task: twoBehaviorTask() };
    const ctx = ctxWithState(state);
    const timeline: string[] = [];
    ctx.ui.notify = ((msg: string) => {
      timeline.push(`notify:${msg}`);
    }) as unknown as ExtensionContext["ui"]["notify"];

    // First unit is deferred: it cannot finish until the test releases it.
    let releaseFirstUnit!: () => void;
    const firstUnitGate = new Promise<void>((resolve) => {
      releaseFirstUnit = resolve;
    });
    const runner = async (unit: { behaviorId: string }): Promise<ImplementerReport> => {
      timeline.push(`unit:${unit.behaviorId}`);
      if (unit.behaviorId === "T1") await firstUnitGate;
      return {
        summary: `implemented ${unit.behaviorId}`,
        suggestedCommit: `feat(core): add ${unit.behaviorId}`,
      };
    };

    let settled!: Promise<OrchestratorResult>;
    await runImplement("", pi, ctx, runner, (background) => {
      settled = background;
    });

    // runImplement resolved while T1 is still pending on the gate.
    assert.ok(settled, "onBackground seam received the background promise");
    assert.ok(!timeline.includes("unit:T2"), "runImplement returned before the deferred unit completed");
    const saves = pi.calls["appendEntry"] ?? [];
    const lastSave = saves[saves.length - 1] as [string, WorkflowState];
    assert.equal(lastSave[0], "workflow-state", "state persisted before return");
    assert.equal(lastSave[1].phase, "implementing", "implementing phase persisted before return");
    assert.equal(state.phase, "implementing");

    const starts = timeline.filter(
      (e) => e.startsWith("notify:") && /Orchestration started in background/.test(e),
    );
    assert.equal(starts.length, 1, "exactly one start notification");
    assert.match(starts[0]!, /2 unit\(s\) active/, "start notification carries the active unit count");

    const savesBefore = (pi.calls["appendEntry"] ?? []).length;
    releaseFirstUnit();
    const result = await settled;

    assert.equal(result.complete, true, "the background run completes after the deferred unit");
    const landed = timeline.filter((e) => e.startsWith("notify:") && /landed/i.test(e));
    assert.equal(landed.length, 2, "landed-commit notifications still fire after settlement");
    assert.ok(landed.some((e) => e.includes("T1")) && landed.some((e) => e.includes("T2")));
    const savesAfter = (pi.calls["appendEntry"] ?? []).length;
    assert.ok(savesAfter > savesBefore, "per-unit state persistence continues in the background");
    assert.equal(state.phase, "idle", "the loop returns the workflow to idle on its own");
    assert.ok(state.task!.behaviors.every((b) => b.status === "done"));
  });
});

// ═══ B2: in-flight guard ═══
describe("B2: in-flight guard", () => {
  const REFUSAL_WARNING =
    "An orchestrated implementation is already in flight. Wait for it to settle (watch status/notifications), then re-run /implement to resume.";

  function twoBehaviorState(): WorkflowState {
    return {
      phase: "finalizing",
      specText: "topic",
      task: {
        title: "Guard Task",
        instruction: "do the thing",
        files: ["src/a.ts"],
        done: "all green",
        behaviors: [
          { id: "T1", description: "first", expectedOutput: "e1", kind: "test", status: "active" },
          { id: "T2", description: "second", expectedOutput: "e2", kind: "test", status: "active" },
        ],
      },
    };
  }

  /** Exec mock where git commit advances HEAD so the loop can land commits. */
  function piWithAdvancingHead() {
    const pi = mockPi();
    let headCounter = 0;
    pi.exec = (async (cmd: string, args: string[]) => {
      if (cmd === "git" && args[0] === "rev-parse") {
        return { stdout: `head${headCounter}\n`, stderr: "", code: 0, killed: false };
      }
      if (cmd === "git" && args[0] === "commit") {
        headCounter++;
        return { stdout: "[main abc] committed", stderr: "", code: 0, killed: false };
      }
      return { stdout: "", stderr: "", code: 0, killed: false };
    }) as ExtensionAPI["exec"];
    return pi;
  }

  it("refuses a second /implement while one is in flight; a fresh run launches after settlement", async () => {
    const pi = piWithAdvancingHead();
    const state = twoBehaviorState();
    const ctx = ctxWithState(state);
    const timeline: string[] = [];
    ctx.ui.notify = ((msg: string) => {
      timeline.push(msg);
    }) as unknown as ExtensionContext["ui"]["notify"];

    // Hold the first run in flight: its first unit blocks on the gate, then
    // keeps failing so the run halts (phase stays implementing for resume).
    let releaseFirstUnit!: () => void;
    const gate = new Promise<void>((resolve) => {
      releaseFirstUnit = resolve;
    });
    const firstSpawns: string[] = [];
    const firstRunner = async (
      unit: { behaviorId: string },
    ): Promise<ImplementerReport & { error?: string }> => {
      firstSpawns.push(unit.behaviorId);
      if (unit.behaviorId === "T1" && firstSpawns.filter((id) => id === "T1").length === 1) {
        await gate;
      }
      return { summary: "", error: `boom: ${unit.behaviorId} failed` };
    };

    let settled!: Promise<OrchestratorResult>;
    await runImplement("", pi, ctx, firstRunner, (background) => {
      settled = background;
    });
    assert.ok(settled, "onBackground seam received the background promise");
    assert.equal(state.phase, "implementing");

    // Let the background loop reach the deferred unit so it is genuinely
    // parked in flight before the second call arrives.
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.ok(firstSpawns.includes("T1"), "first run is held in flight on T1");

    // Second call while the first run is in flight.
    const stateSnapshot = JSON.parse(JSON.stringify(state));
    const savesBefore = (pi.calls["appendEntry"] ?? []).length;
    const spawnsBefore = firstSpawns.length;
    timeline.length = 0;

    const secondSpawns: string[] = [];
    let secondSettled: Promise<OrchestratorResult> | undefined;
    await runImplement(
      "",
      pi,
      ctx,
      async (unit) => {
        secondSpawns.push(unit.behaviorId);
        return { summary: "x", suggestedCommit: "feat: x" };
      },
      (background) => {
        secondSettled = background;
      },
    );

    assert.deepEqual(timeline, [REFUSAL_WARNING], "second call emits exactly the refusal warning");
    assert.equal(secondSettled, undefined, "no background task launched for the refused call");
    assert.equal(secondSpawns.length, 0, "no units spawned by the refused call");
    assert.equal(firstSpawns.length, spawnsBefore, "the in-flight loop is untouched");
    assert.equal(
      (pi.calls["appendEntry"] ?? []).length,
      savesBefore,
      "no state persisted by the refused call",
    );
    assert.deepEqual(JSON.parse(JSON.stringify(state)), stateSnapshot, "workflow state unchanged");

    // Release the first run: it exhausts the retry budget and halts.
    releaseFirstUnit();
    const result = await settled;
    assert.equal(result.complete, false, "first run halts after the runner keeps failing");
    assert.ok(result.haltedOn, "first run records a halt");
    assert.equal(state.phase, "implementing", "halt keeps the phase implementing for resume");

    // Third call after settlement launches a new loop that runs units normally.
    timeline.length = 0;
    const thirdSpawns: string[] = [];
    let thirdSettled!: Promise<OrchestratorResult>;
    await runImplement(
      "",
      pi,
      ctx,
      async (unit) => {
        thirdSpawns.push(unit.behaviorId);
        return {
          summary: `implemented ${unit.behaviorId}`,
          suggestedCommit: `feat(core): add ${unit.behaviorId}`,
        };
      },
      (background) => {
        thirdSettled = background;
      },
    );

    assert.ok(thirdSettled, "post-settlement call launches a background task");
    assert.ok(
      timeline.some((m) => /Orchestration started in background/.test(m)),
      "post-settlement call emits the start notification",
    );
    const thirdResult = await thirdSettled;
    assert.equal(thirdResult.complete, true, "the new run completes");
    assert.ok(thirdSpawns.includes("T1"), "the new run spawns units normally");
    assert.equal(state.phase, "idle", "the new run completes the workflow");
  });
});

// ═══ B3: live footer status (key "implement") ═══
describe('B3: live footer status (key "implement")', () => {
  function statusTask(behaviorIds: string[]): TaskContract {
    return {
      title: "Status Task",
      instruction: "do things",
      files: ["src/a.ts"],
      done: "all green",
      behaviors: behaviorIds.map((id, i) => ({
        id,
        description: `behavior ${i + 1}`,
        expectedOutput: `e${i + 1}`,
        kind: "test" as const,
        status: "active" as const,
      })),
    };
  }

  /** Exec mock where git commit advances HEAD so the loop can land commits. */
  function piWithAdvancingHead() {
    const pi = mockPi();
    let headCounter = 0;
    pi.exec = (async (cmd: string, args: string[]) => {
      if (cmd === "git" && args[0] === "rev-parse") {
        return { stdout: `head${headCounter}\n`, stderr: "", code: 0, killed: false };
      }
      if (cmd === "git" && args[0] === "commit") {
        headCounter++;
        return { stdout: "[main abc] committed", stderr: "", code: 0, killed: false };
      }
      return { stdout: "", stderr: "", code: 0, killed: false };
    }) as ExtensionAPI["exec"];
    return pi;
  }

  const HOOK_STDERR = "golangci-lint run failed\ninternal error\nexit status 1";

  /** Exec mock where the pre-commit hook always rejects: HEAD never moves, tree dirty. */
  function piWithRejectingHook() {
    const pi = mockPi();
    pi.exec = (async (cmd: string, args: string[]) => {
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
        return { stdout: "", stderr: HOOK_STDERR, code: 1, killed: false };
      }
      return { stdout: "", stderr: "", code: 0, killed: false };
    }) as ExtensionAPI["exec"];
    return pi;
  }

  /**
   * Capture ctx.ui.setStatus and ctx.ui.notify into parallel timelines.
   *
   * setStatus is captured per key; note that updateUi (state.ts) legitimately
   * writes the shared "workflow" key through the same method, so callers
   * assert on the "implement" key sequence and on frame-vs-key separation.
   *
   * @param ctx - Extension context whose ui methods are wrapped in place.
   * @returns The captured setStatus pairs and notify messages.
   */
  function captureUi(ctx: ExtensionContext): {
    statuses: Array<[string, string | undefined]>;
    notifies: string[];
  } {
    const statuses: Array<[string, string | undefined]> = [];
    const notifies: string[] = [];
    ctx.ui.setStatus = ((key: string, value: string | undefined) => {
      statuses.push([key, value]);
    }) as unknown as ExtensionContext["ui"]["setStatus"];
    ctx.ui.notify = ((msg: string) => {
      notifies.push(msg);
    }) as unknown as ExtensionContext["ui"]["notify"];
    return { statuses, notifies };
  }

  /** The "implement"-key values, in capture order. */
  function implementFrames(statuses: Array<[string, string | undefined]>): Array<string | undefined> {
    return statuses.filter(([key]) => key === "implement").map(([, value]) => value);
  }

  it("clean units emit implementing -> committing -> landed per position; final call clears 'implement'", async () => {
    const pi = piWithAdvancingHead();
    const state: WorkflowState = {
      phase: "finalizing",
      specText: "topic",
      task: statusTask(["T1", "T2"]),
    };
    const ctx = ctxWithState(state);
    const { statuses, notifies } = captureUi(ctx);

    const result = await runOrchestratedViaSeam(pi, ctx, async (unit) => ({
      summary: `implemented ${unit.behaviorId}`,
      suggestedCommit: `feat(core): add ${unit.behaviorId}`,
    }));

    assert.equal(result.complete, true, "the clean run completes");
    assert.deepEqual(
      implementFrames(statuses),
      [
        "✦ T1 (1/2): implementing…",
        "✦ T1 (1/2): committing…",
        "✦ T1 (1/2): landed",
        "✦ T2 (2/2): implementing…",
        "✦ T2 (2/2): committing…",
        "✦ T2 (2/2): landed",
        undefined,
      ],
      "implement frames: implementing -> committing -> landed per unit position, final call clears the key",
    );
    const last = statuses[statuses.length - 1]!;
    assert.deepEqual(
      last,
      ["implement", undefined],
      "the final setStatus call after loop end clears key 'implement'",
    );
    // updateUi (state.ts) writes the shared "workflow" key with phase
    // indicators (undefined or "◉ …"); the loop's own ✦ frames must never
    // land on that key.
    const workflowValues = statuses
      .filter(([key]) => key === "workflow")
      .map(([, value]) => value);
    assert.ok(
      workflowValues.every((v) => v === undefined || v.startsWith("◉")),
      `no captured call writes an 'implement' loop frame under the 'workflow' key, got: ${JSON.stringify(statuses)}`,
    );
    const landed = notifies.filter((m) => /landed/i.test(m));
    assert.equal(landed.length, 2, "landed-commit notifications still appear in the notify timeline");
  });

  it("a hook-rejected retry emits retry frames carrying the attempt number, then clears on halt", async () => {
    const pi = piWithRejectingHook();
    const state: WorkflowState = {
      phase: "finalizing",
      specText: "topic",
      task: statusTask(["T1"]),
    };
    const ctx = ctxWithState(state);
    const { statuses } = captureUi(ctx);

    const result = await runOrchestratedViaSeam(pi, ctx, async (unit) => ({
      summary: `attempt for ${unit.behaviorId}`,
      suggestedCommit: "feat(core): add first behavior",
    }));

    assert.equal(result.complete, false, "persistent hook rejection halts the loop");
    assert.equal(result.haltedOn, "T1");
    const frames = implementFrames(statuses);
    assert.ok(frames.includes("✦ T1 (1/1): implementing…"), "unit-start frame emitted");
    assert.ok(frames.includes("✦ T1 (1/1): committing…"), "committing frame emitted before commit attempts");
    const retryFrames = frames.filter((f): f is string => f !== undefined && f.includes("retry"));
    assert.deepEqual(
      retryFrames,
      [
        "✦ T1 (1/1): retry 1/5…",
        "✦ T1 (1/1): retry 2/5…",
        "✦ T1 (1/1): retry 3/5…",
        "✦ T1 (1/1): retry 4/5…",
        "✦ T1 (1/1): retry 5/5…",
      ],
      "each retry iteration emits its frame carrying the attempt number",
    );
    assert.deepEqual(
      frames[frames.length - 1],
      undefined,
      "the final implement-frame after halt clears key 'implement'",
    );
    const workflowFrames = statuses.filter(
      ([key, value]) => key === "workflow" && value !== undefined && value.includes("✦"),
    );
    assert.deepEqual(workflowFrames, [], "the loop never writes a frame under the 'workflow' key");
  });
});

// ═══ B4: completion report as an agent turn ═══
describe("B4: completion report as an agent turn", () => {
  function completeState(): WorkflowState {
    return {
      phase: "finalizing",
      specText: "topic",
      task: {
        title: "Report Task",
        instruction: "do the thing",
        files: ["src/a.ts"],
        done: "all green",
        behaviors: [
          { id: "T1", description: "first", expectedOutput: "e1", kind: "test", status: "active" },
          { id: "T2", description: "second", expectedOutput: "e2", kind: "test", status: "active" },
        ],
      },
    };
  }

  /** Exec mock where git commit advances HEAD so the loop can land commits. */
  function piWithAdvancingHead() {
    const pi = mockPi();
    let headCounter = 0;
    pi.exec = (async (cmd: string, args: string[]) => {
      if (cmd === "git" && args[0] === "rev-parse") {
        return { stdout: `head${headCounter}\n`, stderr: "", code: 0, killed: false };
      }
      if (cmd === "git" && args[0] === "commit") {
        headCounter++;
        return { stdout: "[main abc] committed", stderr: "", code: 0, killed: false };
      }
      return { stdout: "", stderr: "", code: 0, killed: false };
    }) as ExtensionAPI["exec"];
    return pi;
  }

  it("composeCompletionReport pins the complete heading, counts, commit lines, done ids, and closing instruction", () => {
    const task = completeState().task!;
    for (const behavior of task.behaviors) behavior.status = "done";
    const result: OrchestratorResult = {
      complete: true,
      unitsRun: 2,
      landedCommits: ["feat(core): add T1", "feat(core): add T2"],
    };

    const report = composeCompletionReport(result, task);

    assert.match(report, /## Implementation status: complete/, "complete heading");
    assert.match(report, /Units run: 2/, "units-run count");
    assert.match(
      report,
      /Commits landed:\n- feat\(core\): add T1\n- feat\(core\): add T2/,
      "one - <subject> line per landed commit",
    );
    assert.match(report, /Behaviors:\n- T1 done\n- T2 done/, "done behavior id entries");
    assert.match(
      report,
      /No action needed: relay this status to the user\. Do not run tools or modify the working tree\./,
      "closing no-action instruction",
    );
  });

  it("a complete run delivers exactly one steer report after idle persistence; the completion notify still fires", async () => {
    const pi = piWithAdvancingHead();
    const state = completeState();
    const ctx = ctxWithState(state);
    const notifies: string[] = [];
    ctx.ui.notify = ((msg: string) => {
      notifies.push(msg);
    }) as unknown as ExtensionContext["ui"]["notify"];

    // Record each delivery's options and the persisted workflow phase at
    // delivery time (last workflow-state entry in the appendEntry calls).
    const deliveries: Array<{
      text: string;
      deliverAs?: string;
      persistedPhase: string | undefined;
    }> = [];
    pi.sendUserMessage = ((text: string, opts: { deliverAs: string }) => {
      const entries = (pi.calls["appendEntry"] ?? []) as Array<
        [string, { phase?: string }]
      >;
      let persistedPhase: string | undefined;
      for (let i = entries.length - 1; i >= 0; i--) {
        const entry = entries[i];
        if (entry[0] === "workflow-state" && entry[1]?.phase) {
          persistedPhase = entry[1].phase;
          break;
        }
      }
      deliveries.push({ text, deliverAs: opts?.deliverAs, persistedPhase });
    }) as ExtensionAPI["sendUserMessage"];

    const result = await runOrchestratedViaSeam(pi, ctx, async (unit) => ({
      summary: `implemented ${unit.behaviorId}`,
      suggestedCommit: `feat(core): add ${unit.behaviorId}`,
    }));

    assert.equal(result.complete, true, "the clean run completes");
    assert.equal(deliveries.length, 1, "exactly one sendUserMessage delivery on completion");
    const delivery = deliveries[0]!;
    assert.equal(delivery.deliverAs, "steer", "delivered as an agent-turn steer");
    assert.match(delivery.text, /## Implementation status: complete/, "complete heading");
    assert.match(delivery.text, /Units run: 2/, "units-run count");
    assert.ok(
      delivery.text.includes("- feat(core): add T1"),
      "report lists the first landed commit subject",
    );
    assert.ok(
      delivery.text.includes("- feat(core): add T2"),
      "report lists the second landed commit subject",
    );
    assert.ok(
      delivery.text.includes("- T1 done") && delivery.text.includes("- T2 done"),
      "report lists the done behavior ids",
    );
    assert.match(
      delivery.text,
      /No action needed: relay this status to the user\. Do not run tools or modify the working tree\./,
      "closing no-action instruction",
    );
    assert.equal(
      delivery.persistedPhase,
      "idle",
      "state.phase is idle and persisted before the report is delivered",
    );
    assert.equal(state.phase, "idle");
    const completeNotifies = notifies.filter((m) =>
      /Orchestrated implementation complete/.test(m),
    );
    assert.equal(completeNotifies.length, 1, "the completion notify still fires");
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
      files: ["src/a.ts"],
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

  /** Exec mock where the pre-commit hook always rejects: HEAD never moves, tree dirty. */
  function piWithRejectingHook() {
    const pi = mockPi();
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
        return { stdout: "", stderr: HOOK_STDERR, code: 1, killed: false };
      }
      return { stdout: "", stderr: "", code: 0, killed: false };
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

// ═══ T5: staged-diff guard halts the loop before commit ═══
describe("T5: staged-diff guard halts the loop before commit", () => {
  function guardTask(): TaskContract {
    return {
      title: "Guard Task",
      instruction: "do things",
      files: ["src/a.ts"],
      done: "all green",
      behaviors: [
        {
          id: "T1",
          description: "first behavior",
          expectedOutput: "e1",
          kind: "test",
          status: "active",
          sourceFile: "tests/a.test.ts",
        },
      ],
    };
  }

  interface ExecLogEntry { cmd: string; args: string[] }

  /** Exec mock: add succeeds; staged diff shows an undeclared test deletion. */
  function piWithTamperDiff(): {
    pi: ExtensionAPI & { calls: Record<string, unknown[]> };
    execLog: ExecLogEntry[];
  } {
    const pi = mockPi();
    const execLog: ExecLogEntry[] = [];
    pi.exec = (async (cmd: string, args: string[]) => {
      execLog.push({ cmd, args });
      if (cmd === "git" && args[0] === "rev-parse") {
        return { stdout: "headA\n", stderr: "", code: 0, killed: false };
      }
      if (cmd === "git" && args[0] === "status") {
        return { stdout: "", stderr: "", code: 0, killed: false };
      }
      if (cmd === "git" && args[0] === "add") {
        return { stdout: "", stderr: "", code: 0, killed: false };
      }
      if (cmd === "git" && args[0] === "diff" && args.includes("--name-status")) {
        return { stdout: "D\tpkg/old_test.go\n", stderr: "", code: 0, killed: false };
      }
      if (cmd === "git" && args[0] === "diff") {
        return {
          stdout:
            "diff --git a/pkg/old_test.go b/pkg/old_test.go\n" +
            "--- a/pkg/old_test.go\n+++ b/pkg/old_test.go\n" +
            "@@ -1,2 +0,0 @@\n" +
            "-func TestOld(t *testing.T) { assert.True(t, true) }\n",
          stderr: "",
          code: 0,
          killed: false,
        };
      }
      if (cmd === "git" && args[0] === "commit") {
        throw new Error("git commit must never run when the guard trips");
      }
      return { stdout: "", stderr: "", code: 0, killed: false };
    }) as ExtensionAPI["exec"];
    return { pi, execLog };
  }

  it("halts immediately on test-guard: no commit, no fix subagent, lastHalt carries lines + guidance", async () => {
    const { pi, execLog } = piWithTamperDiff();
    const state: WorkflowState = { phase: "finalizing", specText: "topic", task: guardTask() };
    const ctx = ctxWithState(state);
    const spawns: string[] = [];

    const result = await runOrchestratedImplement(
      pi,
      ctx,
      state,
      state.task!,
      async (unit) => {
        spawns.push(unit.behaviorId);
        return { summary: `implemented ${unit.behaviorId}`, suggestedCommit: "feat(core): add first behavior" };
      },
    );

    assert.equal(spawns.length, 1, "only the base unit runs — no fix subagent on test-guard");
    assert.ok(
      !execLog.some((e) => e.cmd === "git" && e.args[0] === "commit"),
      "git commit must never be invoked when the guard trips",
    );
    assert.equal(result.complete, false);
    assert.equal(result.haltedOn, "T1");
    assert.match(result.error ?? "", /test-guard|Staged-diff guard/i);
    assert.ok(state.lastHalt, "halt persists lastHalt");
    assert.equal(state.lastHalt!.behaviorId, "T1");
    assert.match(state.lastHalt!.error, /D\tpkg\/old_test\.go/, "lastHalt carries the name-status lines");
    assert.match(state.lastHalt!.error, /re-declare/, "lastHalt carries re-declare guidance");
    assert.match(state.lastHalt!.error, /\/finalize/, "lastHalt names the /discuss -> /finalize path");
  });

  it("clean staged diff: staged diff inspected between add and commit, commit lands once", async () => {
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
      if (cmd === "git" && args[0] === "diff") {
        return { stdout: "", stderr: "", code: 0, killed: false };
      }
      if (cmd === "git" && args[0] === "commit") {
        headCounter++;
        return { stdout: "[main abc] committed", stderr: "", code: 0, killed: false };
      }
      return { stdout: "", stderr: "", code: 0, killed: false };
    }) as ExtensionAPI["exec"];

    const state: WorkflowState = { phase: "finalizing", specText: "topic", task: guardTask() };
    const ctx = ctxWithState(state);
    const spawns: string[] = [];

    const result = await runOrchestratedImplement(
      pi,
      ctx,
      state,
      state.task!,
      async (unit) => {
        spawns.push(unit.behaviorId);
        return { summary: `implemented ${unit.behaviorId}`, suggestedCommit: "feat(core): add first behavior" };
      },
    );

    assert.equal(result.complete, true, "clean staged diff lands the commit");
    assert.equal(state.task!.behaviors[0].status, "done");
    const gitCommands = execLog.filter((e) => e.cmd === "git").map((e) => e.args[0]);
    const addIdx = gitCommands.indexOf("add");
    const diffIdx = gitCommands.indexOf("diff");
    const commitIdx = gitCommands.indexOf("commit");
    assert.ok(addIdx !== -1 && diffIdx !== -1 && commitIdx !== -1, "add, diff, commit all run");
    assert.ok(addIdx < diffIdx && diffIdx < commitIdx, "staged diff inspected between add and commit");
  });
});
