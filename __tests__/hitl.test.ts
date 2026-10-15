import { describe, it, vi } from "vitest";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import type {
  ExtensionAPI,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import {
  relayImplementerEvent,
  runImplStatus,
  formatImplementerActivity,
  runOrchestratedImplement,
  runApprove,
  runSteer,
  handleWorkflowInput,
  cleanupOrchestration,
  getHitlWindow,
  setHitlWindow,
  type OrchestratorResult,
  type UnitRunner,
} from "../extensions/implement-loop.ts";
import { registerImplementerActivityRenderer, composeCompletionReport, runImplement } from "../extensions/implement.ts";
import { getHitlTimeoutMs } from "../extensions/implement-loop.ts";
import {
  shutdownActiveClient,
  setActiveUnitClient,
  getActiveUnitClient,
} from "../extensions/implementer-runner.ts";
import { saveState, loadState } from "../extensions/state.ts";
import type { RpcUnitClient, RpcImage } from "../extensions/rpc-unit-client.ts";
import type { WorkflowState, TaskContract } from "../extensions/state.ts";

// ═══════════════════════════════════════════════════════════════════════════════
// Shared harness for the HITL behaviors (T2–T6)
// ═══════════════════════════════════════════════════════════════════════════════

/** Recorded ExtensionAPI mock with ui spies attached by the caller. */
function mockPi(): ExtensionAPI & {
  calls: Record<string, unknown[]>;
  onUnsubscribed: string[];
} {
  const calls: Record<string, unknown[]> = {};
  const onUnsubscribed: string[] = [];
  const record = (name: string) => {
    calls[name] = [];
    return (...args: unknown[]) => {
      calls[name]!.push(args);
    };
  };
  const on = ((name: string, handler: unknown) => {
    calls["on"] = calls["on"] ?? [];
    calls["on"]!.push([name, handler]);
    let active = true;
    return () => {
      if (active) {
        active = false;
        onUnsubscribed.push(name);
      }
    };
  }) as unknown as ExtensionAPI["on"];
  return {
    on,
    registerCommand: record("registerCommand") as ExtensionAPI["registerCommand"],
    registerTool: record("registerTool") as ExtensionAPI["registerTool"],
    registerEntryRenderer: record("registerEntryRenderer") as ExtensionAPI["registerEntryRenderer"],
    appendEntry: record("appendEntry") as ExtensionAPI["appendEntry"],
    sendUserMessage: record("sendUserMessage") as ExtensionAPI["sendUserMessage"],
    getActiveTools: () => ["read", "bash"],
    getAllTools: () => [{ name: "read" }, { name: "bash" }],
    setActiveTools: record("setActiveTools") as ExtensionAPI["setActiveTools"],
    exec: async () => ({ stdout: "", stderr: "", code: 0, killed: false }),
    calls,
    onUnsubscribed,
  } as unknown as ExtensionAPI & {
    calls: Record<string, unknown[]>;
    onUnsubscribed: string[];
  };
}

/** Context with recorded notify/setStatus so tests can assert UI traffic. */
function ctxWithUiSpies(state?: WorkflowState): ExtensionContext & {
  statusCalls: Array<[string, string | undefined]>;
  notifyCalls: Array<[string, string | undefined]>;
} {
  const statusCalls: Array<[string, string | undefined]> = [];
  const notifyCalls: Array<[string, string | undefined]> = [];
  return {
    cwd: "/tmp/test",
    sessionManager: {
      getBranch: () =>
        state ? [{ type: "custom", customType: "workflow-state", data: state }] : [],
    },
    ui: {
      notify: (msg: string, kind?: string) => {
        notifyCalls.push([msg, kind]);
      },
      setStatus: (key: string, value?: string) => {
        statusCalls.push([key, value]);
      },
      setWidget: () => {},
      setTitle: () => {},
      theme: { fg: (_c: string, t: string) => t },
      addAutocompleteProvider: () => {},
    },
    statusCalls,
    notifyCalls,
  } as unknown as ExtensionContext & {
    statusCalls: Array<[string, string | undefined]>;
    notifyCalls: Array<[string, string | undefined]>;
  };
}

// ═══════════════════════════════════════════════════════════════════════════════
// Shared helpers
// ═══════════════════════════════════════════════════════════════════════════════

/** Poll until `check` passes or `ms` elapses. */
async function waitFor(check: () => boolean, ms = 3_000): Promise<boolean> {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (check()) return true;
    await new Promise((r) => setTimeout(r, 25));
  }
  return check();
}

/** Exec mock where git commit advances HEAD; records exec invocations. */
function piWithAdvancingHead(): ExtensionAPI & {
  calls: Record<string, unknown[]>;
  execLog: string[];
} {
  const pi = mockPi() as ExtensionAPI & { calls: Record<string, unknown[]>; execLog: string[] };
  const execLog: string[] = [];
  let headCounter = 0;
  pi.exec = (async (cmd: string, args: string[]) => {
    execLog.push(`${cmd} ${args.join(" ")}`);
    if (cmd === "git" && args[0] === "rev-parse") {
      return { stdout: `head${headCounter}\n`, stderr: "", code: 0, killed: false };
    }
    if (cmd === "git" && args[0] === "commit") {
      headCounter++;
      return { stdout: "[main abc] committed", stderr: "", code: 0, killed: false };
    }
    return { stdout: "", stderr: "", code: 0, killed: false };
  }) as ExtensionAPI["exec"];
  pi.execLog = execLog;
  return pi;
}

/** Count of `git commit` invocations recorded by piWithAdvancingHead. */
function commitCount(pi: { execLog: string[] }): number {
  return pi.execLog.filter((entry) => entry.startsWith("git commit")).length;
}

/** Fake kept-alive client for manual behaviors, with spy counters. */
function fakeManualClient(record: { shutdowns: number; steers?: Array<{ message: string; images?: RpcImage[] }> }): RpcUnitClient {
  return {
    isAlive: () => true,
    shutdown: async () => {
      record.shutdowns++;
    },
    kill: () => {},
    send: () => {},
    command: async () => ({ type: "response", success: true, id: "x" }),
    prompt: () => {},
    steer: (message: string, images?: RpcImage[]) => {
      record.steers?.push(images ? { message, images } : { message });
    },
    onEvent: () => () => {},
    onExit: () => () => {},
    rawStdout: () => "",
    stderrText: () => "",
  } as unknown as RpcUnitClient;
}

// ═══════════════════════════════════════════════════════════════════════════════
// T2 — zero-token activity relay + /impl-status
// ═══════════════════════════════════════════════════════════════════════════════

describe("T2: zero-token activity relay", () => {
  it("turn_end updates the implement status; assistant message_end notifies and persists a custom entry; no sendUserMessage", () => {
    const pi = mockPi();
    const ctx = ctxWithUiSpies();

    relayImplementerEvent(pi, ctx, "T2", "1/2", {
      type: "turn_end",
      message: { role: "assistant", content: [] },
      toolResults: [],
    });
    relayImplementerEvent(pi, ctx, "T2", "1/2", {
      type: "message_end",
      message: {
        role: "assistant",
        content: [{ type: "text", text: "Updated block-handle-gutter.ts to anchor on the column" }],
      },
    });

    const status = ctx.statusCalls.filter(([key]) => key === "implement");
    assert.ok(status.length >= 1, "turn_end must drive the implement status line");
    assert.ok(
      status.some(([, value]) => (value ?? "").includes("T2")),
      "status line carries the behavior id",
    );

    const notifies = ctx.notifyCalls.map(([msg]) => msg);
    assert.ok(
      notifies.some((m) => m.includes("T2") && m.includes("block-handle-gutter")),
      "assistant milestone is notified with behavior id and compact text",
    );

    const activity = (pi.calls["appendEntry"] ?? []) as Array<[string, unknown]>;
    assert.ok(
      activity.some(([type]) => type === "implementer-activity"),
      "relay detail is persisted as a custom entry",
    );
    assert.equal(
      (pi.calls["sendUserMessage"] ?? []).length,
      0,
      "relay must never send a message to the main-process model",
    );
  });

  it("user-role message_end and non-message events are not notified", () => {
    const pi = mockPi();
    const ctx = ctxWithUiSpies();
    relayImplementerEvent(pi, ctx, "T2", "1/2", {
      type: "message_end",
      message: { role: "user", content: [{ type: "text", text: "Implement behavior T2." }] },
    });
    assert.equal(ctx.notifyCalls.length, 0, "user messages are not relayed as milestones");
    const activity = (pi.calls["appendEntry"] ?? []) as Array<[string, unknown]>;
    assert.equal(
      activity.filter(([type]) => type === "implementer-activity").length,
      0,
      "user messages are not persisted as activity",
    );
  });

  it("the orchestrator forwards child events from the unit runner into the relay", async () => {
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
    const ctx = ctxWithUiSpies();
    const state: WorkflowState = {
      phase: "implementing",
      specText: "topic",
      task: {
        title: "Relay Task",
        instruction: "do it",
        files: ["src/a.ts"],
        done: "green",
        behaviors: [
          { id: "T1", description: "a behavior", expectedOutput: "e", kind: "test", status: "active" },
        ],
      },
    };
    const runner: UnitRunner = async (unit, _cwd, _signal, onEvent) => {
      onEvent?.({ type: "turn_end", message: { role: "assistant", content: [] }, toolResults: [] });
      onEvent?.({
        type: "message_end",
        message: { role: "assistant", content: [{ type: "text", text: "unit finished its work" }] },
      });
      return { summary: `implemented ${unit.behaviorId}`, suggestedCommit: "feat(core): land it" };
    };
    const result = await runOrchestratedImplement(pi, ctx, state, state.task!, runner);
    assert.equal(result.complete, true, "the loop completes with an injected runner");
    assert.ok(
      ctx.statusCalls.some(
        ([key, value]) =>
          key === "implement" &&
          (value ?? "").includes("T1") &&
          /responding|working with tools/.test(value ?? ""),
      ),
      "the loop drives the status line from forwarded child events (relay wording)",
    );
    const activity = (pi.calls["appendEntry"] ?? []) as Array<[string, unknown]>;
    assert.ok(
      activity.some(([type]) => type === "implementer-activity"),
      "forwarded events are persisted as activity entries",
    );
  });

  it("/impl-status with a live child queries get_last_assistant_text and relays a summary", async () => {
    const pi = mockPi();
    const ctx = ctxWithUiSpies();
    const sent: Array<Record<string, unknown>> = [];
    const fakeClient = {
      isAlive: () => true,
      command: async (command: Record<string, unknown>) => {
        sent.push(command);
        return {
          type: "response",
          command: "get_last_assistant_text",
          success: true,
          id: "rpc-1",
          data: { text: "All checks pass; report emitted" },
        };
      },
    } as unknown as RpcUnitClient;
    setActiveUnitClient(fakeClient);
    try {
      await runImplStatus(pi, ctx);
    } finally {
      setActiveUnitClient(undefined);
    }
    assert.equal(sent.length, 1, "exactly one query reaches the child");
    assert.equal(sent[0]!["type"], "get_last_assistant_text");
    assert.ok(
      ctx.notifyCalls.some(([msg]) => msg.includes("All checks pass")),
      "the summary is relayed via notify",
    );
    const activity = (pi.calls["appendEntry"] ?? []) as Array<[string, unknown]>;
    assert.ok(
      activity.some(([type]) => type === "implementer-activity"),
      "the summary is persisted as an activity entry",
    );
  });

  it("/impl-status without a live child refuses and sends nothing", async () => {
    const pi = mockPi();
    const ctx = ctxWithUiSpies();
    setActiveUnitClient(undefined);
    await runImplStatus(pi, ctx);
    assert.equal(ctx.notifyCalls.length, 1, "a single refusal notification");
    const [msg, kind] = ctx.notifyCalls[0]!;
    assert.match(msg, /implementer subprocess/, "the refusal names why it is unavailable");
    assert.equal(kind, "warning");
    const activity = (pi.calls["appendEntry"] ?? []) as Array<[string, unknown]>;
    assert.equal(
      activity.filter(([type]) => type === "implementer-activity").length,
      0,
      "nothing is persisted when no child is running",
    );
  });
});

describe("T2: relay entry renderer", () => {
  it("formatImplementerActivity compacts an entry and truncates long text", () => {
    const line = formatImplementerActivity({
      behaviorId: "T2",
      kind: "assistant",
      text: "x".repeat(500),
      at: "2024-01-01T00:00:00.000Z",
    });
    assert.ok(line.includes("T2"), "the line carries the behavior id");
    assert.ok(line.length < 250, "long text is truncated for the transcript");
    assert.ok(line.endsWith("…"), "truncation is marked");
  });

  it("registerImplementerActivityRenderer degrades gracefully when pi-tui is unavailable", async () => {
    const pi = mockPi();
    const registered = await registerImplementerActivityRenderer(pi);
    assert.equal(typeof registered, "boolean", "registration reports its outcome without throwing");
    if (registered) {
      const renderers = (pi.calls["registerEntryRenderer"] ?? []) as Array<[string, unknown]>;
      assert.ok(
        renderers.some(([type]) => type === "implementer-activity"),
        "a successful registration targets the implementer-activity entry type",
      );
    }
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// T3 — manual-only verification pause with /approve
// ═══════════════════════════════════════════════════════════════════════════════

describe("T3: manual verification pause", () => {
  function twoKindTask(): TaskContract {
    return {
      title: "Mixed Task",
      instruction: "do things",
      files: ["src/a.ts"],
      done: "all green",
      behaviors: [
        { id: "T1", description: "test behavior", expectedOutput: "e1", kind: "test", status: "active" },
        { id: "T2", description: "visual gutter alignment", expectedOutput: "e2", kind: "manual", status: "active" },
      ],
    };
  }

  it("manual behavior pauses before commit; /approve closes the pause, commits, and the loop completes; test behaviors still auto-commit", async () => {
    const pi = piWithAdvancingHead();
    const ctx = ctxWithUiSpies();
    const state: WorkflowState = { phase: "implementing", specText: "t", task: twoKindTask() };
    const record = { shutdowns: 0 };
    const client = fakeManualClient(record);
    const runner: UnitRunner = async (unit) => {
      const report = {
        summary: `implemented ${unit.behaviorId}`,
        suggestedCommit: `feat(core): land ${unit.behaviorId.toLowerCase()}`,
      };
      return unit.behaviorId === "T2" ? { ...report, client } : report;
    };

    const loop = runOrchestratedImplement(pi, ctx, state, state.task!, runner);
    assert.ok(
      await waitFor(() => ctx.notifyCalls.some(([m]) => /T2 awaiting manual verification/.test(m))),
      "the pause opens with the verification guidance notify",
    );
    assert.equal(commitCount(pi), 1, "only the test behavior committed before approval");
    assert.equal(state.task!.behaviors[1]!.status, "active", "T2 is not done before approval");
    assert.ok(getHitlWindow(), "the hitl window is open during the pause");
    assert.equal(getHitlWindow()!.behaviorId, "T2");
    assert.ok(
      ctx.statusCalls.some(([key, value]) => key === "implement" && /awaiting verification/.test(value ?? "")),
      "the status frame announces the pause",
    );

    runApprove(pi, ctx);
    const result = await loop;

    assert.equal(result.complete, true, "approval lets the run settle complete");
    assert.equal(commitCount(pi), 2, "approval triggers the deferred commit");
    assert.equal(state.task!.behaviors[1]!.status, "done", "T2 is done after approval");
    assert.equal(getHitlWindow(), undefined, "the window is cleared after approval");
    assert.equal(record.shutdowns, 1, "the kept-alive child is shut down once the pause closes");
  });

  it("/approve outside a pause refuses with a warning and no side effects", () => {
    const pi = piWithAdvancingHead();
    const ctx = ctxWithUiSpies();
    runApprove(pi, ctx);
    assert.equal(ctx.notifyCalls.length, 1, "exactly one refusal notification");
    const [msg, kind] = ctx.notifyCalls[0]!;
    assert.match(msg, /\/approve/, "the refusal names the command");
    assert.match(msg, /manual verification pause/, "the refusal names the valid period");
    assert.equal(kind, "warning");
    assert.equal(commitCount(pi), 0, "no commit is attempted");
  });

  it("mustRunNow on a manual unit halts before any pause", async () => {
    const pi = piWithAdvancingHead();
    const ctx = ctxWithUiSpies();
    const state: WorkflowState = { phase: "implementing", specText: "t", task: twoKindTask() };
    const runner: UnitRunner = async (unit) => {
      if (unit.behaviorId === "T2") {
        return {
          summary: "blocked",
          blockedCommands: [{ command: "npx playwright install", mustRunNow: true }],
        };
      }
      return { summary: "ok", suggestedCommit: "feat(core): land t1" };
    };
    const result = await runOrchestratedImplement(pi, ctx, state, state.task!, runner);
    assert.equal(result.haltedOn, "T2", "the loop halts on the blocked unit");
    assert.ok(result.pendingCommand, "the pending command rides the halt");
    assert.ok(
      !ctx.notifyCalls.some(([m]) => /awaiting manual verification/.test(m)),
      "no pause opens for a blocked unit",
    );
    assert.equal(getHitlWindow(), undefined, "no window is left open");
  });

  it("content/unit-prompt.md describes the manual pause and mid-pause steering", async () => {
    const text = await readFile(new URL("../content/unit-prompt.md", import.meta.url), "utf8");
    assert.match(text, /manual/i, "the prompt covers manual behaviors");
    assert.match(text, /verif/i, "the prompt describes the verification pause");
    assert.match(text, /steer/i, "the prompt mentions mid-pause steering");
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// T4 — steering during the verification pause
// ═══════════════════════════════════════════════════════════════════════════════

describe("T4: steering during the verification pause", () => {
  type SteerRecord = { shutdowns: number; steers: Array<{ message: string; images?: RpcImage[] }> };

  /** Open window + live child; returns the spy record and a cleanup fn. */
  function openPause(): { record: SteerRecord; cleanup: () => void } {
    const record: SteerRecord = { shutdowns: 0, steers: [] };
    setActiveUnitClient(fakeManualClient(record));
    setHitlWindow({ behaviorId: "T2", description: "gutter", approve: () => {} });
    return {
      record,
      cleanup: () => {
        setHitlWindow(undefined);
        setActiveUnitClient(undefined);
      },
    };
  }

  it("plain input with an open window is consumed and forwarded as steer with images", () => {
    const { record, cleanup } = openPause();
    try {
      const result = handleWorkflowInput({
        type: "input",
        text: "the toolbar sits 12px too far left",
        images: [{ type: "image", data: "aGVsbG8=", mimeType: "image/png" }],
        source: "interactive",
      });
      assert.deepEqual(result, { action: "handled" }, "plain input is consumed, not passed on");
      assert.equal(record.steers.length, 1, "one steer reaches the child");
      assert.equal(record.steers[0]!.message, "the toolbar sits 12px too far left");
      assert.equal(record.steers[0]!.images?.length, 1, "pasted images ride the steer");
    } finally {
      cleanup();
    }
  });

  it("slash commands pass through even with an open window", () => {
    const { record, cleanup } = openPause();
    try {
      const result = handleWorkflowInput({ type: "input", text: "/task", source: "interactive" });
      assert.deepEqual(result, { action: "continue" }, "slash commands reach the main agent");
      assert.equal(record.steers.length, 0, "nothing is forwarded to the child");
    } finally {
      cleanup();
    }
  });

  it("with no open window every input passes through", () => {
    const record: SteerRecord = { shutdowns: 0, steers: [] };
    setActiveUnitClient(fakeManualClient(record));
    setHitlWindow(undefined);
    try {
      const result = handleWorkflowInput({
        type: "input",
        text: "how is the run going?",
        source: "interactive",
      });
      assert.deepEqual(result, { action: "continue" });
      assert.equal(record.steers.length, 0, "nothing is forwarded outside a pause");
    } finally {
      setActiveUnitClient(undefined);
    }
  });

  it("/steer forwards to the live child and emits the feedback status frame", () => {
    const pi = piWithAdvancingHead();
    const ctx = ctxWithUiSpies();
    const { record, cleanup } = openPause();
    try {
      runSteer("try 16px offset instead", pi, ctx);
      assert.equal(record.steers.length, 1, "the message reaches the child");
      assert.equal(record.steers[0]!.message, "try 16px offset instead");
      assert.ok(
        ctx.statusCalls.some(
          ([key, value]) =>
            key === "implement" &&
            /T2/.test(value ?? "") &&
            /feedback forwarded/.test(value ?? ""),
        ),
        "the status frame announces forwarded feedback",
      );
    } finally {
      cleanup();
    }
  });

  it("/steer outside a pause refuses and writes nothing", () => {
    const pi = piWithAdvancingHead();
    const ctx = ctxWithUiSpies();
    const record: SteerRecord = { shutdowns: 0, steers: [] };
    setActiveUnitClient(fakeManualClient(record));
    setHitlWindow(undefined);
    try {
      runSteer("hello?", pi, ctx);
      assert.equal(record.steers.length, 0, "nothing reaches the child");
      assert.equal(ctx.notifyCalls.length, 1, "one refusal notification");
      const [msg, kind] = ctx.notifyCalls[0]!;
      assert.match(msg, /\/steer/, "the refusal names the command");
      assert.match(msg, /verification pause/, "the refusal names the valid period");
      assert.equal(kind, "warning");
    } finally {
      setActiveUnitClient(undefined);
    }
  });

  it("the orchestrator registers the input handler at start and unregisters at settle", async () => {
    const pi = piWithAdvancingHead();
    const ctx = ctxWithUiSpies();
    const state: WorkflowState = {
      phase: "implementing",
      specText: "t",
      task: {
        title: "Input Task",
        instruction: "x",
        files: ["src/a.ts"],
        done: "green",
        behaviors: [
          { id: "T1", description: "a behavior", expectedOutput: "e", kind: "test", status: "active" },
        ],
      },
    };
    const runner: UnitRunner = async () => ({ summary: "ok", suggestedCommit: "feat(core): land it" });
    const result = await runOrchestratedImplement(pi, ctx, state, state.task!, runner);
    assert.equal(result.complete, true);
    const ons = (pi.calls["on"] ?? []) as Array<[string, unknown]>;
    assert.ok(
      ons.some(([name]) => name === "input"),
      "an input handler is registered for the orchestration",
    );
    assert.ok(
      pi.onUnsubscribed.includes("input"),
      "the input handler is unregistered when the run settles",
    );
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// T5 — HITL timeout clock and manual-check deferral
// ═══════════════════════════════════════════════════════════════════════════════

describe("T5: HITL clock and deferral", () => {
  it("getHitlTimeoutMs honors PI_HITL_TIMEOUT_MS and is independent of PI_IMPLEMENT_TIMEOUT_MS", () => {
    assert.equal(getHitlTimeoutMs({}), 900_000, "15-minute default");
    assert.equal(getHitlTimeoutMs({ PI_HITL_TIMEOUT_MS: "5000" }), 5_000);
    assert.equal(
      getHitlTimeoutMs({ PI_HITL_TIMEOUT_MS: "5000", PI_IMPLEMENT_TIMEOUT_MS: "600000" }),
      5_000,
      "the HITL clock does not read the model-activity budget",
    );
    assert.equal(getHitlTimeoutMs({ PI_HITL_TIMEOUT_MS: "nonsense" }), 900_000, "invalid falls back");
    assert.equal(getHitlTimeoutMs({ PI_HITL_TIMEOUT_MS: "-1" }), 900_000, "non-positive falls back");
  });

  function manualOnlyTask(): TaskContract {
    return {
      title: "Manual Only",
      instruction: "x",
      files: ["src/a.ts"],
      done: "green",
      behaviors: [
        { id: "T1", description: "visual check", expectedOutput: "e", kind: "manual", status: "active" },
      ],
    };
  }

  /** Flush fake-timer microtask chains until `check` passes. */
  async function flushUntil(check: () => boolean, maxTicks = 50): Promise<boolean> {
    for (let i = 0; i < maxTicks; i++) {
      if (check()) return true;
      await vi.advanceTimersByTimeAsync(0);
    }
    return check();
  }

  it("a pause that times out commits anyway and defers the behavior to pendingManualChecks", async () => {
    const prev = process.env.PI_HITL_TIMEOUT_MS;
    process.env.PI_HITL_TIMEOUT_MS = "5000";
    vi.useFakeTimers();
    try {
      const pi = piWithAdvancingHead();
      const ctx = ctxWithUiSpies();
      const state: WorkflowState = { phase: "implementing", specText: "t", task: manualOnlyTask() };
      const record = { shutdowns: 0 };
      const runner: UnitRunner = async (unit) => ({
        summary: `implemented ${unit.behaviorId}`,
        suggestedCommit: "feat(core): visual check",
        client: fakeManualClient(record),
      });

      const loop = runOrchestratedImplement(pi, ctx, state, state.task!, runner);
      assert.ok(
        await flushUntil(() => ctx.notifyCalls.some(([m]) => /awaiting manual verification/.test(m))),
        "the pause opens",
      );

      await vi.advanceTimersByTimeAsync(5_000);
      const result = await loop;

      assert.ok(
        ctx.notifyCalls.some(([m, kind]) => /verification timed out/.test(m) && kind === "warning"),
        "the timeout warns that the behavior is committed anyway",
      );
      assert.equal(result.complete, true, "the run still settles complete");
      assert.equal(state.task!.behaviors[0]!.status, "done", "the behavior is committed through the gate");
      assert.equal(commitCount(pi), 1, "hooks-gated commit happened on timeout");
      assert.deepEqual(
        result.pendingManualChecks?.map((c) => c.behaviorId),
        ["T1"],
        "the deferral rides OrchestratorResult",
      );
      assert.deepEqual(
        state.pendingManualChecks?.map((c) => c.behaviorId),
        ["T1"],
        "the deferral is persisted in workflow state",
      );
      assert.equal(getHitlWindow(), undefined, "no window is left open");
      assert.equal(record.shutdowns, 1, "the kept-alive child is shut down");
    } finally {
      vi.useRealTimers();
      if (prev === undefined) delete process.env.PI_HITL_TIMEOUT_MS;
      else process.env.PI_HITL_TIMEOUT_MS = prev;
    }
  });

  it("a successful steer resets the HITL clock; approval after the original deadline still avoids deferral", async () => {
    const prev = process.env.PI_HITL_TIMEOUT_MS;
    process.env.PI_HITL_TIMEOUT_MS = "5000";
    vi.useFakeTimers();
    try {
      const pi = piWithAdvancingHead();
      const ctx = ctxWithUiSpies();
      const state: WorkflowState = { phase: "implementing", specText: "t", task: manualOnlyTask() };
      const record = { shutdowns: 0, steers: [] as Array<{ message: string }> };
      const client = fakeManualClient(record);
      const runner: UnitRunner = async () => {
        setActiveUnitClient(client); // mirrors runImplementerUnit's registry behavior
        return {
          summary: "implemented T1",
          suggestedCommit: "feat(core): visual check",
          client,
        };
      };

      const loop = runOrchestratedImplement(pi, ctx, state, state.task!, runner);
      assert.ok(
        await flushUntil(() => ctx.notifyCalls.some(([m]) => /awaiting manual verification/.test(m))),
        "the pause opens",
      );

      await vi.advanceTimersByTimeAsync(4_000);
      runSteer("still checking", pi, ctx); // resets the clock: fires at 9000 now.
      await vi.advanceTimersByTimeAsync(4_000); // original deadline (5000) has passed.
      assert.ok(getHitlWindow(), "the pause survives past the original deadline after a steer");

      runApprove(pi, ctx);
      const result = await loop;
      assert.equal(result.complete, true);
      assert.equal(result.pendingManualChecks?.length ?? 0, 0, "no deferral after an active pause");
      assert.equal(record.steers.length, 1, "the steer reached the child");
    } finally {
      vi.useRealTimers();
      if (prev === undefined) delete process.env.PI_HITL_TIMEOUT_MS;
      else process.env.PI_HITL_TIMEOUT_MS = prev;
    }
  });

  it("composeCompletionReport renders the manual-verification section only when checks are pending", () => {
    const task: TaskContract = {
      title: "T",
      instruction: "x",
      files: ["a.ts"],
      done: "green",
      behaviors: [{ id: "T1", description: "d", expectedOutput: "e", kind: "test", status: "done" }],
    };
    const base: OrchestratorResult = { complete: true, unitsRun: 1, landedCommits: ["feat: x"] };
    const without = composeCompletionReport(base, task);
    assert.ok(!without.includes("Manual verification required"), "no section when nothing is pending");

    const withChecks = composeCompletionReport(
      { ...base, pendingManualChecks: [{ behaviorId: "T2", description: "gutter alignment" }] },
      task,
    );
    assert.match(withChecks, /Manual verification required/, "the section renders when pending");
    assert.match(withChecks, /T2/, "the pending behavior id is listed");
    assert.match(withChecks, /gutter alignment/, "the pending behavior description is listed");
    assert.match(withChecks, /confirm/i, "the section asks for confirmation in the app");
  });

  it("saveState/loadState round-trips pendingManualChecks; legacy states load cleanly", async () => {
    const pi = mockPi();
    const state: WorkflowState = {
      phase: "implementing",
      specText: "t",
      pendingManualChecks: [{ behaviorId: "T2", description: "gutter alignment" }],
    };
    saveState(pi, state);
    const branch = (pi.calls["appendEntry"] ?? []).map(([customType, data]) => ({
      type: "custom",
      customType,
      data,
    }));
    const ctx = {
      sessionManager: { getBranch: () => branch },
    } as unknown as ExtensionContext;
    const loaded = loadState(ctx);
    assert.deepEqual(loaded?.pendingManualChecks, state.pendingManualChecks, "round-trips the field");

    const legacyCtx = {
      sessionManager: {
        getBranch: () => [
          { type: "custom", customType: "workflow-state", data: { phase: "implementing", specText: "t" } },
        ],
      },
    } as unknown as ExtensionContext;
    assert.equal(loadState(legacyCtx)?.pendingManualChecks, undefined, "legacy states load cleanly");
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// T6 — orphan safety
// ═══════════════════════════════════════════════════════════════════════════════

describe("T6: orphan safety", () => {
  it("session_shutdown aborts and kills the live child, clears the window, and unregisters the input handler", async () => {
    const factory = (await import("../extensions/index.ts")).default;
    const pi = mockPi();
    factory(pi);
    const ons = (pi.calls["on"] ?? []) as Array<[string, unknown]>;
    const shutdownEntry = ons.find(([name]) => name === "session_shutdown");
    assert.ok(shutdownEntry, "a session_shutdown handler is registered");
    const handler = shutdownEntry![1] as (event: unknown, ctx: unknown) => Promise<void>;

    const record = { shutdowns: 0 };
    setActiveUnitClient(fakeManualClient(record));
    setHitlWindow({ behaviorId: "T2", description: "gutter", approve: () => {} });
    await handler({}, {});

    assert.equal(record.shutdowns, 1, "the live child is shut down on session shutdown");
    assert.equal(getActiveUnitClient(), undefined, "the registry is cleared");
    assert.equal(getHitlWindow(), undefined, "the pause window is cleared");
  });

  it("the orchestrator halt path shuts the live child and clears the window", async () => {
    const pi = piWithAdvancingHead();
    const ctx = ctxWithUiSpies();
    const record = { shutdowns: 0 };
    const client = fakeManualClient(record);
    setActiveUnitClient(client);
    setHitlWindow({ behaviorId: "T2", description: "gutter", approve: () => {} });
    const state: WorkflowState = {
      phase: "implementing",
      specText: "t",
      task: {
        title: "Orphan Task",
        instruction: "x",
        files: ["src/a.ts"],
        done: "green",
        behaviors: [
          { id: "T2", description: "gutter", expectedOutput: "e", kind: "manual", status: "active" },
        ],
      },
    };
    // A mustRunNow halt after the manual unit reported would leave the
    // child alive; simulate via the runner reporting a blocked command on
    // a second attempt path — here the halt occurs before any pause for a
    // blocked unit, so drive the halt directly with a failing runner.
    const runner: UnitRunner = async () => ({
      summary: "failed",
      error: "boom",
    });
    const result = await runOrchestratedImplement(pi, ctx, state, state.task!, runner);
    assert.ok(result.haltedOn, "the loop halts");
    assert.equal(getHitlWindow(), undefined, "the window is cleared on halt");
    assert.ok(pi.onUnsubscribed.includes("input"), "the input handler is unregistered on halt");
  });

  it("post-run input passes through; /steer /approve /impl-status refuse", async () => {
    // After a settled run there is no window and no child: everything
    // refuses or passes through.
    setHitlWindow(undefined);
    setActiveUnitClient(undefined);
    const pi = piWithAdvancingHead();
    const ctx = ctxWithUiSpies();
    assert.deepEqual(handleWorkflowInput({ type: "input", text: "hello", source: "interactive" }), {
      action: "continue",
    });
    runSteer("hello", pi, ctx);
    runApprove(pi, ctx);
    await runImplStatus(pi, ctx);
    const warnings = ctx.notifyCalls.filter(([, kind]) => kind === "warning");
    assert.equal(warnings.length, 3, "all three commands refuse outside a pause");
  });

  it("the in-flight guard still refuses re-entry while a pause is open", async () => {
    const pi = piWithAdvancingHead();
    const task: TaskContract = {
      title: "Guard Pause Task",
      instruction: "x",
      files: ["src/a.ts"],
      done: "green",
      behaviors: [
        { id: "T1", description: "visual check", expectedOutput: "e", kind: "manual", status: "active" },
      ],
    };
    const state: WorkflowState = { phase: "finalizing", specText: "t", task };
    const ctx = ctxWithUiSpies(state);
    const record = { shutdowns: 0 };
    const runner: UnitRunner = async (unit) => ({
      summary: `implemented ${unit.behaviorId}`,
      suggestedCommit: "feat(core): visual check",
      client: fakeManualClient(record),
    });

    let settled!: Promise<OrchestratorResult>;
    await runImplement("", pi, ctx, runner, (background) => {
      settled = background;
    });
    assert.ok(
      await waitFor(() => getHitlWindow() !== undefined, 3_000),
      "the pause opens",
    );

    // Second /implement while the pause holds the run in flight: refused.
    await runImplement("", pi, ctx, runner, () => {});
    assert.ok(
      ctx.notifyCalls.some(([m]) => /already in flight/.test(m)),
      "re-entry is refused while a pause is in flight",
    );

    runApprove(pi, ctx);
    const result = await settled;
    assert.equal(result.complete, true, "approval lets the run settle");
    assert.equal(getHitlWindow(), undefined, "no window remains after settlement");
  });
});
