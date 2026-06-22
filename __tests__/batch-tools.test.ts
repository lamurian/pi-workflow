import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdir, rm, readdir, readFile } from "node:fs/promises";
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

  it("tracks batch-created ADRs in ARCHITECTURE.md", async () => {
    const pi = mockPi();
    const { registerBatchTools } = await import("../extensions/batch-tools.ts");
    registerBatchTools(pi);

    const tool = pi.tools.find((t) => t.name === "batch_create_adrs");
    assert.ok(tool);

    const ctx = mockCtx();
    const result = await tool.execute(
      "call-arch-1",
      {
        adrs: [
          {
            title: "Arch Tracked",
            description: "Should appear in ARCHITECTURE.md",
            context: "Test context",
            decision: "Test decision",
            impact: "Test impact",
            summary: "Test summary entry",
          },
        ],
      },
      new AbortController().signal,
      () => {},
      ctx,
    );

    assert.ok(result, "Should return a result");
    assert.ok(!result.isError, `Batch ADR creation should succeed, got: ${result.content?.[0]?.text}`);

    // Verify ARCHITECTURE.md exists and contains the ADR entry
    const archPath = join(tmpDir, "ARCHITECTURE.md");
    const archContent = await readFile(archPath, "utf-8");
    // Entry format: "- [D] @docs/ADR/NNN-arch-tracked.md Test summary entry"
    assert.ok(
      archContent.includes("arch-tracked"),
      "ARCHITECTURE.md should contain the slug from ADR filename",
    );
    assert.ok(
      archContent.includes("Test summary entry"),
      "ARCHITECTURE.md should contain the ADR summary",
    );
  });

  it("creates batch ADRs without requiring remaining field", async () => {
    const pi = mockPi();
    const { registerBatchTools } = await import("../extensions/batch-tools.ts");
    registerBatchTools(pi);

    const tool = pi.tools.find((t) => t.name === "batch_create_adrs");
    assert.ok(tool);

    const result = await tool.execute(
      "call-no-rem",
      {
        adrs: [
          {
            title: "No Rem Field",
            description: "No remaining field passed",
            context: "Ctx",
            decision: "Dec",
            impact: "Imp",
            summary: "No rem",
          },
        ],
      },
      new AbortController().signal,
      () => {},
      mockCtx(),
    );

    assert.ok(result, "Should return a result");
    assert.ok(!result.isError, `Should succeed without remaining field, got: ${result.content?.[0]?.text}`);

    // Verify the ADR was created
    const adrDir = join(tmpDir, "docs", "ADR");
    const files = await readdir(adrDir);
    const noRemFile = files.find(f => f.includes("no-rem"));
    assert.ok(noRemFile, "ADR file should exist");
  });

  it("reports structured output with success count", async () => {
    const pi = mockPi();
    const { registerBatchTools } = await import("../extensions/batch-tools.ts");
    registerBatchTools(pi);

    const tool = pi.tools.find((t) => t.name === "batch_create_adrs");
    assert.ok(tool);

    const result = await tool.execute(
      "call-structured-1",
      {
        adrs: [
          {
            title: "Structured One",
            description: "First",
            context: "Ctx",
            decision: "Dec",
            impact: "Imp",
            summary: "Sum one",
          },
          {
            title: "Structured Two",
            description: "Second",
            context: "Ctx",
            decision: "Dec",
            impact: "Imp",
            summary: "Sum two",
          },
        ],
      },
      new AbortController().signal,
      () => {},
      mockCtx(),
    );

    assert.ok(result, "Should return a result");
    const text = result.content?.[0]?.text ?? "";
    assert.ok(text.includes("Processed 2 ADR"), `Should show processed count, got: ${text}`);
    assert.ok(text.includes("2 created"), `Should show creation count, got: ${text}`);
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

  it("rejects spec with title exceeding 5 words", async () => {
    const pi = mockPi();
    const { registerBatchTools } = await import("../extensions/batch-tools.ts");
    registerBatchTools(pi);

    const tool = pi.tools.find((t) => t.name === "batch_create_specs");
    assert.ok(tool);

    // Use a title with a numeric suffix to avoid slug false positives
    const result = await tool.execute(
      "call-guard-1",
      {
        adrNumber: 1,
        specs: [
          {
            title: "A B C D E F G H",
            content: "# Requirements Specification\n\n- Req\n\n# Design Principles\n\n- Design\n\n# References\n\n",
          },
        ],
      },
      new AbortController().signal,
      () => {},
      mockCtx(),
    );

    assert.ok(result, "Should return a result");
    const text = result.content?.[0]?.text ?? "";
    assert.ok(
      text.includes("max is 5") || text.includes("title has 8 words"),
      `Should mention word limit violation, got: ${text}`,
    );
  });

  it("rejects spec referencing multiple ADRs", async () => {
    const pi = mockPi();
    const { registerBatchTools } = await import("../extensions/batch-tools.ts");
    registerBatchTools(pi);

    const tool = pi.tools.find((t) => t.name === "batch_create_specs");
    assert.ok(tool);

    const result = await tool.execute(
      "call-guard-2",
      {
        adrNumber: 1,
        specs: [
          {
            title: "Multi ADR",
            content: "# Requirements Specification\n\n- Req\n\n# Design Principles\n\n- Design\n\n# References\n\nThis spec implements @docs/ADR/001-*.md and @docs/ADR/002-*.md",
          },
        ],
      },
      new AbortController().signal,
      () => {},
      mockCtx(),
    );

    assert.ok(result, "Should return a result");
    const text = result.content?.[0]?.text ?? "";
    assert.ok(text.includes("multiple ADRs") || text.includes("separate specs"),
      `Should mention multiple ADR violation, got: ${text}`);
  });

  it("allows spec with correct single ADR reference", async () => {
    const pi = mockPi();
    const { registerBatchTools } = await import("../extensions/batch-tools.ts");
    registerBatchTools(pi);

    const tool = pi.tools.find((t) => t.name === "batch_create_specs");
    assert.ok(tool);

    const result = await tool.execute(
      "call-guard-3",
      {
        adrNumber: 1,
        specs: [
          {
            title: "Valid Spec",
            content: "# Requirements Specification\n\n- Req\n\n# Design Principles\n\n- Design\n\n# References\n\nThis spec implements @docs/ADR/001-*.md",
          },
        ],
      },
      new AbortController().signal,
      () => {},
      mockCtx(),
    );

    assert.ok(result, "Should return a result");
    assert.ok(!result.isError, `Valid spec should succeed, got: ${result.content?.[0]?.text}`);
  });
});
