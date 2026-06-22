import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import type { ExtensionAPI, ExtensionContext, ToolDefinition } from "@earendil-works/pi-coding-agent";

/**
 * Tests for the adr_validate_mappings tool.
 */

let tmpDir: string;

function mockPi(): ExtensionAPI & { tools: ToolDefinition[] } {
  const tools: ToolDefinition[] = [];
  return {
    on: () => {},
    registerCommand: () => {},
    appendEntry: () => {},
    sendUserMessage: () => {},
    exec: async () => ({ stdout: "", stderr: "", exitCode: 0 }),
    registerTool: (tool: ToolDefinition) => {
      tools.push(tool);
    },
    tools,
  } as unknown as ExtensionAPI & { tools: typeof tools };
}

function mockCtx(): ExtensionContext {
  return {
    cwd: tmpDir,
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

describe("adr_validate_mappings tool", () => {
  before(async () => {
    tmpDir = join(tmpdir(), `val-tool-${randomUUID()}`);
    await mkdir(tmpDir, { recursive: true });
    await mkdir(join(tmpDir, "docs", "ADR"), { recursive: true });
    await mkdir(join(tmpDir, "docs", "specs"), { recursive: true });
    await mkdir(join(tmpDir, "docs", "plans"), { recursive: true });
  });

  after(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  it("registers adr_validate_mappings tool", async () => {
    const pi = mockPi();
    const { registerValidateTool } = await import("../extensions/validate-tool.ts");
    registerValidateTool(pi);

    const tool = pi.tools.find((t) => t.name === "adr_validate_mappings");
    assert.ok(tool, "Tool should be registered");
  });

  it("returns report when called with no documents", async () => {
    const pi = mockPi();
    const { registerValidateTool } = await import("../extensions/validate-tool.ts");
    registerValidateTool(pi);

    const tool = pi.tools.find((t) => t.name === "adr_validate_mappings");
    assert.ok(tool);

    const result = await tool.execute(
      "call-1",
      {},
      new AbortController().signal,
      () => {},
      mockCtx(),
    );

    assert.ok(result, "Should return a result");
    const text = result.content?.[0]?.text ?? "";
    assert.ok(text.includes("Found"), `Should mention Found, got: ${text}`);
  });

  it("reports orphan specs via tool execution", async () => {
    // Create an orphan spec
    const { writeFile } = await import("node:fs/promises");
    await writeFile(
      join(tmpDir, "docs", "specs", "001-orphan.md"),
      "---\ntitle: Orphan\n---\n\n@docs/ADR/099-*.md",
      "utf-8",
    );

    const pi = mockPi();
    const { registerValidateTool } = await import("../extensions/validate-tool.ts");
    registerValidateTool(pi);

    const tool = pi.tools.find((t) => t.name === "adr_validate_mappings");
    assert.ok(tool);

    const result = await tool.execute(
      "call-2",
      {},
      new AbortController().signal,
      () => {},
      mockCtx(),
    );

    assert.ok(result.isError, "Orphans should cause isError=true");
    const text = result.content?.[0]?.text ?? "";
    assert.ok(
      text.includes("orphan") || text.includes("099"),
      `Should report orphan, got: ${text}`,
    );

    // Clean up
    await rm(join(tmpDir, "docs", "specs", "001-orphan.md"));
  });
});
