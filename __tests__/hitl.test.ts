import { describe, it } from "vitest";
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
  getHitlWindow,
  type UnitRunner,
} from "../extensions/implement-loop.ts";
import {
  setActiveUnitClient,
} from "../extensions/implementer-runner.ts";
import { registerImplementerActivityRenderer } from "../extensions/implement.ts";
import type { RpcUnitClient, RpcImage } from "../extensions/rpc-unit-client.ts";
import type { WorkflowState, TaskContract } from "../extensions/state.ts";

// ═══════════════════════════════════════════════════════════════════════════════
// Shared harness for the HITL behaviors (T2–T6)
// ═══════════════════════════════════════════════════════════════════════════════

/** Recorded ExtensionAPI mock with ui spies attached by the caller. */
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
    registerEntryRenderer: record("registerEntryRenderer") as ExtensionAPI["registerEntryRenderer"],
    appendEntry: record("appendEntry") as ExtensionAPI["appendEntry"],
    sendUserMessage: record("sendUserMessage") as ExtensionAPI["sendUserMessage"],
    getActiveTools: () => ["read", "bash"],
    getAllTools: () => [{ name: "read" }, { name: "bash" }],
    setActiveTools: record("setActiveTools") as ExtensionAPI["setActiveTools"],
    exec: async () => ({ stdout: "", stderr: "", code: 0, killed: false }),
    calls,
  } as unknown as ExtensionAPI & { calls: Record<string, unknown[]> };
}

/** Context with recorded notify/setStatus so tests can assert UI traffic. */
function ctxWithUiSpies(): ExtensionContext & {
  statusCalls: Array<[string, string | undefined]>;
  notifyCalls: Array<[string, string | undefined]>;
} {
  const statusCalls: Array<[string, string | undefined]> = [];
  const notifyCalls: Array<[string, string | undefined]> = [];
  return {
    cwd: "/tmp/test",
    sessionManager: { getBranch: () => [] },
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

/** Fake kept-alive client for manual behaviors, with a shutdown counter. */
function fakeManualClient(record: { shutdowns: number }): RpcUnitClient {
  return {
    isAlive: () => true,
    shutdown: async () => {
      record.shutdowns++;
    },
    kill: () => {},
    send: () => {},
    command: async () => ({ type: "response", success: true, id: "x" }),
    prompt: () => {},
    steer: (_message: string, _images?: RpcImage[]) => {},
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
