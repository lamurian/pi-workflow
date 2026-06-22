import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdir, rm, readdir } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import type { ExtensionAPI, ExtensionContext, ToolDefinition } from "@earendil-works/pi-coding-agent";

/**
 * Tests for the batch ADR and spec creation tools.
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

describe("batch_create_adrs tool", () => {
  before(async () => {
    tmpDir = join(tmpdir(), `batch-adr-${randomUUID()}`);
    await mkdir(tmpDir, { recursive: true });
  });

  after(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  it("registers batch_create_adrs tool", async () => {
    const pi = mockPi();
    const { registerBatchTools } = await import("../extensions/batch-tools.ts");
    registerBatchTools(pi);

    const tool = pi.tools.find((t) => t.name === "batch_create_adrs");
    assert.ok(tool, "batch_create_adrs should be registered");
  });

  it("creates multiple ADRs from a single call", async () => {
    const pi = mockPi();
    const { registerBatchTools } = await import("../extensions/batch-tools.ts");
    registerBatchTools(pi);

    const tool = pi.tools.find((t) => t.name === "batch_create_adrs");
    assert.ok(tool);

    const result = await tool.execute(
      "call-1",
      {
        adrs: [
          {
            title: "First ADR",
            description: "First decision",
            context: "Need to decide X",
            decision: "Choose X",
            impact: "Low risk",
            summary: "First decision summary",
          },
          {
            title: "Second ADR",
            description: "Second decision",
            context: "Need to decide Y",
            decision: "Choose Y",
            impact: "Medium risk",
            summary: "Second decision summary",
          },
        ],
      },
      new AbortController().signal,
      () => {},
      mockCtx(),
    );

    assert.ok(result, "Should return a result");
    assert.ok(!result.isError, `Batch ADR creation should succeed, got: ${result.content?.[0]?.text}`);

    const text = result.content?.[0]?.text ?? "";
    assert.ok(text.includes("2 ADR"), `Should mention 2 ADRs, got: ${text}`);

    // Verify files exist
    const adrDir = join(tmpDir, "docs", "ADR");
    const files = await readdir(adrDir);
    const mdFiles = files.filter((f) => f.endsWith(".md"));
    assert.ok(mdFiles.length >= 2, `Should have at least 2 ADR files, got ${mdFiles.length}`);
  });

  it("returns error for empty ADRs array", async () => {
    const pi = mockPi();
    const { registerBatchTools } = await import("../extensions/batch-tools.ts");
    registerBatchTools(pi);

    const tool = pi.tools.find((t) => t.name === "batch_create_adrs");
    assert.ok(tool);

    const result = await tool.execute(
      "call-2",
      { adrs: [] },
      new AbortController().signal,
      () => {},
      mockCtx(),
    );

    assert.ok(result.isError, "Empty array should return an error");
  });
});

describe("batch_create_specs tool", () => {
  before(async () => {
    tmpDir = join(tmpdir(), `batch-spec-${randomUUID()}`);
    await mkdir(tmpDir, { recursive: true });

    // Pre-create an ADR
    const { createAdr } = await import("../extensions/adr.ts");
    await createAdr(
      { title: "Batch ADR", description: "For batch specs", status: "proposed", context: "C", decision: "D", impact: "I" },
      tmpDir,
    );
    await mkdir(join(tmpDir, "docs", "specs"), { recursive: true });
  });

  after(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  it("registers batch_create_specs tool", async () => {
    const pi = mockPi();
    const { registerBatchTools } = await import("../extensions/batch-tools.ts");
    registerBatchTools(pi);

    const tool = pi.tools.find((t) => t.name === "batch_create_specs");
    assert.ok(tool, "batch_create_specs should be registered");
  });

  it("creates multiple specs for the same ADR from a single call", async () => {
    const pi = mockPi();
    const { registerBatchTools } = await import("../extensions/batch-tools.ts");
    registerBatchTools(pi);

    const tool = pi.tools.find((t) => t.name === "batch_create_specs");
    assert.ok(tool);

    const result = await tool.execute(
      "call-b-1",
      {
        adrNumber: 1,
        specs: [
          {
            title: "Spec One",
            content: "# Requirements Specification\n\n- Req A\n\n# Design Principles\n\n- Design A\n\n# References\n\n",
          },
          {
            title: "Spec Two",
            content: "# Requirements Specification\n\n- Req B\n\n# Design Principles\n\n- Design B\n\n# References\n\n",
          },
        ],
      },
      new AbortController().signal,
      () => {},
      mockCtx(),
    );

    assert.ok(result, "Should return a result");
    assert.ok(!result.isError, `Batch spec creation should succeed, got: ${result.content?.[0]?.text}`);

    const text = result.content?.[0]?.text ?? "";
    assert.ok(text.includes("2 spec"), `Should mention 2 specs, got: ${text}`);

    // Verify files exist
    const specsDir = join(tmpDir, "docs", "specs");
    const files = await readdir(specsDir);
    const mdFiles = files.filter((f) => f.endsWith(".md"));
    assert.ok(mdFiles.length >= 2, `Should have at least 2 spec files, got ${mdFiles.length}`);
  });

  it("auto-updates ADR remaining count after batch creation", async () => {
    // ADR 001 already exists from before hook with remaining=0
    // After batch creating 2 specs, ADR should have remaining=2
    const pi = mockPi();
    const { registerBatchTools } = await import("../extensions/batch-tools.ts");
    registerBatchTools(pi);

    const tool = pi.tools.find((t) => t.name === "batch_create_specs");
    assert.ok(tool);

    const result = await tool.execute(
      "call-b-2",
      {
        adrNumber: 1,
        specs: [
          {
            title: "Spec Three",
            content: "# Requirements Specification\n\n- Req C\n\n# Design Principles\n\n- Design C\n\n# References\n\n",
          },
        ],
      },
      new AbortController().signal,
      () => {},
      mockCtx(),
    );

    assert.ok(result, "Should return a result");
    assert.ok(!result.isError, "Batch spec creation should succeed");

    const text = result.content?.[0]?.text ?? "";
    assert.ok(
      text.includes("remaining"),
      `Should mention remaining count, got: ${text}`,
    );
  });

  it("returns error for empty specs array", async () => {
    const pi = mockPi();
    const { registerBatchTools } = await import("../extensions/batch-tools.ts");
    registerBatchTools(pi);

    const tool = pi.tools.find((t) => t.name === "batch_create_specs");
    assert.ok(tool);

    const result = await tool.execute(
      "call-b-3",
      { adrNumber: 1, specs: [] },
      new AbortController().signal,
      () => {},
      mockCtx(),
    );

    assert.ok(result.isError, "Empty array should return an error");
  });
});
