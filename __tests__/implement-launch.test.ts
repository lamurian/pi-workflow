import { describe, it } from "vitest";
import assert from "node:assert/strict";
import { runImplement } from "../extensions/implement.ts";
import {
  composeCompletionReport,
  composeHaltReport,
} from "../extensions/implement-report.ts";
import type { OrchestratorResult } from "../extensions/implement-loop.ts";
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
  runOrchestratedViaSeam,
} from "./helpers/implement-harness.ts";

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

// ═══ legacy contract refusal (T1) ═══
describe("runImplement refuses legacy string-file contracts (T1)", () => {
  function legacyState(): WorkflowState {
    return {
      phase: "finalizing",
      specText: "topic",
      task: {
        title: "My Task",
        instruction: "do the thing",
        // Persisted before the D/M/A allowlist: plain-string entries.
        files: ["src/a.ts"] as unknown as TaskContract["files"],
        done: "tests pass",
        behaviors: [
          { id: "T1", description: "x", expectedOutput: "y", kind: "test", status: "active" },
        ],
      },
    };
  }

  it("refuses a persisted string-entry contract with a re-finalize message and stays finalizing", async () => {
    const pi = mockPi();
    const state = legacyState();
    const ctx = ctxWithState(state);
    const notifyCalls: string[] = [];
    ctx.ui.notify = (msg: string) => {
      notifyCalls.push(msg);
    };

    await runImplement("", pi, ctx);

    assert.equal(state.phase, "finalizing", "phase must not advance on a legacy contract");
    assert.equal((pi.calls["sendUserMessage"] ?? []).length, 0, "no steer must be sent");
    assert.equal(notifyCalls.length, 1);
    assert.match(notifyCalls[0]!, /\/discuss/);
    assert.match(notifyCalls[0]!, /\/finalize/);
    assert.match(notifyCalls[0]!, /\{ path, status \}/);
  });

  it("also refuses in --solo mode", async () => {
    const pi = mockPi();
    const state = legacyState();
    const ctx = ctxWithState(state);

    await runImplement("--solo", pi, ctx);

    assert.equal(state.phase, "finalizing");
    assert.equal((pi.calls["sendUserMessage"] ?? []).length, 0);
  });
});

// ═══ B1: fire-and-forget orchestration launch ═══
describe("B1: fire-and-forget orchestration launch", () => {
  function twoBehaviorTask(): TaskContract {
    return {
      title: "Fire Task",
      instruction: "do things",
      files: [{ path: "src/a.ts", status: "M" }],
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
        files: [{ path: "src/a.ts", status: "M" }],
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
      files: [{ path: "src/a.ts", status: "M" }],
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

  /** Exec mock where the pre-commit hook always rejects: HEAD never moves, tree dirty. Output varies per attempt (T4) so rejections never repeat identically. */
  function piWithRejectingHook() {
    const pi = mockPi();
    let commitAttempts = 0;
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
        commitAttempts++;
        return { stdout: "", stderr: `${HOOK_STDERR} (attempt ${commitAttempts})`, code: 1, killed: false };
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
        files: [{ path: "src/a.ts", status: "M" }],
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

// ═══ B5: halt report as an agent turn ═══
describe("B5: halt report as an agent turn", () => {
  function haltTask(): TaskContract {
    return {
      title: "Halt Task",
      instruction: "do the thing",
      files: [{ path: "src/a.ts", status: "M" }],
      done: "all green",
      behaviors: [
        { id: "T1", description: "first", expectedOutput: "e1", kind: "test", status: "active" },
      ],
    };
  }

  /** Exec mock exposing a git tree-state snapshot for the halt report. */
  function piWithTreeState(treeState: string) {
    const pi = mockPi();
    pi.exec = (async (cmd: string, args: string[]) => {
      if (cmd === "git" && args[0] === "rev-parse") {
        return { stdout: "headA\n", stderr: "", code: 0, killed: false };
      }
      if (cmd === "git" && args[0] === "status") {
        return { stdout: treeState, stderr: "", code: 0, killed: false };
      }
      return { stdout: "", stderr: "", code: 0, killed: false };
    }) as ExtensionAPI["exec"];
    return pi;
  }

  it("composeHaltReport pins the halted heading, error, tree state, landed commits, resume line, and closing instruction", () => {
    const result: OrchestratorResult = {
      complete: false,
      unitsRun: 7,
      landedCommits: ["feat(core): add T1"],
      haltedOn: "T2",
      error: "pre-commit hook rejected the commit for T2 after 5 retries\n\nlint failed",
      treeState: " M src/b.ts",
    };

    const report = composeHaltReport(result);

    assert.match(report, /## Implementation status: halted on T2/, "halted heading names the behavior");
    assert.match(
      report,
      /Error: pre-commit hook rejected the commit for T2 after 5 retries/,
      "error detail",
    );
    assert.match(report, /Tree state:\n M src\/b\.ts/, "tree-state snapshot");
    assert.match(
      report,
      /Commits landed since \/implement started:\n- feat\(core\): add T1/,
      "one - <subject> line per landed commit",
    );
    assert.match(
      report,
      /Resume: run \/implement again to resume from the first active behavior\./,
      "resume line",
    );
    assert.match(
      report,
      /Relay this status and the recommended next action to the user\. Do not run tools or modify the working tree\./,
      "closing relay instruction",
    );
  });

  it("composeHaltReport reports (unavailable) tree state and (none) landed commits when absent", () => {
    const report = composeHaltReport({
      complete: false,
      unitsRun: 1,
      landedCommits: [],
      haltedOn: "T1",
      error: "boom",
    });

    assert.match(report, /## Implementation status: halted on T1/);
    assert.match(report, /Error: boom/);
    assert.match(report, /Tree state:\n\(unavailable\)/, "(unavailable) when the snapshot is absent");
    assert.match(report, /Commits landed since \/implement started:\n\(none\)/, "(none) when nothing landed");
  });

  it("an always-failing unit exhausts the budget; exactly one steer halt report is delivered; lastHalt persisted; phase stays implementing", async () => {
    const pi = piWithTreeState(" M src/a.ts\n?? new-file.txt");
    const state: WorkflowState = { phase: "finalizing", specText: "topic", task: haltTask() };
    const ctx = ctxWithState(state);
    const notifies: string[] = [];
    ctx.ui.notify = ((msg: string) => {
      notifies.push(msg);
    }) as unknown as ExtensionContext["ui"]["notify"];

    const deliveries: Array<{ text: string; deliverAs?: string }> = [];
    pi.sendUserMessage = ((text: string, opts: { deliverAs: string }) => {
      deliveries.push({ text, deliverAs: opts?.deliverAs });
    }) as ExtensionAPI["sendUserMessage"];

    const spawns: string[] = [];
    const result = await runOrchestratedViaSeam(pi, ctx, async (unit) => {
      spawns.push(unit.behaviorId);
      return { summary: "", error: "always-fails: unit subprocess died" };
    });

    assert.equal(result.complete, false, "the always-failing run halts");
    assert.equal(result.haltedOn, "T1", "the halt names the failed behavior");
    assert.equal(spawns.length, 6, "initial run + exactly 5 retries exhaust the budget");

    const haltNotifies = notifies.filter((m) => /Orchestration halted on T1/.test(m));
    assert.equal(haltNotifies.length, 1, "the existing halt notification still fires");

    assert.equal(deliveries.length, 1, "exactly one sendUserMessage delivery on halt");
    const delivery = deliveries[0]!;
    assert.equal(delivery.deliverAs, "steer", "delivered as an agent-turn steer");
    assert.match(delivery.text, /## Implementation status: halted on T1/, "names the halted behavior");
    assert.match(
      delivery.text,
      /Error: Unit T1 failed after 5 retries: always-fails: unit subprocess died/,
      "includes the error detail",
    );
    assert.match(
      delivery.text,
      /Tree state:\nM src\/a\.ts\n\?\? new-file\.txt/,
      "includes the tree-state snapshot",
    );
    assert.match(delivery.text, /Commits landed since \/implement started:\n\(none\)/, "lists (none) when nothing landed");
    assert.match(
      delivery.text,
      /Resume: run \/implement again to resume from the first active behavior\./,
      "contains the resume line",
    );
    assert.match(
      delivery.text,
      /Relay this status and the recommended next action to the user\. Do not run tools or modify the working tree\./,
      "closing relay instruction",
    );

    assert.equal(state.phase, "implementing", "phase remains implementing so a later /implement resumes");
    const append = pi.calls["appendEntry"] ?? [];
    const lastSaved = append[append.length - 1] as [string, WorkflowState];
    assert.equal(lastSaved[0], "workflow-state");
    assert.equal(lastSaved[1].lastHalt?.behaviorId, "T1", "lastHalt names the halted behavior");
    assert.equal(
      lastSaved[1].lastHalt?.error,
      "Unit T1 failed after 5 retries: always-fails: unit subprocess died",
      "lastHalt is persisted with the same detail as the report",
    );
  });
});
