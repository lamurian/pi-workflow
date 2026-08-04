import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { runYolo } from "../extensions/yolo.ts";
import type {
  ExtensionAPI,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import type { WorkflowState } from "../extensions/state.ts";

// ── Mock factories ───────────────────────────────────────────────────────────

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
    appendEntry: record("appendEntry") as ExtensionAPI["appendEntry"],
    sendUserMessage: record("sendUserMessage") as ExtensionAPI["sendUserMessage"],
    exec: async () => ({ stdout: "", stderr: "", exitCode: 0 }),
    calls,
  } as unknown as ExtensionAPI & { calls: typeof calls };
}

function mockCtx(cwd: string): ExtensionContext {
  return {
    cwd,
    sessionManager: {
      getBranch: () => [],
    },
    ui: {
      notify: () => {},
      setStatus: () => {},
      setWidget: () => {},
      theme: { fg: () => "" },
      addAutocompleteProvider: () => {},
    },
  } as unknown as ExtensionContext;
}

// ═══════════════════════════════════════════════════════════════════════════════
// runYolo
// ═══════════════════════════════════════════════════════════════════════════════

describe("runYolo", () => {
  it("saves state with phase 'idle' and all fields cleared", async () => {
    const pi = mockPi();
    const ctx = mockCtx("/tmp/test");

    await runYolo(pi, ctx);

    const appendCalls = pi.calls["appendEntry"] ?? [];
    assert.ok(appendCalls.length >= 1, "appendEntry should be called");

    const [, saved] = appendCalls[appendCalls.length - 1] as [
      string,
      WorkflowState,
    ];
    assert.equal(saved.phase, "idle");
    assert.equal(saved.specText, "");
  });

  it("sends a steer message to the agent to reset context", async () => {
    const pi = mockPi();
    const ctx = mockCtx("/tmp/test");

    await runYolo(pi, ctx);

    const sendCalls = pi.calls["sendUserMessage"] ?? [];
    assert.equal(sendCalls.length, 1, "sendUserMessage should be called once");

    const [text, opts] = sendCalls[0] as [string, { deliverAs: string }];
    assert.match(text, /yolo/i);
    assert.deepEqual(opts, { deliverAs: "steer" });
  });

  it("notifies the user that workflow is reset", async () => {
    const pi = mockPi();
    const ctx = mockCtx("/tmp/test");

    const notifyCalls: Array<{ msg: string; level: string }> = [];
    ctx.ui.notify = (msg: string, level: string) => {
      notifyCalls.push({ msg, level });
    };

    await runYolo(pi, ctx);

    assert.ok(notifyCalls.length >= 1, "notify should be called");
    const lastNotify = notifyCalls[notifyCalls.length - 1];
    assert.match(lastNotify.msg, /reset|default session/i);
  });

  it("clears workflow UI status via updateUi", async () => {
    const pi = mockPi();
    const ctx = mockCtx("/tmp/test");

    const setStatusCalls: Array<{ key: string; value: unknown }> = [];
    ctx.ui.setStatus = (key: string, value: unknown) => {
      setStatusCalls.push({ key, value });
    };

    await runYolo(pi, ctx);

    assert.ok(
      setStatusCalls.some(
        (c) =>
          c.key === "workflow" && c.value === undefined,
      ),
      "should clear workflow status to undefined",
    );
  });
});
