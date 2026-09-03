import { describe, it, mock } from "node:test";
import assert from "node:assert/strict";
import {
  startTdd,
  NO_INPUT_WARNING,
  resolveImplementSpec,
  registerCompleteImplementationTool,
} from "../extensions/implement.ts";
import { applyDiscussTools, resetToolsState } from "../extensions/tools.ts";
import type {
  ExtensionAPI,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";

// ── Mock factories ───────────────────────────────────────────────────────────

/**
 * Simulated default toolset with a mix of read-only and write-capable tools.
 */
const DEFAULT_ACTIVE_TOOLS = [
  "read",
  "bash",
  "grep",
  "find",
  "ls",
  "write",
  "edit",
  "create_para_doc",
  "commit_changes",
];

function mockPi(
  activeTools: string[] = DEFAULT_ACTIVE_TOOLS,
): ExtensionAPI & { calls: Record<string, unknown[]> } {
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
    setActiveTools: record("setActiveTools") as ExtensionAPI["setActiveTools"],
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

  it("does not mention /brainstorm (removed workflow)", () => {
    assert.ok(
      !NO_INPUT_WARNING.includes("/brainstorm"),
      "warning should not reference the removed /brainstorm workflow",
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

  it("restores the full toolset when implementation starts", async () => {
    resetToolsState();
    const pi = mockPi();
    const ctx = mockCtx("/tmp/test");

    applyDiscussTools(pi); // simulate a discussion in progress
    await startTdd("implement a login button", pi, ctx);

    const setCalls = pi.calls["setActiveTools"] ?? [];
    assert.equal(setCalls.length, 2, "should filter on discuss, then restore");

    const [filtered] = setCalls[0] as [string[]];
    const [restored] = setCalls[1] as [string[]];
    assert.ok(!filtered.includes("write"), "discussion set should exclude write");
    assert.ok(
      !filtered.includes("commit_changes"),
      "discussion set should exclude commit tools",
    );
    assert.deepEqual(
      restored,
      DEFAULT_ACTIVE_TOOLS,
      "implementing set should be the original full toolset",
    );
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// complete_implementation tool
// ═══════════════════════════════════════════════════════════════════════════════

describe("complete_implementation tool", () => {
  it("restores the full toolset and succeeds in the implementing phase", async () => {
    resetToolsState();
    const pi = mockPi();
    const ctx = {
      cwd: "/tmp/test",
      sessionManager: {
        getBranch: () => [
          {
            type: "custom",
            customType: "workflow-state",
            data: { phase: "implementing", specText: "x" },
          },
        ],
      },
      ui: {
        notify: () => {},
        setStatus: () => {},
        setWidget: () => {},
        theme: { fg: () => "" },
      },
    } as unknown as ExtensionContext;

    registerCompleteImplementationTool(pi);
    applyDiscussTools(pi);

    const toolCalls = pi.calls["registerTool"] ?? [];
    const completeTool = toolCalls.find(
      ([def]: [{ name: string }]) => def.name === "complete_implementation",
    ) as [{ name: string; execute: Function }] | undefined;
    assert.ok(completeTool, "complete_implementation should be registered");

    const result = await completeTool[0].execute(
      "call-1",
      {},
      undefined,
      undefined,
      ctx,
    );

    assert.equal(
      result.isError,
      undefined,
      "tool should succeed (no isError) in implementing phase",
    );
    const successText = result.content?.[0]?.text ?? "";
    assert.match(successText, /Implementation Complete/);

    const setCalls = pi.calls["setActiveTools"] ?? [];
    assert.equal(setCalls.length, 2, "filter on discuss, restore on completion");
    const [restored] = setCalls[1] as [string[]];
    assert.deepEqual(restored, DEFAULT_ACTIVE_TOOLS);
  });

  it("does not restore tools when called outside the implementing phase", async () => {
    resetToolsState();
    const pi = mockPi();
    const ctx = mockCtx("/tmp/test"); // empty session: no workflow state

    registerCompleteImplementationTool(pi);
    applyDiscussTools(pi);

    const toolCalls = pi.calls["registerTool"] ?? [];
    const completeTool = toolCalls.find(
      ([def]: [{ name: string }]) => def.name === "complete_implementation",
    ) as [{ execute: Function }];

    const result = await completeTool[0].execute(
      "call-2",
      {},
      undefined,
      undefined,
      ctx,
    );

    assert.equal(result.isError, true, "should error when not in implementing phase");
    const setCalls = pi.calls["setActiveTools"] ?? [];
    assert.equal(setCalls.length, 1, "no restore outside implementing phase");
  });
});
