import { describe, it } from "vitest";
import assert from "node:assert/strict";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { applyDiscussTools, resetToolsState } from "../extensions/tools.ts";

/**
 * Simulated default toolset with a mix of read-only and write-capable tools.
 */
const ACTIVE_TOOLS = [
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

/**
 * Create a mock ExtensionAPI with call-recording spies.
 *
 * @param activeTools - Initial active tool list returned by getActiveTools.
 * @returns Mock with a `.calls.setActiveTools` recording.
 */
function mockPi(
  activeTools: string[] = ACTIVE_TOOLS,
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

/**
 * Build a session context whose branch contains a workflow-state entry.
 *
 * @param phase    - Phase stored in the workflow-state entry.
 * @param specText - Spec text stored alongside the phase.
 * @returns A mock ExtensionContext.
 */
function ctxWithState(phase: string, specText: string): ExtensionContext {
  return {
    cwd: "/tmp/test",
    sessionManager: {
      getBranch: () => [
        {
          type: "custom",
          customType: "workflow-state",
          data: { phase, specText },
        },
      ],
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

/**
 * Load the extension factory and extract the session_start handler.
 *
 * @param pi - Mock ExtensionAPI the factory is bound to.
 * @returns The registered session_start handler.
 */
async function getSessionStartHandler(
  pi: ExtensionAPI & { calls: Record<string, unknown[]> },
): Promise<(event: unknown, ctx: ExtensionContext) => Promise<void>> {
  const factory = (await import("../extensions/index.ts")).default as (
    p: ExtensionAPI,
  ) => void;
  factory(pi);

  const onCalls = pi.calls["on"] ?? [];
  const entry = onCalls.find(
    ([eventName]: [string]) => eventName === "session_start",
  ) as [string, (event: unknown, ctx: ExtensionContext) => Promise<void>] | undefined;

  assert.ok(entry, "session_start handler should be registered");
  return entry[1];
}

// ═══════════════════════════════════════════════════════════════════════════════
// session_start tool handling
// ═══════════════════════════════════════════════════════════════════════════════

describe("session_start tool handling", () => {
  it("re-applies the read-only filter when resuming in the discussing phase", async () => {
    resetToolsState();
    const pi = mockPi();
    const handler = await getSessionStartHandler(pi);

    await handler({}, ctxWithState("discussing", "topic"));

    const setCalls = pi.calls["setActiveTools"] ?? [];
    assert.equal(setCalls.length, 1, "should filter once on discuss resume");

    const [filtered] = setCalls[0] as [string[]];
    assert.ok(!filtered.includes("write"), "write should be removed on resume");
    assert.ok(!filtered.includes("edit"), "edit should be removed on resume");
    assert.ok(!filtered.includes("commit_changes"), "commit tools should be removed on resume");
    assert.ok(filtered.includes("read"), "read should remain on resume");
  });

  it("leaves the default toolset intact when resuming in the implementing phase", async () => {
    resetToolsState();
    const pi = mockPi();
    const handler = await getSessionStartHandler(pi);

    await handler({}, ctxWithState("implementing", "topic"));

    const setCalls = pi.calls["setActiveTools"] ?? [];
    assert.equal(setCalls.length, 0, "fresh session resume must not touch tools");
  });

  it("leaves the default toolset intact on a fresh session (no state)", async () => {
    resetToolsState();
    const pi = mockPi();
    const handler = await getSessionStartHandler(pi);

    await handler(
      {},
      {
        cwd: "/tmp/test",
        sessionManager: { getBranch: () => [] },
        ui: {
          setStatus: () => {},
          setWidget: () => {},
          theme: { fg: () => "" },
          addAutocompleteProvider: () => {},
        },
      } as unknown as ExtensionContext,
    );

    const setCalls = pi.calls["setActiveTools"] ?? [];
    assert.equal(setCalls.length, 0, "fresh session must not re-filter tools");
  });

  it("restores the saved toolset when resuming after a mid-process snapshot", async () => {
    resetToolsState();
    const pi = mockPi();
    const handler = await getSessionStartHandler(pi);

    applyDiscussTools(pi); // simulate a discussion that reloaded the session
    await handler({}, ctxWithState("implementing", "topic"));

    const setCalls = pi.calls["setActiveTools"] ?? [];
    assert.equal(setCalls.length, 2, "filter on discuss, restore on resume");

    const [restored] = setCalls[1] as [string[]];
    assert.deepEqual(restored, ACTIVE_TOOLS, "resume should restore the full set");
  });
});