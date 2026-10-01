import { describe, it } from "vitest";
import assert from "node:assert/strict";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

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
    getActiveTools: () => ["read", "write"],
    setActiveTools: record("setActiveTools") as ExtensionAPI["setActiveTools"],
    calls,
  } as unknown as ExtensionAPI & { calls: Record<string, unknown[]> };
}

describe("index.ts workflow wiring", () => {
  it("registers the three phase commands and five workflow tools", async () => {
    const pi = mockPi();
    const factory = (await import("../extensions/index.ts")).default;
    factory(pi);

    const commands = (pi.calls["registerCommand"] ?? []).map(([n]: [string]) => n);
    for (const c of ["discuss", "finalize", "implement"]) {
      assert.ok(commands.includes(c), `command /${c} should be registered`);
    }
    assert.ok(!commands.includes("yolo"), "/yolo must not be registered");

    const tools = (pi.calls["registerTool"] ?? []).map(([d]: [{ name: string }]) => d.name);
    for (const t of [
      "save_task",
      "run_tests",
      "mark_task_done",
      "back_to_finalize",
      "complete_implementation",
    ]) {
      assert.ok(tools.includes(t), `tool ${t} should be registered`);
    }
  });

  it("subscribes to session lifecycle and phase events", async () => {
    const pi = mockPi();
    const factory = (await import("../extensions/index.ts")).default;
    factory(pi);

    const events = (pi.calls["on"] ?? []).map(([e]: [string]) => e);
    for (const e of [
      "resources_discover",
      "session_start",
      "session_before_compact",
      "session_compact",
      "before_agent_start",
      "tool_call",
    ]) {
      assert.ok(events.includes(e), `event ${e} should be subscribed`);
    }
  });

  it("blocks write/edit in the finalized phase but allows it when implementing", async () => {
    const pi = mockPi();
    const factory = (await import("../extensions/index.ts")).default;
    factory(pi);

    const onCalls = pi.calls["on"] ?? [];
    const toolCall = onCalls.find(([e]: [string]) => e === "tool_call")![1] as (
      event: unknown,
      ctx: ExtensionContext,
    ) => Promise<{ block?: boolean } | undefined>;

    const ctxFor = (phase: string): ExtensionContext =>
      ({
        cwd: "/tmp/test",
        sessionManager: {
          getBranch: () => [{ type: "custom", customType: "workflow-state", data: { phase, specText: "t" } }],
        },
        ui: { notify: () => {}, setStatus: () => {}, setWidget: () => {}, theme: { fg: (_: string, t: string) => t } },
      }) as unknown as ExtensionContext;

    const writeEvent = { toolName: "write", input: {} };
    // Stub the type guard path by relying on toolName matching in the handler.
    const finalizedBlock = await toolCall(writeEvent, ctxFor("finalized"));
    assert.equal(finalizedBlock?.block, true, "write must be blocked in finalized");

    const implementingBlock = await toolCall(writeEvent, ctxFor("implementing"));
    assert.equal(implementingBlock, undefined, "write must be allowed in implementing");
  });
});
