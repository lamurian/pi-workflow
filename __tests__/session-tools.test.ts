import { describe, it } from "vitest";
import assert from "node:assert/strict";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

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
 * @returns Mock with `.calls.setActiveTools` etc. recording.
 */
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
    getActiveTools: () => [...ACTIVE_TOOLS],
    setActiveTools: record("setActiveTools") as ExtensionAPI["setActiveTools"],
    exec: async () => ({ stdout: "", stderr: "", code: 0, killed: false }),
    calls,
  } as unknown as ExtensionAPI & { calls: typeof calls };
}

/**
 * Build a session context whose branch contains a workflow-state entry.
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
      setTitle: () => {},
      theme: { fg: (_c: string, t: string) => t },
      addAutocompleteProvider: () => {},
    },
  } as unknown as ExtensionContext;
}

/**
 * Load the extension factory and extract the session_start handler.
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
// session_start tool handling (T1: no tool removal in any phase)
// ═══════════════════════════════════════════════════════════════════════════════

describe("session_start tool handling", () => {
  it("never touches the active toolset in any phase", async () => {
    for (const phase of ["discussing", "finalizing", "implementing", "idle"]) {
      const pi = mockPi();
      const handler = await getSessionStartHandler(pi);

      await handler({}, ctxWithState(phase, "topic"));

      const setCalls = pi.calls["setActiveTools"] ?? [];
      assert.equal(
        setCalls.length,
        0,
        `setActiveTools must not be called in ${phase}`,
      );
    }
  });

  it("restores the workflow UI when resuming in a gated phase", async () => {
    const pi = mockPi();
    const handler = await getSessionStartHandler(pi);

    const setStatusCalls: Array<{ key: string; value: unknown }> = [];
    const ctx = ctxWithState("finalizing", "topic");
    ctx.ui.setStatus = (key: string, value: unknown) => {
      setStatusCalls.push({ key, value });
    };

    await handler({}, ctx);

    assert.ok(
      setStatusCalls.some((c) => c.key === "workflow"),
      "workflow status should be set on resume",
    );
  });

  it("clears the workflow UI on a fresh session (no state)", async () => {
    const pi = mockPi();
    const handler = await getSessionStartHandler(pi);

    const setStatusCalls: Array<{ key: string; value: unknown }> = [];
    const ctx = {
      cwd: "/tmp/test",
      sessionManager: { getBranch: () => [] },
      ui: {
        notify: () => {},
        setStatus: (key: string, value: unknown) => {
          setStatusCalls.push({ key, value });
        },
        setWidget: () => {},
        setTitle: () => {},
        theme: { fg: (_c: string, t: string) => t },
        addAutocompleteProvider: () => {},
      },
    } as unknown as ExtensionContext;

    await handler({}, ctx);

    const setCalls = pi.calls["setActiveTools"] ?? [];
    assert.equal(setCalls.length, 0, "fresh session must not touch tools");
    assert.ok(
      setStatusCalls.some((c) => c.key === "workflow" && c.value === undefined),
      "workflow status should be cleared on fresh session",
    );
  });
});
