import { describe, it } from "node:test";
import assert from "node:assert/strict";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

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
    registerTool: record("registerTool") as ExtensionAPI["registerTool"],
    appendEntry: record("appendEntry") as ExtensionAPI["appendEntry"],
    sendUserMessage: record("sendUserMessage") as ExtensionAPI["sendUserMessage"],
    exec: async () => ({ stdout: "", stderr: "", exitCode: 0 }),
    calls,
  } as unknown as ExtensionAPI & { calls: typeof calls };
}

function mockCtx(
  cwd: string,
  overrides: Partial<ExtensionContext> = {},
): ExtensionContext {
  return {
    cwd,
    sessionManager: {
      getBranch: () => [],
      getSessionFile: () => null,
    },
    ui: {
      notify: () => {},
      setStatus: () => {},
      setWidget: () => {},
      theme: { fg: () => "" },
      addAutocompleteProvider: () => {},
      confirm: async () => true,
      select: async () => null,
      input: async () => "",
      custom: async () => null,
      editor: async () => "",
      setEditorText: () => {},
      setTitle: () => {},
    },
    mode: "tui",
    hasUI: true,
    model: { provider: "anthropic", id: "claude-sonnet-4-5" },
    modelRegistry: {
      getApiKeyAndHeaders: async () => ({
        ok: true,
        apiKey: "test-key",
        headers: {},
      }),
    },
    signal: undefined as AbortSignal | undefined,
    ...overrides,
  } as unknown as ExtensionContext;
}

// ═══════════════════════════════════════════════════════════════════════════════
// registerExploreCommand — /explore slash command
// ═══════════════════════════════════════════════════════════════════════════════

describe("registerExploreCommand", () => {
  it("registers a command named 'explore'", async () => {
    const { registerExploreCommand } = await import("../extensions/explore.ts");
    const pi = mockPi();

    registerExploreCommand(pi);

    const cmdCalls = pi.calls["registerCommand"] ?? [];
    const exploreCmd = cmdCalls.find(
      ([name]: [string]) => name === "explore",
    ) as [string, { description: string; handler: Function }] | undefined;

    assert.ok(exploreCmd, "should register 'explore' command");
    const [_, definition] = exploreCmd;
    assert.ok(definition.description, "command should have a description");
    assert.match(definition.description, /explore/i);
    assert.equal(typeof definition.handler, "function");
  });

  it("command logs warning when called with empty args", async () => {
    const { registerExploreCommand } = await import("../extensions/explore.ts");
    const pi = mockPi();
    const ctx = mockCtx("/tmp/test");
    let notifiedText = "";
    ctx.ui.notify = (text: string) => {
      notifiedText = text;
    };

    registerExploreCommand(pi);
    const cmdCalls = pi.calls["registerCommand"] ?? [];
    const exploreCmd = cmdCalls.find(
      ([name]: [string]) => name === "explore",
    ) as [string, { handler: Function }];

    await exploreCmd[1].handler("", ctx);
    assert.match(notifiedText, /Usage/);

    await exploreCmd[1].handler("   ", ctx);
    assert.match(notifiedText, /Usage/);
  });

  it("command sets persistent status via ctx.ui.setStatus during phases", async () => {
    const { registerExploreCommand } = await import("../extensions/explore.ts");
    const pi = mockPi();
    const ctx = mockCtx("/tmp/test", {
      model: null as unknown as ExtensionContext["model"],
    });

    const statusCalls: Array<[string, string | undefined]> = [];
    ctx.ui.setStatus = (key: string, text: string | undefined) => {
      if (key === "explore") statusCalls.push([key, text]);
    };

    registerExploreCommand(pi);
    const cmdCalls = pi.calls["registerCommand"] ?? [];
    const exploreCmd = cmdCalls.find(
      ([name]: [string]) => name === "explore",
    ) as [string, { handler: Function }];

    await exploreCmd[1].handler("find config", ctx);

    assert.ok(statusCalls.length >= 2,
      `should set explore status at least 2 times, got ${statusCalls.length}`);

    // First status should be set during decompose/execution phase
    const [firstKey, firstText] = statusCalls[0];
    assert.equal(firstKey, "explore");
    assert.ok(firstText, "first status should have text");

    // Last status should be undefined (cleared when done)
    const [lastKey, lastText] = statusCalls[statusCalls.length - 1];
    assert.equal(lastKey, "explore");
    assert.equal(lastText, undefined, "last status should be cleared (undefined)");
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// registerExploreTool — explore tool for LLM use
// ═══════════════════════════════════════════════════════════════════════════════

describe("registerExploreTool", () => {
  it("registers a tool named 'explore'", async () => {
    const { registerExploreTool } = await import("../extensions/explore.ts");
    const pi = mockPi();

    registerExploreTool(pi);

    const toolCalls = pi.calls["registerTool"] ?? [];
    const exploreTool = toolCalls.find(
      ([def]: [{ name: string }]) => def.name === "explore",
    ) as [{ name: string; description: string; parameters: any; execute: Function }] | undefined;

    assert.ok(exploreTool, "should register 'explore' tool");
    const [def] = exploreTool;
    assert.ok(def.description, "tool should have a description");
    assert.ok(def.parameters, "tool should have parameters");
    assert.equal(typeof def.execute, "function");
  });

  it("tool has required 'instruction' parameter of type string", async () => {
    const { registerExploreTool } = await import("../extensions/explore.ts");
    const pi = mockPi();

    registerExploreTool(pi);

    const toolCalls = pi.calls["registerTool"] ?? [];
    const exploreTool = toolCalls.find(
      ([def]: [{ name: string }]) => def.name === "explore",
    ) as [{ parameters: any }];

    assert.ok(exploreTool);
    const [def] = exploreTool;
    const params = def.parameters;
    assert.ok(params.properties?.instruction, "should have 'instruction' property");
    assert.equal(params.properties.instruction.type, "string");
  });

  it("tool execute returns error for empty instruction", async () => {
    const { registerExploreTool } = await import("../extensions/explore.ts");
    const pi = mockPi();
    const ctx = mockCtx("/tmp/test");

    registerExploreTool(pi);
    const toolCalls = pi.calls["registerTool"] ?? [];
    const exploreTool = toolCalls.find(
      ([def]: [{ name: string }]) => def.name === "explore",
    ) as [{ execute: Function }];

    const result = await exploreTool[0].execute(
      "call-1",
      { instruction: "" },
      undefined,
      undefined,
      ctx,
    );

    assert.ok(result.isError, "should return error for empty instruction");
    assert.match(result.content[0].text, /no instruction/i);
  });

  it("tool execute returns fallback when model is unavailable", async () => {
    const { registerExploreTool } = await import("../extensions/explore.ts");
    const pi = mockPi();
    const ctx = mockCtx("/tmp/test", {
      model: null as unknown as ExtensionContext["model"],
    });

    registerExploreTool(pi);
    const toolCalls = pi.calls["registerTool"] ?? [];
    const exploreTool = toolCalls.find(
      ([def]: [{ name: string }]) => def.name === "explore",
    ) as [{ execute: Function }];

    const result = await exploreTool[0].execute(
      "call-2",
      { instruction: "find auth code" },
      undefined,
      undefined,
      ctx,
    );

    assert.ok(result.content, "should return content");
    assert.ok(result.content[0].text.length > 0, "should return non-empty text");
  });

  it("tool calls onUpdate with progress text during execution", async () => {
    const { registerExploreTool } = await import("../extensions/explore.ts");
    const pi = mockPi();
    const ctx = mockCtx("/tmp/test", {
      model: null as unknown as ExtensionContext["model"],
    });

    registerExploreTool(pi);
    const toolCalls = pi.calls["registerTool"] ?? [];
    const exploreTool = toolCalls.find(
      ([def]: [{ name: string }]) => def.name === "explore",
    ) as [{ execute: Function }];

    const updates: string[] = [];
    const onUpdate = (partial: { content: Array<{ type: string; text?: string }> }) => {
      for (const c of partial.content) {
        if (c.type === "text" && c.text) updates.push(c.text);
      }
    };

    await exploreTool[0].execute(
      "call-3",
      { instruction: "search src/" },
      AbortSignal.abort(),
      onUpdate,
      ctx,
    );

    assert.ok(updates.length >= 2,
      `should send at least 2 progress updates, got ${updates.length}`);

    // First update should reference the decompose/exploration phase
    assert.match(updates[0], /search|task|explor/i,
      "first update should report task decomposition");

    // Last update should reference synthesis or completion
    const lastText = updates[updates.length - 1];
    assert.match(lastText, /synthesis|synthesiz|complet|result/i,
      "last update should report synthesis");
  });

  it("tool progress updates use Dingbat glyph ✦ (U+2726) instead of 🔍 emoji", async () => {
    const { registerExploreTool } = await import("../extensions/explore.ts");
    const pi = mockPi();
    const ctx = mockCtx("/tmp/test", {
      model: null as unknown as ExtensionContext["model"],
    });

    registerExploreTool(pi);
    const toolCalls = pi.calls["registerTool"] ?? [];
    const exploreTool = toolCalls.find(
      ([def]: [{ name: string }]) => def.name === "explore",
    ) as [{ execute: Function }];

    const updates: string[] = [];
    const onUpdate = (partial: { content: Array<{ type: string; text?: string }> }) => {
      for (const c of partial.content) {
        if (c.type === "text" && c.text) updates.push(c.text);
      }
    };

    await exploreTool[0].execute(
      "call-emoji-test",
      { instruction: "search src/" },
      AbortSignal.abort(),
      onUpdate,
      ctx,
    );

    assert.ok(updates.length >= 2,
      `should send at least 2 progress updates, got ${updates.length}`);

    // All progress updates must use ✦ Dingbat instead of 🔍 emoji
    assert.ok(!updates.some(u => u.includes("🔍")),
      "progress updates should not contain 🔍 emoji");
    assert.ok(updates.some(u => u.includes("✦")),
      "progress updates should use ✦ (U+2726) Dingbat glyph");
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// Integration: index.ts exports default factory
// ═══════════════════════════════════════════════════════════════════════════════

describe("index.ts module exports", () => {
  it("exports a default factory function", async () => {
    const index = await import("../extensions/index.ts");
    assert.equal(typeof index.default, "function");
  });

  it("index.ts can be loaded without errors", async () => {
    let loaded = false;
    try {
      await import("../extensions/index.ts");
      loaded = true;
    } catch {
      // Should not throw during parsing
    }
    assert.ok(loaded, "index.ts should load without errors");
  });
});
