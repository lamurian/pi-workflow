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

function ctxFor(phase: string): ExtensionContext {
  return {
    cwd: "/tmp/test",
    sessionManager: {
      getBranch: () => [{ type: "custom", customType: "workflow-state", data: { phase, specText: "t" } }],
    },
    ui: { notify: () => {}, setStatus: () => {}, setWidget: () => {}, setTitle: () => {}, theme: { fg: (_: string, t: string) => t } },
  } as unknown as ExtensionContext;
}

async function getToolCallHandler(pi: ExtensionAPI & { calls: Record<string, unknown[]> }) {
  const factory = (await import("../extensions/index.ts")).default;
  factory(pi);
  const onCalls = pi.calls["on"] ?? [];
  return onCalls.find(([e]: [string]) => e === "tool_call")![1] as (
    event: unknown,
    ctx: ExtensionContext,
  ) => Promise<{ block?: boolean; reason?: string } | undefined>;
}

describe("index.ts workflow wiring", () => {
  it("registers the three phase commands and the workflow tools (T8/T10)", async () => {
    const pi = mockPi();
    const factory = (await import("../extensions/index.ts")).default;
    factory(pi);

    const commands = (pi.calls["registerCommand"] ?? []).map(([n]: [string]) => n);
    for (const c of ["discuss", "finalize", "implement"]) {
      assert.ok(commands.includes(c), `command /${c} should be registered`);
    }
    assert.ok(!commands.includes("yolo"), "/yolo must not be registered");

    const tools = (pi.calls["registerTool"] ?? []).map(([d]: [{ name: string }]) => d.name);
    for (const t of ["save_task", "mark_task_done", "complete_implementation"]) {
      assert.ok(tools.includes(t), `tool ${t} should be registered`);
    }
    assert.ok(!tools.includes("run_tests"), "run_tests must NOT be registered (deleted)");
    assert.ok(!tools.includes("back_to_finalize"), "back_to_finalize must not be registered");
  });

  it("command descriptions accept an optional note (T5)", async () => {
    const pi = mockPi();
    const factory = (await import("../extensions/index.ts")).default;
    factory(pi);

    const defs = Object.fromEntries(
      (pi.calls["registerCommand"] ?? []).map(([n, d]: [string, { description: string }]) => [n, d.description]),
    );
    assert.match(defs["finalize"], /\[note\]/);
    assert.match(defs["implement"], /\[note\]/);
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

  it("blocks write/edit with phase-aware reasons in gated phases, allows elsewhere (T1/T3)", async () => {
    const pi = mockPi();
    const toolCall = await getToolCallHandler(pi);

    const writeEvent = { toolName: "write", input: {} };

    const discussingBlock = await toolCall(writeEvent, ctxFor("discussing"));
    assert.equal(discussingBlock?.block, true, "write must be blocked in discussing");
    assert.match(discussingBlock!.reason!, /discussing/);
    assert.match(discussingBlock!.reason!, /Wait for the user to run \/finalize/);

    const finalizingBlock = await toolCall(writeEvent, ctxFor("finalizing"));
    assert.equal(finalizingBlock?.block, true, "write must be blocked in finalizing");
    assert.match(finalizingBlock!.reason!, /finalizing/);
    assert.match(finalizingBlock!.reason!, /Wait for the user to run \/implement/);

    assert.equal(await toolCall(writeEvent, ctxFor("implementing")), undefined, "write allowed in implementing");
    assert.equal(await toolCall(writeEvent, ctxFor("idle")), undefined, "write allowed in idle");
  });

  it("blocks commit tools and PARA mutators in gated phases", async () => {
    const pi = mockPi();
    const toolCall = await getToolCallHandler(pi);

    for (const toolName of ["commit_changes", "create_para_doc"]) {
      const block = await toolCall({ toolName, input: {} }, ctxFor("finalizing"));
      assert.equal(block?.block, true, `${toolName} must be blocked in finalizing`);
    }
  });

  it("never removes tools from the active set (T1)", async () => {
    const pi = mockPi();
    const toolCall = await getToolCallHandler(pi);

    await toolCall({ toolName: "write", input: {} }, ctxFor("finalizing"));
    await toolCall({ toolName: "write", input: {} }, ctxFor("discussing"));

    const setCalls = pi.calls["setActiveTools"] ?? [];
    assert.equal(setCalls.length, 0, "setActiveTools must never be called");
  });
});
