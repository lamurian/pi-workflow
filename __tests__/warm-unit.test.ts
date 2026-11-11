import { describe, it } from "vitest";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, sep } from "node:path";
import { shutdownWarmChild } from "../extensions/warm-unit.ts";
import {
  runOrchestratedImplement,
  type OrchestratorResult,
  type UnitRunner,
} from "../extensions/implement-loop.ts";
import type { UnitTask } from "../extensions/implementer-runner.ts";
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
    shutdowns: number;
  };
}

/** Fake kept-alive RpcUnitClient recording prompts, steers and shutdowns. */
function makeWarmClient(): FakeClientHandle {
  let stdout = "";
  let alive = true;
  const record = {
    steers: [] as string[],
    prompts: [] as Array<{ message: string; streamingBehavior?: string }>,
    shutdowns: 0,
  };
  const listeners = new Set<(event: Record<string, unknown>) => void>();
  const exitListeners = new Set<(info: { code: number }) => void>();
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
    prompt: (message: string, streamingBehavior?: string) => {
      record.prompts.push(streamingBehavior ? { message, streamingBehavior } : { message });
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
  return { client, record };
}

// ═══ shutdownWarmChild ═══
describe("warm child shutdown", () => {
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

// ═══ T7: warm-steer fix machinery removed ═══
describe("warm-steer fix machinery removed (T7)", () => {
  it("warm-unit exports no steerFixRound, canSteerWarmChild or WARM_STEER_CAP", async () => {
    const mod = (await import("../extensions/warm-unit.ts")) as Record<string, unknown>;
    assert.equal("steerFixRound" in mod, false, "steerFixRound is removed from warm-unit");
    assert.equal("canSteerWarmChild" in mod, false, "canSteerWarmChild is removed from warm-unit");
    assert.equal("WARM_STEER_CAP" in mod, false, "WARM_STEER_CAP is removed from warm-unit");
  });

  it("the attempt recorder exposes no runSteer", async () => {
    const { createAttemptRecorder } = await import("../extensions/warm-unit.ts");
    const recorder = createAttemptRecorder({
      behaviorId: "T1",
      cwd: "/tmp/test",
      runUnit: async () => ({ summary: "done" }),
      relay: () => {},
      recordFindings: () => false,
      fingerprint: async () => "fp",
      head: async () => null,
      history: [],
    });
    assert.equal("runSteer" in recorder, false, "runSteer is removed from the attempt recorder");
  });
});

// ═══ T6: fix rounds never warm-steer ═══
describe("fix rounds never warm-steer (T6)", () => {
  /** Fresh loop run with the cancelled flag reset (cancelOrchestration is sticky). */
  async function runLoop(pi: ExtensionAPI, ctx: ExtensionContext, state: WorkflowState, runner: UnitRunner) {
    beginOrchestration(Promise.resolve());
    try {
      return await runOrchestratedImplement(pi, ctx, state, state.task!, runner);
    } finally {
      endOrchestration();
    }
  }

  it("a fix round never steers into the kept-alive child and its prompt carries the gate failure output (T6)", async () => {
    const pi = piWithGate({ landOnCommit: 2 }); // hook rejects commit 1, lands 2
    const state = warmTask();
    const ctx = ctxWithState(state);
    const calls: UnitTask[] = [];
    const warm = makeWarmClient();
    const runner: UnitRunner = async (unit) => {
      calls.push(unit);
      if (calls.length === 1) {
        setActiveUnitClient(warm.client);
        return { summary: "implemented", suggestedCommit: "feat(core): base", client: warm.client, contextPercent: 30 };
      }
      return { summary: "fixed", suggestedCommit: "feat(core): fix T1" };
    };

    const result = await runLoop(pi, ctx, state, runner);

    assert.equal(result.complete, true, result.error ?? "the run lands after one fresh fix round");
    assert.deepEqual(result.landedCommits, ["feat(core): fix T1"], "the commit uses the fix report");
    assert.equal(calls.length, 2, "base plus exactly one fresh fix spawn");
    assert.equal(warm.record.prompts.length, 0, "the kept-alive child never receives the fix prompt");
    assert.deepEqual(warm.record.steers, [], "the fix round never steers into the kept-alive child");
    assert.equal(warm.record.shutdowns, 1, "the kept-alive child is shut down before the fresh spawn");
    assert.match(calls[1]!.taskText, /## Previous attempt failed \(retry 1\/5\)/, "the fresh spawn carries the fix text");
    assert.match(calls[1]!.taskText, /husky - pre-commit hook failed/, "the prompt carries the gate failure output");
    assert.match(calls[1]!.session?.id ?? "", /-fix1$/, "fresh session id <implSessionId>-fix1");
    assert.equal(calls[1]!.session?.forkFrom, undefined, "a mechanical trigger fresh-spawns");
  });
});

// ═══ Loop integration: warm retries ═══
describe("fix sessions replace warm retries (T6)", () => {
  /** Fresh loop run with the cancelled flag reset (cancelOrchestration is sticky). */
  async function runLoop(pi: ExtensionAPI, ctx: ExtensionContext, state: WorkflowState, runner: UnitRunner) {
    beginOrchestration(Promise.resolve());
    try {
      return await runOrchestratedImplement(pi, ctx, state, state.task!, runner);
    } finally {
      endOrchestration();
    }
  }

  it("persistent hook rejection halts after five fresh fix units on fresh session ids (T6)", async () => {
    const pi = piWithGate({}); // hook always rejects, tree stays dirty
    const state = warmTask();
    const ctx = ctxWithState(state);
    const calls: UnitTask[] = [];
    const warm = makeWarmClient();
    const runner: UnitRunner = async (unit) => {
      calls.push(unit);
      if (calls.length === 1) {
        setActiveUnitClient(warm.client);
        return { summary: "attempt", suggestedCommit: "feat(core): base", client: warm.client };
      }
      return { summary: `attempt ${calls.length}`, suggestedCommit: "feat(core): base" };
    };

    const result: OrchestratorResult = await runLoop(pi, ctx, state, runner);

    assert.equal(result.complete, false, "the run halts once the budget is spent");
    assert.equal(result.haltedOn, "T1");
    assert.match(result.error ?? "", /after 5 retries/);
    assert.equal(calls.length, 6, "base plus five fresh fix units — never a warm steer");
    assert.equal(warm.record.prompts.length, 0, "the kept-alive child is never prompted");
    assert.deepEqual(warm.record.steers, [], "no steer commands at all");
    assert.equal(warm.record.shutdowns, 1, "the child is shut down before the first fresh fix spawn");
    for (const [i, spawn] of calls.slice(1).entries()) {
      assert.match(spawn.session?.id ?? "", new RegExp(`-fix${i + 1}$`), "fresh id per fix index");
      assert.equal(spawn.session?.forkFrom, undefined, "a mechanical trigger never forks");
    }
    assert.equal(result.attempts?.length, 6, "base attempt plus 5 fix rounds in the attempt table");
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
