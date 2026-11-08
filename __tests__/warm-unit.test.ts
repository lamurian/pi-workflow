import { describe, it, vi } from "vitest";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, sep } from "node:path";
import {
  WARM_STEER_CAP,
  UNDELIVERED_HALT_THRESHOLD,
  UNDELIVERED_STEER_ERROR,
  buildUndeliveredHaltText,
  canSteerWarmChild,
  shutdownWarmChild,
  steerFixRound,
} from "../extensions/warm-unit.ts";
import {
  runOrchestratedImplement,
  type OrchestratorResult,
  type UnitRunner,
} from "../extensions/implement-loop.ts";
import type { UnitTask } from "../extensions/implementer-runner.ts";
import { WRAP_UP_STEER_MESSAGE } from "../extensions/implementer-runner.ts";
import { getActiveUnitClient, setActiveUnitClient } from "../extensions/unit-client-registry.ts";
import type { RpcUnitClient } from "../extensions/rpc-unit-client.ts";
import { parseImplementerReport } from "../extensions/implementer-report.ts";
import { buildUnitTask } from "../extensions/unit-task-text.ts";
import { writeContractGuardFile } from "../extensions/contract-guard-file.ts";
import { deriveAllowlist } from "../extensions/contract-derive.ts";
import {
  beginOrchestration,
  cancelOrchestration,
  endOrchestration,
} from "../extensions/orchestration-cancel.ts";
import type { ContractV2, TaskContract, WorkflowState } from "../extensions/state.ts";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

const HOOK_STDERR = "husky - pre-commit hook failed\nlint errors";

// ─── Minimal mocks (same shapes as implement.test.ts / hitl.test.ts) ──────────

function mockPi(): ExtensionAPI & { calls: Record<string, unknown[]> } {
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
    getActiveTools: () => ["read", "write", "edit"],
    getAllTools: () => ["read", "write", "edit"].map((name) => ({ name })),
    setActiveTools: record("setActiveTools") as ExtensionAPI["setActiveTools"],
    exec: async () => ({ stdout: "", stderr: "", code: 0, killed: false }),
    calls,
  } as unknown as ExtensionAPI & { calls: typeof calls };
}

function ctxWithState(state: WorkflowState, cwd = "/tmp/test"): ExtensionContext {
  return {
    cwd,
    sessionManager: {
      getBranch: () => [{ type: "custom", customType: "workflow-state", data: state }],
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

function warmTask(): WorkflowState {
  return {
    phase: "finalizing",
    specText: "topic",
    task: {
      title: "Warm Task",
      instruction: "do the thing",
      files: [{ path: "src/a.ts", status: "M" }],
      done: "tests pass",
      behaviors: [
        { id: "T1", description: "x", expectedOutput: "y", kind: "test", status: "active" },
      ],
    } satisfies TaskContract,
  };
}

interface GitGateOptions {
  /** Commit attempt number (1-based) from which HEAD advances (lands). */
  landOnCommit?: number;
  /** Exit code for non-landing commit attempts (1 = hook rejected, 0 = no-op). */
  failCode?: number;
  /** Whether `git status --short` reports a dirty tree. */
  dirty?: () => boolean;
}

/** Exec mock driving the commit gate: rev-parse/status/diff/commit sequences. */
function piWithGate(opts: GitGateOptions = {}) {
  const pi = mockPi();
  const execLog: string[][] = [];
  let head = 0;
  let commitAttempts = 0;
  (pi as unknown as Record<string, unknown>).execLog = execLog;
  pi.exec = (async (cmd: string, args: string[]) => {
    if (cmd === "git") execLog.push(args);
    if (cmd === "git" && args[0] === "rev-parse") {
      return { stdout: `head${head}\n`, stderr: "", code: 0, killed: false };
    }
    if (cmd === "git" && args[0] === "status") {
      const dirty = opts.dirty ? opts.dirty() : true;
      return { stdout: dirty ? " M src/a.ts\n" : "", stderr: "", code: 0, killed: false };
    }
    if (cmd === "git" && args[0] === "diff") {
      return { stdout: " src/a.ts | 2 +-\n", stderr: "", code: 0, killed: false };
    }
    if (cmd === "git" && args[0] === "commit") {
      commitAttempts++;
      if (opts.landOnCommit !== undefined && commitAttempts >= opts.landOnCommit) {
        head++;
        return { stdout: `[main c${commitAttempts}] landed`, stderr: "", code: 0, killed: false };
      }
      return { stdout: "", stderr: `${HOOK_STDERR} (attempt ${commitAttempts})`, code: opts.failCode ?? 1, killed: false };
    }
    return { stdout: "", stderr: "", code: 0, killed: false };
  }) as ExtensionAPI["exec"];
  return pi;
}

type GatePi = ExtensionAPI & { execLog: string[][] };

// ─── Fake kept-alive client ───────────────────────────────────────────────────

/** One assistant JSONL line as the rpc child would print it. */
function assistantLine(text: string): string {
  return JSON.stringify({
    type: "message_end",
    message: { role: "assistant", content: [{ type: "text", text }] },
  });
}

/** A fenced JSON report block with the given summary. */
function reportJson(summary: string, extra: Record<string, unknown> = {}): string {
  return "```json\n" + JSON.stringify({ summary, ...extra }) + "\n```";
}

interface FakeClientHandle {
  client: RpcUnitClient;
  record: {
    steers: string[];
    prompts: Array<{ message: string; streamingBehavior?: string }>;
    commands: Array<Record<string, unknown>>;
    shutdowns: number;
  };
  /** Append stdout content (JSONL) and notify event listeners. */
  emit: (text: string) => void;
  /** Kill the child: isAlive() turns false and exit listeners fire. */
  die: () => void;
}

/**
 * Fake kept-alive RpcUnitClient. `onPrompt` (if given) runs inside prompt() so
 * a warm fix round can emit its NEW report synchronously, like a real child would.
 * `onCommand` (if given) shapes command() responses — return `{ isStreaming: false }`
 * to make the T2 get_state probe mark warm rounds undelivered.
 */
function makeWarmClient(
  onPrompt?: (message: string, emit: (text: string) => void) => void,
  onCommand?: (command: Record<string, unknown>) => { isStreaming?: boolean },
): FakeClientHandle {
  let stdout = "";
  let alive = true;
  const record = {
    steers: [] as string[],
    prompts: [] as Array<{ message: string; streamingBehavior?: string }>,
    commands: [] as Array<Record<string, unknown>>,
    shutdowns: 0,
  };
  const listeners = new Set<(event: Record<string, unknown>) => void>();
  const exitListeners = new Set<(info: { code: number }) => void>();
  const emit = (text: string) => {
    stdout += text + "\n";
    for (const l of listeners) l({ type: "message_end" });
  };
  const client = {
    isAlive: () => alive,
    shutdown: async () => {
      record.shutdowns++;
      alive = false;
    },
    kill: () => {
      if (!alive) return;
      alive = false;
      for (const l of exitListeners) l({ code: 1 });
    },
    send: () => {},
    command: async (commandObj: Record<string, unknown>) => {
      record.commands.push(commandObj);
      const data = onCommand?.(commandObj);
      return { type: "response", success: true, id: "x", ...(data ? { data } : {}) };
    },
    prompt: (message: string, streamingBehavior?: string) => {
      record.prompts.push(streamingBehavior ? { message, streamingBehavior } : { message });
      onPrompt?.(message, emit);
    },
    steer: (message: string) => {
      record.steers.push(message);
    },
    onEvent: (l: (event: Record<string, unknown>) => void) => {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    onExit: (l: (info: { code: number }) => void) => {
      exitListeners.add(l);
      return () => exitListeners.delete(l);
    },
    rawStdout: () => stdout,
    stderrText: () => "",
  } as unknown as RpcUnitClient;
  return {
    client,
    record,
    emit,
    die: () => {
      if (!alive) return;
      alive = false;
      for (const l of exitListeners) l({ code: 1 });
    },
  };
}

// ═══ canSteerWarmChild / shutdownWarmChild ═══
describe("warm child gate and shutdown", () => {
  it("requires a live child below the 5-steer cap", () => {
    assert.equal(WARM_STEER_CAP, 5);
    const warm = makeWarmClient();
    assert.equal(canSteerWarmChild(undefined, 0), false, "no client -> fresh spawn");
    assert.equal(canSteerWarmChild(warm.client, 0), true, "live child below the cap");
    assert.equal(canSteerWarmChild(warm.client, WARM_STEER_CAP - 1), true, "last steer allowed");
    assert.equal(canSteerWarmChild(warm.client, WARM_STEER_CAP), false, "cap reached -> fresh spawn");
    warm.die();
    assert.equal(canSteerWarmChild(warm.client, 0), false, "dead child -> fresh spawn");
  });

  it("shutdownWarmChild shuts an alive child down, clears the registry, and is idempotent", async () => {
    const warm = makeWarmClient();
    setActiveUnitClient(warm.client);
    await shutdownWarmChild(warm.client);
    assert.equal(warm.record.shutdowns, 1, "the alive child is shut down");
    assert.equal(getActiveUnitClient(), undefined, "the registry entry is cleared");
    await shutdownWarmChild(warm.client);
    assert.equal(warm.record.shutdowns, 1, "a dead child is not shut down again");
    await shutdownWarmChild(undefined);
    assert.equal(warm.record.shutdowns, 1, "undefined is a no-op");
  });
});

// ═══ steerFixRound ═══
describe("steerFixRound", () => {
  it("delivers the fix via prompt with streamingBehavior steer and settles on the NEW report, not the earlier one", async () => {
    const warm = makeWarmClient((_message, emit) => {
      emit(assistantLine(reportJson("fixed after hook rejection", { suggestedCommit: "feat(core): fix" })));
    });
    // The child already printed the base report before the fix round.
    warm.emit(assistantLine(reportJson("stale base report", { suggestedCommit: "feat(core): stale" })));

    const result = await steerFixRound(warm.client, "## Previous attempt failed (retry 1/5)", undefined, 0);

    assert.equal(result.summary, "fixed after hook rejection", "only post-delivery content settles the round");
    assert.equal(result.suggestedCommit, "feat(core): fix");
    assert.deepEqual(
      warm.record.prompts,
      [{ message: "## Previous attempt failed (retry 1/5)", streamingBehavior: "steer" }],
      "the fix task text rides a prompt with steer semantics",
    );
    assert.deepEqual(warm.record.steers, [], "no steer command carries the fix");
  });

  it("arms the wrap-up and kill timers per round and clears them on settle", async () => {
    vi.useFakeTimers();
    try {
      const warm = makeWarmClient();
      const round1 = steerFixRound(warm.client, "fix-1", undefined, 1_000);
      await vi.advanceTimersByTimeAsync(800);
      assert.deepEqual(
        warm.record.prompts,
        [{ message: "fix-1", streamingBehavior: "steer" }],
        "the fix text is prompted once at round start",
      );
      assert.deepEqual(
        warm.record.steers,
        [WRAP_UP_STEER_MESSAGE],
        "the soft deadline wrap-up steer still arrives via steer",
      );
      warm.emit(assistantLine(reportJson("round 1")));
      const res1 = await round1;
      assert.equal(res1.summary, "round 1");

      const round2 = steerFixRound(warm.client, "fix-2", undefined, 1_000);
      assert.deepEqual(
        warm.record.prompts,
        [
          { message: "fix-1", streamingBehavior: "steer" },
          { message: "fix-2", streamingBehavior: "steer" },
        ],
        "the round prompt itself",
      );
      await vi.advanceTimersByTimeAsync(800);
      assert.equal(warm.record.steers.length, 2, "the per-round wrap-up timer is rearmed for round 2");
      warm.emit(assistantLine(reportJson("round 2")));
      await round2;
      await vi.advanceTimersByTimeAsync(2_000);
      assert.equal(warm.record.steers.length, 2, "timers are cleared once the round settles");
    } finally {
      vi.useRealTimers();
    }
  });

  it("times out with diagnostics when the child never reports again", async () => {
    vi.useFakeTimers();
    try {
      const warm = makeWarmClient();
      const round = steerFixRound(warm.client, "fix", undefined, 1_000);
      await vi.advanceTimersByTimeAsync(1_000);
      const res = await round;
      assert.equal(res.timedOut, true, "the hard kill marks the round timed out");
      assert.match(res.error ?? "", /warm retry timed out/);
    } finally {
      vi.useRealTimers();
    }
  });

  it("marks the round undelivered when the child reports isStreaming false with no new stdout (T2)", async () => {
    vi.useFakeTimers();
    try {
      const warm = makeWarmClient(undefined, () => ({ isStreaming: false }));
      const round = steerFixRound(warm.client, "fix", undefined, 60_000);
      await vi.advanceTimersByTimeAsync(300); // the 250ms probe fires, far before the 60s hard timeout
      const res = await round;
      assert.equal(res.undeliveredSteer, true, "an idle child that never picked the prompt up settles as undelivered");
      assert.equal(res.error, UNDELIVERED_STEER_ERROR, "the delivery-failure error text rides the result");
      assert.notEqual(res.timedOut, true, "the round returns promptly instead of waiting out the hard timeout");
      assert.equal(warm.client.isAlive(), true, "an undelivered round does not kill the child");
      assert.deepEqual(warm.record.prompts, [{ message: "fix", streamingBehavior: "steer" }], "the fix text still rode a steer prompt");
      assert.ok(
        warm.record.commands.some((c) => c.type === "get_state"),
        "the child state is probed via get_state shortly after delivery",
      );
    } finally {
      vi.useRealTimers();
    }
  });

  it("keeps awaiting the new report for a streaming child or new stdout before the probe (T2)", async () => {
    vi.useFakeTimers();
    try {
      const streaming = makeWarmClient(undefined, () => ({ isStreaming: true }));
      let settled = false;
      const round1 = steerFixRound(streaming.client, "fix-a", undefined, 60_000).then((res) => {
        settled = true;
        return res;
      });
      await vi.advanceTimersByTimeAsync(300);
      assert.equal(settled, false, "a streaming child leaves the round awaiting the new report");
      streaming.emit(assistantLine(reportJson("late but real report")));
      const res1 = await round1;
      assert.equal(res1.undeliveredSteer, undefined, "a delivered report carries no undelivered marker");
      assert.equal(res1.summary, "late but real report");

      const chatty = makeWarmClient(undefined, () => ({ isStreaming: false }));
      const round2 = steerFixRound(chatty.client, "fix-b", undefined, 60_000);
      chatty.emit(assistantLine(reportJson("chatty child report")));
      await vi.advanceTimersByTimeAsync(300);
      const res2 = await round2;
      assert.equal(res2.undeliveredSteer, undefined, "new stdout before the probe keeps the round awaiting the report");
      assert.equal(res2.summary, "chatty child report");
    } finally {
      vi.useRealTimers();
    }
  });
});

// ═══ T2: undelivered fix rounds ═══
describe("undelivered fix rounds (T2)", () => {
  /** Fresh loop run with the cancelled flag reset (cancelOrchestration is sticky). */
  async function runLoop(pi: ExtensionAPI, ctx: ExtensionContext, state: WorkflowState, runner: UnitRunner) {
    beginOrchestration(Promise.resolve());
    try {
      return await runOrchestratedImplement(pi, ctx, state, state.task!, runner);
    } finally {
      endOrchestration();
    }
  }

  it("an undelivered round falls back to a fresh spawn without charging the retry or the warm steer (T2)", async () => {
    const pi = piWithGate({ landOnCommit: 3 }); // hook rejects commits 1-2, lands 3
    const state = warmTask();
    const ctx = ctxWithState(state);
    const calls: UnitTask[] = [];
    // The first fix round goes warm into an idle child: the get_state probe reports
    // isStreaming false and no stdout ever follows the prompt — the round is undelivered.
    // (A SECOND consecutive undelivered round would halt the run — see the next test.)
    const idle = makeWarmClient(undefined, () => ({ isStreaming: false }));
    const deliver = makeWarmClient((_message, emit) => {
      emit(assistantLine(reportJson("fixed after undelivered rounds", { suggestedCommit: "feat(core): fix T1" })));
    });
    const clients = [idle, deliver];
    const runner: UnitRunner = async (unit) => {
      calls.push(unit);
      const handle = clients[calls.length - 1]!;
      setActiveUnitClient(handle.client);
      return { summary: `attempt ${calls.length}`, suggestedCommit: "feat(core): base", client: handle.client };
    };

    const result = await runLoop(pi, ctx, state, runner);

    assert.equal(result.complete, true, "the run lands once a warm round is delivered");
    assert.deepEqual(result.landedCommits, ["feat(core): fix T1"], "the commit uses the delivered report");
    assert.equal(calls.length, 2, "base plus one fresh fallback — the undelivered round spawned no unit of its own");
    assert.equal(calls[1]!.behaviorId, "T1", "the fresh fallback targets the same behavior");
    assert.match(
      calls[1]!.taskText,
      /## Previous attempt failed \(retry 1\/5\)/,
      "the fallback fresh spawn carries the same fix text with the retry counter untouched",
    );
    assert.equal(idle.record.prompts.length, 1, "the undelivered round still rode a warm prompt (steer refunded)");
    assert.equal(idle.record.shutdowns, 1, "the idle child is shut down by its fallback");
    assert.equal(deliver.record.prompts.length, 1, "the next fix round still went warm into the live child");
    assert.equal(deliver.record.prompts[0]!.streamingBehavior, "steer", "steer semantics ride the prompt");
    assert.match(
      deliver.record.prompts[0]!.message,
      /## Previous attempt failed \(retry 1\/5\)/,
      "the retry counter was never incremented by the undelivered round",
    );
    assert.equal(result.unitsRun, 2, "the undelivered round contributes its fallback fresh spawn, not itself");
    assert.equal(deliver.record.shutdowns, 1, "the delivered child is shut down on landing");
  });

  it("two consecutive undelivered rounds halt with the infrastructure delivery error (T2)", async () => {
    const pi = piWithGate({}); // the hook always rejects
    const state = warmTask();
    const ctx = ctxWithState(state);
    const calls: UnitTask[] = [];
    const idleA = makeWarmClient(undefined, () => ({ isStreaming: false }));
    const idleB = makeWarmClient(undefined, () => ({ isStreaming: false }));
    const clients = [idleA, idleB];
    const runner: UnitRunner = async (unit) => {
      calls.push(unit);
      const handle = clients[calls.length - 1]!;
      setActiveUnitClient(handle.client);
      return { summary: `attempt ${calls.length}`, suggestedCommit: "feat(core): base", client: handle.client };
    };

    const result = await runLoop(pi, ctx, state, runner);

    assert.equal(result.complete, false, "the run halts on the second consecutive undelivered round");
    assert.equal(result.haltedOn, "T1");
    assert.match(result.error ?? "", /infrastructure/, "the halt names the infrastructure delivery failure");
    assert.doesNotMatch(result.error ?? "", /failed after \d+ retries/, "never a retry-budget message");
    assert.ok(
      (result.error ?? "").includes(buildUndeliveredHaltText("T1", UNDELIVERED_HALT_THRESHOLD)),
      "the halt text is buildUndeliveredHaltText at the threshold",
    );
    assert.equal(calls.length, 2, "one fresh fallback after the first undelivered round, none after the halt");
    assert.equal(idleA.record.prompts.length, 1, "warm fix round 1 into child A");
    assert.equal(idleB.record.prompts.length, 1, "warm fix round 2 into child B");
    assert.equal(idleB.record.shutdowns, 1, "the halt shuts the live child down");

    // The undelivered rounds land in the attempt history with progress false and the delivery error.
    const undelivered = (result.attempts ?? []).filter((a) => a.lastText === UNDELIVERED_STEER_ERROR);
    assert.equal(undelivered.length, UNDELIVERED_HALT_THRESHOLD, "one attempt record per undelivered round");
    assert.ok(undelivered.every((a) => a.progress === false), "undelivered rounds record no progress");
  });
});

// ═══ Loop integration: warm retries ═══
describe("orchestrator warm retries", () => {
  /** Fresh loop run with the cancelled flag reset (cancelOrchestration is sticky). */
  async function runLoop(pi: ExtensionAPI, ctx: ExtensionContext, state: WorkflowState, runner: UnitRunner) {
    beginOrchestration(Promise.resolve());
    try {
      return await runOrchestratedImplement(pi, ctx, state, state.task!, runner);
    } finally {
      endOrchestration();
    }
  }

  it("a hook-rejected commit delivers the fix via prompt into the same live child and lands from the new report", async () => {
    const pi = piWithGate({ landOnCommit: 2 });
    const state = warmTask();
    const ctx = ctxWithState(state);
    const calls: UnitTask[] = [];
    const warm = makeWarmClient((_message, emit) => {
      emit(assistantLine(reportJson("fixed after hook rejection", { suggestedCommit: "feat(core): fix T1" })));
    });
    warm.emit(assistantLine(reportJson("stale base report", { suggestedCommit: "feat(core): stale" })));
    const runner: UnitRunner = async (unit) => {
      calls.push(unit);
      setActiveUnitClient(warm.client); // mirrors runImplementerUnit's registry behavior
      return {
        summary: `implemented ${unit.behaviorId}`,
        suggestedCommit: "feat(core): base",
        client: warm.client,
      };
    };

    const result = await runLoop(pi, ctx, state, runner);

    assert.equal(result.complete, true, "the steered retry lands");
    assert.deepEqual(result.landedCommits, ["feat(core): fix T1"], "the commit uses the post-steer report");
    assert.equal(calls.length, 1, "no fresh fix unit is spawned while the child is alive");
    assert.equal(result.unitsRun, 1, "a warm round is not a new unit");
    assert.equal(warm.record.prompts.length, 1, "one warm fix prompt");
    assert.equal(warm.record.prompts[0]!.streamingBehavior, "steer", "steer semantics ride the prompt");
    assert.match(warm.record.prompts[0]!.message, /## Previous attempt failed \(retry 1\/5\)/, "the fix task text");
    assert.match(warm.record.prompts[0]!.message, /husky - pre-commit hook failed/, "the hook output rides the prompt");
    assert.deepEqual(warm.record.steers, [], "no steer command: the report settles before the soft deadline");
    assert.equal(warm.record.shutdowns, 1, "the child is shut down on landing");
  });

  it("a no-changes commit outcome also delivers the fix via prompt into the same live child", async () => {
    const pi = piWithGate({ landOnCommit: 2, failCode: 0, dirty: () => false });
    const state = warmTask();
    const ctx = ctxWithState(state);
    const calls: UnitTask[] = [];
    const warm = makeWarmClient((_message, emit) => {
      emit(assistantLine(reportJson("implemented for real", { suggestedCommit: "feat(core): fix T1" })));
    });
    const runner: UnitRunner = async (unit) => {
      calls.push(unit);
      setActiveUnitClient(warm.client);
      return { summary: "reported success", suggestedCommit: "feat(core): base", client: warm.client };
    };

    const result = await runLoop(pi, ctx, state, runner);

    assert.equal(result.complete, true, "the steered retry lands");
    assert.equal(calls.length, 1, "no fresh spawn for a no-changes fix");
    assert.equal(warm.record.prompts.length, 1, "one warm fix prompt");
    assert.equal(warm.record.prompts[0]!.streamingBehavior, "steer", "steer semantics ride the prompt");
    assert.match(
      warm.record.prompts[0]!.message,
      /No changes detected/,
      "the no-changes investigation rides the prompt",
    );
    assert.deepEqual(warm.record.steers, [], "no steer command");
    assert.deepEqual(result.landedCommits, ["feat(core): fix T1"]);
  });

  it("a dead child falls back to a fresh fix unit", async () => {
    const pi = piWithGate({ landOnCommit: 3 });
    const state = warmTask();
    const ctx = ctxWithState(state);
    const calls: UnitTask[] = [];
    const first = makeWarmClient((_message, emit) => {
      emit(assistantLine(reportJson("partial fix", { suggestedCommit: "feat(core): try1" })));
      first.die(); // the child dies right after its warm round
    });
    const second = makeWarmClient((_message, emit) => {
      emit(assistantLine(reportJson("fixed fresh", { suggestedCommit: "feat(core): fix T1" })));
    });
    const clients = [first, second];
    const runner: UnitRunner = async (unit) => {
      calls.push(unit);
      const handle = clients[calls.length - 1]!;
      setActiveUnitClient(handle.client);
      return { summary: `attempt ${calls.length}`, suggestedCommit: "feat(core): base", client: handle.client };
    };

    const result = await runLoop(pi, ctx, state, runner);

    assert.equal(result.complete, true, "the fresh fix unit lands the commit");
    assert.equal(calls.length, 2, "one warm fix round, then one fresh fix unit");
    assert.match(calls[1]!.taskText, /## Previous attempt failed \(retry 2\/5\)/, "the fresh unit gets the fix task");
    assert.equal(first.record.prompts.length, 1, "only the first round was delivered, via prompt");
    assert.deepEqual(first.record.steers, [], "no steer command to the warm child");
    assert.equal(first.record.shutdowns, 0, "a dead child is not shut down again");
    assert.equal(second.record.shutdowns, 1, "the fresh child is shut down on landing");
  });

  it("counts every warm steer toward RETRY_BUDGET and halts after the 5-steer cap", async () => {
    const pi = piWithGate({}); // hook always rejects, tree stays dirty
    const state = warmTask();
    const ctx = ctxWithState(state);
    const calls: UnitTask[] = [];
    const warm = makeWarmClient((_message, emit) => {
      emit(assistantLine(reportJson("another attempt", { suggestedCommit: "feat(core): fix" })));
    });
    const runner: UnitRunner = async (unit) => {
      calls.push(unit);
      setActiveUnitClient(warm.client);
      return { summary: "attempt", suggestedCommit: "feat(core): base", client: warm.client };
    };

    const result: OrchestratorResult = await runLoop(pi, ctx, state, runner);

    assert.equal(result.complete, false, "the run halts once the budget is spent");
    assert.equal(result.haltedOn, "T1");
    assert.match(result.error ?? "", /after 5 retries/);
    assert.equal(calls.length, 1, "all five retries were warm rounds, no fresh spawn");
    assert.equal(warm.record.prompts.length, WARM_STEER_CAP, "exactly 5 fix prompts before the halt");
    assert.deepEqual(warm.record.steers, [], "no steer commands: every fix rides a prompt");
    assert.equal(result.attempts?.length, 6, "base attempt plus 5 steered rounds in the attempt table");
    assert.equal(warm.record.shutdowns, 1, "the child is shut down on halt");
  });

  it("injected runners without a client keep the fresh-spawn behavior", async () => {
    const pi = piWithGate({});
    const state = warmTask();
    const ctx = ctxWithState(state);
    const calls: UnitTask[] = [];
    const runner: UnitRunner = async (unit) => {
      calls.push(unit);
      return { summary: `attempt ${calls.length}`, suggestedCommit: "feat(core): base" };
    };

    const result = await runLoop(pi, ctx, state, runner);

    assert.equal(result.complete, false, "persistent rejection halts");
    assert.equal(calls.length, 6, "base plus five fresh fix units");
    assert.match(calls[1]!.taskText, /retry 1\/5/);
    assert.match(calls[5]!.taskText, /retry 5\/5/);
  });

  it("cancelOrchestration shuts the kept-alive child down", async () => {
    const warm = makeWarmClient();
    setActiveUnitClient(warm.client);
    beginOrchestration(Promise.resolve());
    try {
      await cancelOrchestration(ctxWithState(warmTask()));
    } finally {
      endOrchestration();
    }
    assert.equal(warm.record.shutdowns, 1, "the live child is shut down on cancel");
    assert.equal(getActiveUnitClient(), undefined);
  });
});

// ═══ T4: parent-side red-step machinery removed ═══
describe("parent-side red-step machinery removed (T4)", () => {
  /** Fresh loop run with the cancelled flag reset (cancelOrchestration is sticky). */
  async function runLoop(pi: ExtensionAPI, ctx: ExtensionContext, state: WorkflowState, runner: UnitRunner) {
    beginOrchestration(Promise.resolve());
    try {
      return await runOrchestratedImplement(pi, ctx, state, state.task!, runner);
    } finally {
      endOrchestration();
    }
  }

  it("parseImplementerReport no longer surfaces a phase field (T4)", () => {
    const red = parseImplementerReport(assistantLine(reportJson("tests written", { phase: "red" })));
    assert.equal(
      (red as Record<string, unknown>).phase,
      undefined,
      "the parent-side red-step machinery is removed: phase is dropped from the report (T4)",
    );
    const plain = parseImplementerReport(assistantLine(reportJson("done")));
    assert.equal((plain as Record<string, unknown>).phase, undefined, "a report without phase has none");
  });

  it("a red-phase report runs no pre-commit check and spawns no continuation (T4)", async () => {
    const pi = piWithGate({ landOnCommit: 1 });
    const state = warmTask();
    const ctx = ctxWithState(state);
    const calls: UnitTask[] = [];
    const runner: UnitRunner = async (unit) => {
      calls.push(unit);
      return { summary: "tests written", phase: "red", suggestedCommit: "feat(core): done T1" };
    };

    const result = await runLoop(pi, ctx, state, runner);

    assert.equal(result.complete, true, "the attempt reaches the commit gate directly");
    assert.equal(calls.length, 1, "no red-phase continuation is spawned");
    assert.equal(result.unitsRun, 1, "a red-phase report is treated as a normal report");
    const execLog = (pi as GatePi).execLog;
    assert.ok(
      !execLog.some((args) => args[0] === "hook"),
      "runPrecommitCheck must never run on a red-phase report (T4)",
    );
  });

  it("manual-kind behaviors carry no red section (the red instruction is gone, T3)", () => {
    const state = warmTask();
    const manual = { ...state.task!.behaviors[0]!, kind: "manual" as const };
    const text = buildUnitTask(manual, state.task!);
    assert.doesNotMatch(text, /"phase": "red"/, "no red-phase instruction in the task text");
  });
});

// ═══ T5: unit payload + slice-only task text ═══
describe("unit payload and slice task text (T5)", () => {
  const CONTRACT: ContractV2 = {
    title: "Payload Task",
    instruction: "shared context only",
    done: "tests pass",
    sources: [
      { path: "src/a.ts", status: "M", tasks: ["T1"] },
      { path: "src/b.ts", status: "M", tasks: ["T2"] },
    ],
    tests: [
      { path: "__tests__/a.test.ts", status: "A", tasks: ["T1"] },
      { path: "__tests__/b.test.ts", status: "A", tasks: ["T2"] },
    ],
    tasks: [
      { id: "T1", description: "slice A", expectedOutput: ["assertion one", "assertion two"], status: "active" },
      { id: "T2", description: "slice B", expectedOutput: ["other assertion"], status: "active" },
    ],
  };

  const v1Task: TaskContract = {
    title: CONTRACT.title,
    instruction: CONTRACT.instruction,
    files: [
      { path: "src/a.ts", status: "M" },
      { path: "src/b.ts", status: "M" },
      { path: "__tests__/a.test.ts", status: "A" },
      { path: "__tests__/b.test.ts", status: "A" },
    ],
    done: CONTRACT.done,
    behaviors: [
      {
        id: "T1",
        description: "slice A",
        expectedOutput: "assertion one; assertion two",
        kind: "test",
        status: "active",
      },
      { id: "T2", description: "slice B", expectedOutput: "other assertion", kind: "test", status: "active" },
    ],
  };

  /** Load the child guard's tool_call hook against an env map. */
  async function loadGuardHook(
    env: Record<string, string | undefined>,
  ): Promise<
    (event: Record<string, unknown>) => Promise<{ block?: boolean; reason?: string } | undefined>
  > {
    const mod = await import("../extensions/contract-guard/index.ts");
    const handlers = new Map<string, (event: Record<string, unknown>) => Promise<unknown>>();
    const pi = {
      on: (name: string, handler: (event: Record<string, unknown>) => Promise<unknown>) => {
        handlers.set(name, handler);
        return () => {};
      },
      registerTool: () => {},
    };
    mod.createContractGuardExtension(env)(pi as never);
    return handlers.get("tool_call") as never;
  }

  it("payloadCarriesDerivedUnitSlice", async () => {
    const tmp = mkdtempSync(join(tmpdir(), "pi-unit-payload-"));
    const suites = [{ label: "javascript (npm run test)", argv: ["npm", "run", "test"] }];
    const guardPath = await writeContractGuardFile(mockPi(), tmp, deriveAllowlist(CONTRACT), "base123", {
      contract: CONTRACT,
      taskId: "T1",
      testSuites: suites,
    });
    assert.equal(
      guardPath.split(sep).join("/"),
      `${tmp.split(sep).join("/")}/.pi/workflow/contract-guard.json`,
      "the payload lands at .pi/workflow/contract-guard.json",
    );
    assert.ok(
      !guardPath.split(sep).join("/").includes("/.git/"),
      "the payload never lives under .git/",
    );
    const payload = JSON.parse(readFileSync(guardPath, "utf8")) as {
      repoRoot: string;
      baselineHead: string;
      allowlist: unknown;
      files?: unknown;
      unit: {
        id: string;
        sources: Array<{ path: string }>;
        tests: Array<{ path: string }>;
        packages: string[];
        testSuites: unknown;
      };
    };
    assert.equal(payload.repoRoot, tmp);
    assert.equal(payload.baselineHead, "base123");
    assert.deepEqual(payload.allowlist, deriveAllowlist(CONTRACT), "the allowlist is the contract-derive union");
    assert.equal(payload.files, undefined, "no v1 files field in a v2 payload");
    const unit = payload.unit;
    assert.equal(unit.id, "T1");
    assert.deepEqual(
      unit.sources.map((e) => e.path),
      ["src/a.ts"],
      "only T1-owned sources",
    );
    assert.deepEqual(
      unit.tests.map((e) => e.path),
      ["__tests__/a.test.ts"],
      "only T1-owned tests",
    );
    assert.deepEqual(unit.packages, ["__tests__"], "packages = repo-relative dirs of owned test paths");
    assert.deepEqual(unit.testSuites, suites, "the recorded test suites ride the payload");

    // The child guard reads PI_UNIT_FILE and falls back to PI_CONTRACT_GUARD_FILE.
    const viaUnitFile = await loadGuardHook({ PI_UNIT_FILE: guardPath });
    const viaLegacy = await loadGuardHook({ PI_CONTRACT_GUARD_FILE: guardPath });
    const editMine = { toolName: "edit", input: { path: "src/a.ts" } };
    assert.equal(await viaUnitFile(editMine), undefined, "the guard reads PI_UNIT_FILE");
    assert.equal(await viaLegacy(editMine), undefined, "the guard falls back to PI_CONTRACT_GUARD_FILE");
    const editTheirs = await viaUnitFile({ toolName: "edit", input: { path: "src/b.ts" } });
    assert.equal(editTheirs?.block, true, "another task's owned path stays blocked in-turn");
    assert.match(editTheirs?.reason ?? "", /T2/, "the reason names the owning task");
  });

  it("unitTaskTextIsSliceOnly", async () => {
    const behavior = v1Task.behaviors[0]!;
    const text = buildUnitTask(behavior, v1Task, {
      contract: CONTRACT,
      testTool: {
        source: "detected",
        suites: [{ label: "javascript (npm run test)", argv: ["npm", "run", "test"] }],
      },
    });

    assert.match(text, /Implement ONE behavior: T1\./, "task id");
    assert.match(text, /Description: slice A/, "the slice description");
    assert.match(text, /- assertion one\n- assertion two/, "one expectedOutput line per assertion");
    assert.match(text, /Sources: src\/a\.ts \(M\)/, "owned sources only");
    assert.match(text, /Tests: __tests__\/a\.test\.ts \(A\)/, "owned tests only");
    assert.match(text, /## Verification/);
    assert.match(text, /derived scope/, "the Verification line states the test tool defaults to the task scope");
    assert.match(text, /not verification/, "iteration runs are called out as not verification");
    assert.doesNotMatch(text, /src\/b\.ts/, "T2's owned paths are never embedded");
    assert.doesNotMatch(text, /__tests__\/b\.test\.ts/, "T2's test paths are never embedded");
    assert.doesNotMatch(text, /slice B/, "the other task's description is never embedded");
    assert.doesNotMatch(text, /## Contract \(for reference\)/, "the full contract is not embedded");
    assert.doesNotMatch(text, /^Files: /m, "no full-allowlist line");

    // The orchestrator loop threads state.contractV2 into the unit task text.
    const pi = piWithGate({ landOnCommit: 1 });
    const state: WorkflowState = {
      phase: "finalizing",
      specText: "topic",
      task: v1Task,
      contractV2: CONTRACT,
      baselineHead: "base123",
    };
    const ctx = ctxWithState(state);
    const texts: Record<string, string> = {};
    beginOrchestration(Promise.resolve());
    try {
      const result = await runOrchestratedImplement(pi, ctx, state, v1Task, async (unit) => {
        texts[unit.behaviorId] = unit.taskText;
        return { summary: `implemented ${unit.behaviorId}`, suggestedCommit: `feat(core): ${unit.behaviorId}` };
      });
      assert.equal(result.complete, true, result.error ?? "");
    } finally {
      endOrchestration();
    }
    assert.match(texts["T1"]!, /Implement ONE behavior: T1\./, "the loop unit text is the slice");
    assert.match(texts["T1"]!, /- assertion one/, "the loop unit text carries the slice assertions");
    assert.doesNotMatch(texts["T1"]!, /## Contract \(for reference\)/, "no full contract in the loop unit text");
  });
});

// ═══ setTaskStatus routing ═══
describe("warm-unit completion status", () => {
  it("completeAlreadySatisfied marks the task done in state.contractV2", async () => {
    const { completeAlreadySatisfied } = await import("../extensions/warm-unit.ts");
    const state = warmTask();
    state.contractV2 = {
      title: "Warm Task", instruction: "x", done: "y", sources: [], tests: [],
      tasks: [{ id: "T1", description: "x", expectedOutput: ["y"], status: "active" }],
    };
    const result = { complete: false, unitsRun: 1, landedCommits: [], satisfiedWithoutCommit: [] } as OrchestratorResult;
    await completeAlreadySatisfied({ pi: mockPi(), ctx: ctxWithState(state), state, behavior: state.task!.behaviors[0]!, result, position: "1/1" });
    assert.equal(state.contractV2.tasks[0]!.status, "done");
  });
});

// ═══ File-size guard ═══
describe("behavior-loop size", () => {
  it("behavior-loop.ts is at most 300 lines", () => {
    const src = readFileSync(new URL("../extensions/behavior-loop.ts", import.meta.url), "utf8");
    const lines = src.split("\n").length;
    assert.ok(lines <= 300, `behavior-loop.ts is ${lines} lines (limit 300)`);
  });
});
