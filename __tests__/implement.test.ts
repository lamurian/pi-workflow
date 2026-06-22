import { describe, it, mock } from "node:test";
import assert from "node:assert/strict";
import { startTdd, NO_INPUT_WARNING, resolveImplementSpec } from "../extensions/implement.ts";
import type {
  ExtensionAPI,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";

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
// resolveImplementSpec — bare /implement resolution
// ═══════════════════════════════════════════════════════════════════════════════

describe("resolveImplementSpec", () => {
  it("returns the latest assistant message when one exists", async () => {
    const entries = [
      {
        type: "message",
        id: "entry-1",
        parentId: null,
        message: {
          role: "assistant",
          content: "## Finalized Plan\n\n1. Add retry to HTTP client",
        },
      },
    ];

    const ctx = {
      cwd: "/tmp/test",
      sessionManager: { getBranch: () => entries },
      ui: { notify: () => {} },
    } as unknown as ExtensionContext;

    const spec = await resolveImplementSpec(ctx);
    assert.ok(spec !== null);
    assert.ok(spec!.includes("Finalized Plan"));
    assert.ok(spec!.includes("Add retry"));
  });

  it("falls back to discussion topic when no assistant message exists", async () => {
    // No assistant messages, but a discussing state with specText
    const entries = [
      {
        type: "custom",
        customType: "workflow-state",
        data: {
          phase: "discussing",
          specText: "my discussion topic",
          adrFiles: [],
          specFiles: [],
          planFiles: [],
        },
      },
    ];

    const ctx = {
      cwd: "/tmp/test",
      sessionManager: { getBranch: () => entries },
      ui: { notify: () => {} },
    } as unknown as ExtensionContext;

    const spec = await resolveImplementSpec(ctx);
    assert.equal(spec, "my discussion topic");
  });

  it("prefers assistant message over discussion topic when both exist", async () => {
    // Both an assistant message and a discussion state exist
    const entries = [
      {
        type: "custom",
        customType: "workflow-state",
        data: {
          phase: "discussing",
          specText: "older discussion topic",
          adrFiles: [],
          specFiles: [],
          planFiles: [],
        },
      },
      {
        type: "message",
        id: "entry-1",
        parentId: null,
        message: {
          role: "assistant",
          content: "## Finalized Plan from Assistant",
        },
      },
    ];

    const ctx = {
      cwd: "/tmp/test",
      sessionManager: { getBranch: () => entries },
      ui: { notify: () => {} },
    } as unknown as ExtensionContext;

    const spec = await resolveImplementSpec(ctx);
    assert.ok(spec !== null);
    assert.ok(spec!.includes("Finalized Plan from Assistant"));
  });

  it("returns null when no assistant message, no discussion, no ADR", async () => {
    const ctx = {
      cwd: "/tmp/test",
      sessionManager: { getBranch: () => [] },
      ui: { notify: () => {} },
    } as unknown as ExtensionContext;

    const spec = await resolveImplementSpec(ctx);
    assert.equal(spec, null);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// NO_INPUT_WARNING
// ═══════════════════════════════════════════════════════════════════════════════

describe("NO_INPUT_WARNING", () => {
  it("mentions /discuss as an alternative entry point", () => {
    assert.ok(
      NO_INPUT_WARNING.includes("/discuss"),
      "warning should guide users to /discuss as a lightweight alternative",
    );
  });

  it("mentions /brainstorm as the primary workflow", () => {
    assert.ok(
      NO_INPUT_WARNING.includes("/brainstorm"),
      "warning should mention /brainstorm as the full workflow entry point",
    );
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// startTdd
// ═══════════════════════════════════════════════════════════════════════════════

describe("startTdd", () => {
  it("sends a user message with deliverAs 'steer'", async () => {
    const pi = mockPi();
    const ctx = mockCtx("/tmp/test");

    await startTdd("implement a login button", pi, ctx);

    const sendCalls = pi.calls["sendUserMessage"] ?? [];
    assert.ok(sendCalls.length >= 1, "sendUserMessage should be called");

    const lastCall = sendCalls[sendCalls.length - 1] as [string, { deliverAs: string }];
    const opts = lastCall[1];
    assert.equal(opts.deliverAs, "steer");
  });
});
