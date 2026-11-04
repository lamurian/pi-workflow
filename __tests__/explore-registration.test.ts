import { describe, it } from "vitest";
import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
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

// ═══════════════════════════════════════════════════════════════════════════════
// T2 — both /explore entry points thread ctx.model into the scout spawn
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Write an executable fake pi that records the `--model` ref it received
 * (one `MODEL=` line per spawn) and exits 0 without emitting messages.
 *
 * @param file - Path of the record file the fake appends to.
 * @returns Absolute path of the fake pi script.
 */
function fakePiModelRecorder(file: string): string {
  const dir = mkdtempSync(join(tmpdir(), "pi-scout-fake-"));
  const fake = join(dir, "fake-pi.sh");
  writeFileSync(
    fake,
    "#!/bin/sh\n" +
      'prev=""\nmodel="none"\n' +
      'for a in "$@"; do\n' +
      '  if [ "$prev" = "--model" ]; then model="$a"; fi\n' +
      '  prev="$a"\n' +
      "done\n" +
      'printf "MODEL=%s\\n" "$model" >> "$PI_ARGV_FILE"\n' +
      "exit 0\n",
  );
  chmodSync(fake, 0o755);
  return fake;
}

/**
 * Run `fn` with PI_BIN pinned to the argv-recording fake and PI_ARGV_FILE
 * set to `file` (truncated first); restores both env vars afterwards.
 *
 * @param file - Record file the fake appends one MODEL= line per spawn to.
 * @param fn   - Work to run under the pinned env.
 * @returns Whatever `fn` resolves to.
 */
async function withModelRecorder<T>(file: string, fn: () => Promise<T>): Promise<T> {
  const prevBin = process.env.PI_BIN;
  const prevFile = process.env.PI_ARGV_FILE;
  process.env.PI_BIN = fakePiModelRecorder(file);
  process.env.PI_ARGV_FILE = file;
  writeFileSync(file, "");
  try {
    return await fn();
  } finally {
    if (prevBin === undefined) delete process.env.PI_BIN;
    else process.env.PI_BIN = prevBin;
    if (prevFile === undefined) delete process.env.PI_ARGV_FILE;
    else process.env.PI_ARGV_FILE = prevFile;
  }
}

/** Pin the ctx's model registry to an auth failure so no network call runs. */
function failAuth(ctx: ExtensionContext): void {
  ctx.modelRegistry = {
    getApiKeyAndHeaders: async () => ({ ok: false }),
  } as unknown as ExtensionContext["modelRegistry"];
}

describe("T2: /explore entry points pass ctx.model to scout spawns", () => {
  it("the /explore command starts the scout child with --model anthropic/claude-sonnet-4-5", async () => {
    const { registerExploreCommand } = await import("../extensions/explore.ts");
    const pi = mockPi();
    const ctx = mockCtx("/tmp/test");
    failAuth(ctx);

    registerExploreCommand(pi);
    const cmdCalls = pi.calls["registerCommand"] ?? [];
    const exploreCmd = cmdCalls.find(
      ([name]: [string]) => name === "explore",
    ) as [string, { handler: Function }];

    const file = join(mkdtempSync(join(tmpdir(), "pi-model-ref-")), "argv.txt");
    await withModelRecorder(file, async () => {
      await exploreCmd[1].handler("find config", ctx);
    });

    assert.equal(
      readFileSync(file, "utf8").trim(),
      "MODEL=anthropic/claude-sonnet-4-5",
      "the command must spawn the scout with the session model ref",
    );
  });

  it("the explore tool starts the scout child with --model anthropic/claude-sonnet-4-5", async () => {
    const { registerExploreTool } = await import("../extensions/explore.ts");
    const pi = mockPi();
    const ctx = mockCtx("/tmp/test");
    failAuth(ctx);

    registerExploreTool(pi);
    const toolCalls = pi.calls["registerTool"] ?? [];
    const exploreTool = toolCalls.find(
      ([def]: [{ name: string }]) => def.name === "explore",
    ) as [{ execute: Function }];

    const file = join(mkdtempSync(join(tmpdir(), "pi-model-ref-")), "argv.txt");
    await withModelRecorder(file, async () => {
      await exploreTool[0].execute(
        "call-model-ref",
        { instruction: "find auth code" },
        undefined,
        undefined,
        ctx,
      );
    });

    assert.equal(
      readFileSync(file, "utf8").trim(),
      "MODEL=anthropic/claude-sonnet-4-5",
      "the tool must spawn the scout with the session model ref",
    );
  });
});
