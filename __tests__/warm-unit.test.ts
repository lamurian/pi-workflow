import { describe, it, vi } from "vitest";
import assert from "node:assert/strict";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  WARM_STEER_CAP,
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
import { resetWorkflowConfigCache } from "../extensions/paths.ts";
import {
  beginOrchestration,
  cancelOrchestration,
  endOrchestration,
} from "../extensions/orchestration-cancel.ts";
import type { TaskContract, WorkflowState } from "../extensions/state.ts";
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
  /** Whether `git rev-parse --git-path hooks/pre-commit` reports a hook path. */
  hookPresent?: boolean;
  /** Exit code for `git hook run --ignore-missing pre-commit`. */
  hookExit?: number;
  /** stdout of the hook run. */
  hookOutput?: string;
}

/** Exec mock driving the commit gate: rev-parse/status/diff/commit/hook sequences. */
function piWithGate(opts: GitGateOptions = {}) {
  const pi = mockPi();
  const execLog: string[][] = [];
  let head = 0;
  let commitAttempts = 0;
  (pi as unknown as Record<string, unknown>).execLog = execLog;
  pi.exec = (async (cmd: string, args: string[]) => {
    if (cmd === "git") execLog.push(args);
    if (cmd === "git" && args[0] === "rev-parse" && args.includes("--git-path")) {
      return {
        stdout: opts.hookPresent ? ".git/hooks/pre-commit\n" : "\n",
        stderr: "",
        code: 0,
        killed: false,
      };
    }
    if (cmd === "git" && args[0] === "hook") {
      return {
        stdout: opts.hookOutput ?? "",
        stderr: "",
        code: opts.hookExit ?? 0,
        killed: false,
      };
    }
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
      return { stdout: "", stderr: HOOK_STDERR, code: opts.failCode ?? 1, killed: false };
    }
    return { stdout: "", stderr: "", code: 0, killed: false };
  }) as ExtensionAPI["exec"];
  return pi;
}

type GatePi = ExtensionAPI & { execLog: string[][] };

/** Real temp dir with an executable .git/hooks/pre-commit, for hook-present checks. */
function makeHookRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), "pi-t6-hook-"));
  mkdirSync(join(dir, ".git", "hooks"), { recursive: true });
  const hook = join(dir, ".git", "hooks", "pre-commit");
  writeFileSync(hook, "#!/bin/sh\nexit 0\n");
  chmodSync(hook, 0o755);
  return dir;
}

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
  record: { steers: string[]; prompts: string[]; shutdowns: number };
  /** Append stdout content (JSONL) and notify event listeners. */
  emit: (text: string) => void;
  /** Kill the child: isAlive() turns false and exit listeners fire. */
  die: () => void;
}

/**
 * Fake kept-alive RpcUnitClient. `onSteer` (if given) runs inside steer() so a
 * warm round can emit its NEW report synchronously, like a real child would.
 */
function makeWarmClient(onSteer?: (message: string, emit: (text: string) => void) => void): FakeClientHandle {
  let stdout = "";
  let alive = true;
  const record = { steers: [] as string[], prompts: [] as string[], shutdowns: 0 };
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
    command: async () => ({ type: "response", success: true, id: "x" }),
    prompt: (message: string) => {
      record.prompts.push(message);
    },
    steer: (message: string) => {
      record.steers.push(message);
      onSteer?.(message, emit);
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
  it("delivers the fix via steer and settles on the NEW report, not the earlier one", async () => {
    const warm = makeWarmClient((_message, emit) => {
      emit(assistantLine(reportJson("fixed after hook rejection", { suggestedCommit: "feat(core): fix" })));
    });
    // The child already printed the base report before the steer.
    warm.emit(assistantLine(reportJson("stale base report", { suggestedCommit: "feat(core): stale" })));

    const result = await steerFixRound(warm.client, "## Previous attempt failed (retry 1/5)", undefined, 0);

    assert.equal(result.summary, "fixed after hook rejection", "only post-steer content settles the round");
    assert.equal(result.suggestedCommit, "feat(core): fix");
    assert.deepEqual(warm.record.steers, ["## Previous attempt failed (retry 1/5)"], "fix text goes through steer");
    assert.deepEqual(warm.record.prompts, [], "no new prompt: the child is not respawned");
  });

  it("arms the wrap-up and kill timers per round and clears them on settle", async () => {
    vi.useFakeTimers();
    try {
      const warm = makeWarmClient();
      const round1 = steerFixRound(warm.client, "fix-1", undefined, 1_000);
      await vi.advanceTimersByTimeAsync(750);
      assert.deepEqual(
        warm.record.steers,
        ["fix-1", WRAP_UP_STEER_MESSAGE],
        "the fix text is steered, then the soft deadline fires mid-round",
      );
      warm.emit(assistantLine(reportJson("round 1")));
      const res1 = await round1;
      assert.equal(res1.summary, "round 1");

      const round2 = steerFixRound(warm.client, "fix-2", undefined, 1_000);
      assert.deepEqual(
        warm.record.steers,
        ["fix-1", WRAP_UP_STEER_MESSAGE, "fix-2"],
        "the round steer itself",
      );
      await vi.advanceTimersByTimeAsync(750);
      assert.equal(warm.record.steers.length, 4, "the per-round timer is rearmed for round 2");
      warm.emit(assistantLine(reportJson("round 2")));
      await round2;
      await vi.advanceTimersByTimeAsync(2_000);
      assert.equal(warm.record.steers.length, 4, "timers are cleared once the round settles");
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

  it("a hook-rejected commit steers the fix into the same live child and lands from the new report", async () => {
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
    assert.equal(result.unitsRun, 1, "a warm steer is not a new unit");
    assert.equal(warm.record.steers.length, 1, "one warm steer");
    assert.match(warm.record.steers[0]!, /## Previous attempt failed \(retry 1\/5\)/, "the fix task text");
    assert.match(warm.record.steers[0]!, /husky - pre-commit hook failed/, "the hook output rides the steer");
    assert.equal(warm.record.shutdowns, 1, "the child is shut down on landing");
  });

  it("a no-changes commit outcome also steers into the same live child", async () => {
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
    assert.equal(warm.record.steers.length, 1, "one warm steer");
    assert.match(warm.record.steers[0]!, /No changes detected/, "the no-changes investigation rides the steer");
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
    assert.equal(calls.length, 2, "one warm steer, then one fresh fix unit");
    assert.match(calls[1]!.taskText, /## Previous attempt failed \(retry 2\/5\)/, "the fresh unit gets the fix task");
    assert.equal(first.record.steers.length, 1, "only the first round was steered");
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
    assert.equal(calls.length, 1, "all five retries were warm steers, no fresh spawn");
    assert.equal(warm.record.steers.length, WARM_STEER_CAP, "exactly 5 steers before the halt");
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

// ═══ T6: red step (enforceTdd) ═══
describe("red step tied to implement.enforceTdd", () => {
  /** Fresh loop run with the cancelled flag reset (cancelOrchestration is sticky). */
  async function runLoop(pi: ExtensionAPI, ctx: ExtensionContext, state: WorkflowState, runner: UnitRunner) {
    beginOrchestration(Promise.resolve());
    try {
      return await runOrchestratedImplement(pi, ctx, state, state.task!, runner);
    } finally {
      endOrchestration();
    }
  }

  it("parseImplementerReport reads an optional phase", () => {
    const red = parseImplementerReport(assistantLine(reportJson("tests written", { phase: "red" })));
    assert.equal(red.phase, "red");
    const plain = parseImplementerReport(assistantLine(reportJson("done")));
    assert.equal(plain.phase, undefined, "a report without phase has none");
  });

  it("without a live client the red result goes into a fresh continuation, not RETRY_BUDGET", async () => {
    const pi = piWithGate({ landOnCommit: 1 }); // hookPresent defaults to false
    const state = warmTask();
    const ctx = ctxWithState(state);
    const calls: UnitTask[] = [];
    const runner: UnitRunner = async (unit) => {
      calls.push(unit);
      if (calls.length === 1) {
        return { summary: "tests written", phase: "red", suggestedCommit: "feat(core): base" };
      }
      return { summary: "implemented", suggestedCommit: "feat(core): done T1" };
    };

    const result = await runLoop(pi, ctx, state, runner);

    assert.equal(result.complete, true, "the continuation lands the commit");
    assert.doesNotMatch(calls[0]!.taskText, /"phase": "red"/, "the unit observes red itself via the test tool — no red-phase instruction");
    const execLog = (pi as GatePi).execLog;
    assert.ok(execLog.some((args) => args[0] === "hook"), "a red report triggers the pre-commit run");
    assert.match(calls[1]!.taskText, /red unobservable/, "hook missing -> red cannot be observed, proceed");
    assert.doesNotMatch(calls[1]!.taskText, /retry \d+\/5/, "the continuation is not charged to RETRY_BUDGET");
    assert.equal(result.unitsRun, 2, "base attempt plus one continuation");
  });

  it("a live child is steered 'red observed, implement now' with the output tail", async () => {
    const dir = makeHookRepo();
    const pi = piWithGate({ landOnCommit: 1, hookPresent: true, hookExit: 1, hookOutput: "lint failed" });
    const state = warmTask();
    const ctx = ctxWithState(state, dir);
    const calls: UnitTask[] = [];
    let steersSeen = 0;
    const warm = makeWarmClient((_message, emit) => {
      steersSeen++;
      if (steersSeen === 1) {
        emit(assistantLine(reportJson("tests written", { phase: "red" })));
      } else {
        emit(assistantLine(reportJson("implemented", { suggestedCommit: "feat(core): fix T1" })));
      }
    });
    const runner: UnitRunner = async (unit) => {
      calls.push(unit);
      setActiveUnitClient(warm.client);
      return { summary: "red ready", phase: "red", client: warm.client };
    };

    const result = await runLoop(pi, ctx, state, runner);

    assert.equal(result.complete, true, "the steered implementation lands");
    assert.equal(calls.length, 1, "the red result rides a steer, not a fresh spawn");
    assert.equal(warm.record.steers.length, 2, "red steer, then the final round");
    assert.match(warm.record.steers[0]!, /red observed, implement now/, "non-zero hook exit -> red observed");
    assert.match(warm.record.steers[0]!, /lint failed/, "the hook output tail rides the steer");
    assert.doesNotMatch(warm.record.steers[0]!, /retry \d+\/5/, "red steers are not budget-charged");
    assert.deepEqual(result.landedCommits, ["feat(core): fix T1"]);
  });

  it("a zero hook exit steers 'red not observed'", async () => {
    const dir = makeHookRepo();
    const pi = piWithGate({ landOnCommit: 1, hookPresent: true, hookExit: 0 });
    const state = warmTask();
    const ctx = ctxWithState(state, dir);
    const calls: UnitTask[] = [];
    let steersSeen = 0;
    const warm = makeWarmClient((_message, emit) => {
      steersSeen++;
      if (steersSeen === 1) {
        emit(assistantLine(reportJson("tests written", { phase: "red" })));
      } else {
        emit(assistantLine(reportJson("implemented", { suggestedCommit: "feat(core): fix T1" })));
      }
    });
    const runner: UnitRunner = async (unit) => {
      calls.push(unit);
      setActiveUnitClient(warm.client);
      return { summary: "red ready", phase: "red", client: warm.client };
    };

    const result = await runLoop(pi, ctx, state, runner);

    assert.equal(result.complete, true);
    assert.match(warm.record.steers[0]!, /red not observed/, "exit 0 -> the test does not fail yet");
    assert.match(warm.record.steers[0]!, /assert the new behavior|alreadySatisfied/, "the steer says what to do");
  });

  it("red steers count toward the 5-steer cap, then a fresh continuation takes over", async () => {
    const dir = makeHookRepo();
    const pi = piWithGate({ landOnCommit: 1, hookPresent: true, hookExit: 1, hookOutput: "boom" });
    const state = warmTask();
    const ctx = ctxWithState(state, dir);
    const calls: UnitTask[] = [];
    const warm = makeWarmClient((_message, emit) => {
      emit(assistantLine(reportJson("still red", { phase: "red" })));
    });
    const runner: UnitRunner = async (unit) => {
      calls.push(unit);
      if (calls.length === 1) {
        setActiveUnitClient(warm.client);
        return { summary: "red", phase: "red", client: warm.client };
      }
      return { summary: "implemented fresh", suggestedCommit: "feat(core): fix T1" };
    };

    const result = await runLoop(pi, ctx, state, runner);

    assert.equal(result.complete, true, "the fresh continuation lands after the cap");
    assert.equal(warm.record.steers.length, WARM_STEER_CAP, "exactly 5 red steers before the cap");
    assert.equal(calls.length, 2, "the 6th red report goes to a fresh continuation");
    assert.match(calls[1]!.taskText, /red observed, implement now/, "the check result lands in the continuation task");
    assert.doesNotMatch(calls[1]!.taskText, /retry \d+\/5/, "still not charged to RETRY_BUDGET");
  });

  it("a red steer does not charge RETRY_BUDGET: the next fix round is still retry 1/5", async () => {
    const dir = makeHookRepo();
    const pi = piWithGate({ landOnCommit: 2, hookPresent: true, hookExit: 1, hookOutput: "boom" });
    const state = warmTask();
    const ctx = ctxWithState(state, dir);
    const calls: UnitTask[] = [];
    let steersSeen = 0;
    const warm = makeWarmClient((_message, emit) => {
      steersSeen++;
      if (steersSeen === 1) {
        emit(assistantLine(reportJson("implemented first try", { suggestedCommit: "feat(core): try" })));
      } else {
        emit(assistantLine(reportJson("fixed", { suggestedCommit: "feat(core): fix T1" })));
      }
    });
    const runner: UnitRunner = async (unit) => {
      calls.push(unit);
      setActiveUnitClient(warm.client);
      return { summary: "red ready", phase: "red", client: warm.client };
    };

    const result = await runLoop(pi, ctx, state, runner);

    assert.equal(result.complete, true);
    assert.equal(warm.record.steers.length, 2, "one red steer, one fix steer");
    assert.match(warm.record.steers[0]!, /red observed, implement now/);
    assert.match(
      warm.record.steers[1]!,
      /## Previous attempt failed \(retry 1\/5\)/,
      "the fix round after the red steer is still retry 1/5",
    );
    assert.equal(result.unitsRun, 1, "both rounds were warm steers");
  });

  it("implement.enforceTdd false removes the red phase and the check", async () => {
    const dir = mkdtempSync(join(tmpdir(), "pi-t6-notdd-"));
    mkdirSync(join(dir, ".pi"), { recursive: true });
    writeFileSync(join(dir, ".pi", "workflow.json"), JSON.stringify({ implement: { enforceTdd: false } }));
    resetWorkflowConfigCache();
    try {
      const pi = piWithGate({ landOnCommit: 1 });
      const state = warmTask();
      const ctx = ctxWithState(state, dir);
      const calls: UnitTask[] = [];
      const runner: UnitRunner = async (unit) => {
        calls.push(unit);
        return { summary: "done", phase: "red", suggestedCommit: "feat(core): done T1" };
      };

      const result = await runLoop(pi, ctx, state, runner);

      assert.equal(result.complete, true, "the attempt lands without a red phase");
      assert.doesNotMatch(calls[0]!.taskText, /"phase": "red"/, "no red phase in the task text");
      assert.ok(
        !(pi as GatePi).execLog.some((args) => args[0] === "hook"),
        "no pre-commit run is triggered",
      );
    } finally {
      resetWorkflowConfigCache();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("manual-kind behaviors carry no red section (the red instruction is gone, T3)", () => {
    const state = warmTask();
    const manual = { ...state.task!.behaviors[0]!, kind: "manual" as const };
    const text = buildUnitTask(manual, state.task!);
    assert.doesNotMatch(text, /"phase": "red"/, "no red-phase instruction in the task text");
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
