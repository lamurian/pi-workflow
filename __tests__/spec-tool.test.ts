import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdir, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import type { ExtensionAPI, ExtensionContext, ToolDefinition } from "@earendil-works/pi-coding-agent";

/**
 * Tests for the spec_create AI tool.
 *
 * Spec (discussion):
 * - The spec_create tool lets the agent write complete specification files.
 * - It calls createSpec which handles numbering and ADR cross-referencing.
 * - The tool requires adrNumber, title, and content.
 * - Atomicity guardrails: title ≤5 words, references only one ADR.
 */

let tmpDir: string;

/** Mock ExtensionAPI that captures tool registrations. */
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

/** Minimal ExtensionContext for tool execution. */
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

describe("spec_create tool", () => {
  before(async () => {
    tmpDir = join(tmpdir(), `spec-tool-test-${randomUUID()}`);
    await mkdir(tmpDir, { recursive: true });
    await mkdir(join(tmpDir, "docs", "specs"), { recursive: true });
    await mkdir(join(tmpDir, "docs", "ADR"), { recursive: true });

    // Create a dummy ADR so spec creation can reference it
    const { createAdr } = await import("../extensions/adr.ts");
    await createAdr(
      {
        title: "Dummy ADR for testing",
        description: "Test ADR to enable spec creation",
        status: "proposed",
        context: "Testing context",
        decision: "Testing decision",
        impact: "Testing impact",
      },
      tmpDir,
    );
  });

  after(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  it("creates a spec file when called with required fields", async () => {
    const pi = mockPi();
    const { registerSpecTool } = await import("../extensions/spec-tool.ts");
    registerSpecTool(pi);

    const tool = pi.tools.find((t) => t.name === "spec_create");
    assert.ok(tool, "spec_create tool should be registered");

    const result = await tool.execute(
      "call-1",
      {
        adrNumber: 1,
        title: "User Authentication",
        content:
          "# Requirements Specification\n\n- Users must log in via email and password\n- Passwords must be hashed with bcrypt\n\n# Design Principles\n\n- JWT-based stateless authentication\n- Refresh token rotation\n\n# References\n\n",
      },
      new AbortController().signal,
      () => {},
      mockCtx(),
    );

    assert.ok(result, "Should return a result");
    assert.ok(!result.isError, `Should not be an error, got: ${result.content?.[0]?.text}`);

    const text = result.content?.[0]?.text ?? "";
    assert.ok(text.includes("Spec created:"), `Result should mention Spec created, got: ${text}`);
    assert.ok(text.includes("ADR 001"), `Result should reference ADR, got: ${text}`);

    // Verify the file exists on disk
    const files = await import("node:fs/promises").then((fs) =>
      fs.readdir(join(tmpDir, "docs", "specs")),
    );
    const mdFiles = files.filter((f) => f.endsWith(".md") && !f.startsWith("."));
    assert.ok(mdFiles.length >= 1, "Should have created at least one spec file");

    // Verify content
    const specFile = join(tmpDir, "docs", "specs", mdFiles[0]);
    const content = await readFile(specFile, "utf-8");
    assert.ok(content.includes("title: User Authentication"), "Should have title in frontmatter");
    assert.ok(content.includes("Users must log in via email"), "Should have requirements content");
    assert.ok(content.includes("@docs/ADR/001-"), "Should cross-reference the ADR");
  });

  it("returns error when required fields are missing", async () => {
    const pi = mockPi();
    const { registerSpecTool } = await import("../extensions/spec-tool.ts");
    registerSpecTool(pi);

    const tool = pi.tools.find((t) => t.name === "spec_create");
    assert.ok(tool);

    const result = await tool.execute(
      "call-2",
      {
        adrNumber: 0,
        title: "",
        content: "",
      },
      new AbortController().signal,
      () => {},
      mockCtx(),
    );

    assert.ok(result.isError, "Missing fields should return an error");
  });

  it("registers both spec_create and spec_list tools", async () => {
    const pi = mockPi();
    const { registerSpecTool } = await import("../extensions/spec-tool.ts");
    registerSpecTool(pi);

    const createTool = pi.tools.find((t) => t.name === "spec_create");
    const listTool = pi.tools.find((t) => t.name === "spec_list");
    assert.ok(createTool, "spec_create should be registered");
    assert.ok(listTool, "spec_list should be registered");
  });

  it("rejects spec with title exceeding 5 words for atomicity", async () => {
    const pi = mockPi();
    const { registerSpecTool } = await import("../extensions/spec-tool.ts");
    registerSpecTool(pi);

    const tool = pi.tools.find((t) => t.name === "spec_create");
    assert.ok(tool);

    const result = await tool.execute(
      "call-3",
      {
        adrNumber: 1,
        title: "User Authentication and Authorization Module Overhaul",
        content:
          "# Requirements Specification\n\n- Users must log in\n\n# Design Principles\n\n- JWT-based\n\n# References\n\n",
      },
      new AbortController().signal,
      () => {},
      mockCtx(),
    );

    assert.ok(result.isError, "Title >5 words should return an error");
    const text = result.content?.[0]?.text ?? "";
    assert.ok(
      text.includes("5 words") || text.includes("atomic"),
      `Error should mention atomicity or word limit, got: ${text}`,
    );
  });

  it("auto-updates ADR remaining count after creating a spec", async () => {
    const pi = mockPi();
    const { registerSpecTool } = await import("../extensions/spec-tool.ts");
    registerSpecTool(pi);

    const tool = pi.tools.find((t) => t.name === "spec_create");
    assert.ok(tool);

    // Isolated dir — no prior ADRs or specs
    const autoDir = join(tmpdir(), `spec-auto-${randomUUID()}`);
    await mkdir(join(autoDir, "docs", "ADR"), { recursive: true });
    await mkdir(join(autoDir, "docs", "specs"), { recursive: true });

    // Create an ADR first
    const { createAdr } = await import("../extensions/adr.ts");
    const adrPath = await createAdr(
      { title: "Spec Test ADR", description: "For testing spec auto-update", status: "proposed", context: "C", decision: "D", impact: "I" },
      autoDir,
    );

    // ADR should have remaining=0 initially
    let adrContent = await readFile(adrPath, "utf-8");
    const initialRemaining = adrContent.match(/^remaining:\s*(\d+)/m)?.[1];
    assert.ok(
      initialRemaining === "0" || initialRemaining === undefined,
      `ADR should have no remaining specs initially, got remaining=${initialRemaining}`,
    );

    const ctx = mockCtx();
    ctx.cwd = autoDir;
    const result = await tool.execute(
      "call-auto-1",
      {
        adrNumber: 1,
        title: "Auto Update Spec",
        content:
          "# Requirements Specification\n\n- Test requirement\n\n# Design Principles\n\n- Test principle\n\n# References\n\n",
      },
      new AbortController().signal,
      () => {},
      ctx,
    );

    assert.ok(result, "Should return a result");
    assert.ok(!result.isError, `Spec creation should succeed, got: ${result.content?.[0]?.text}`);

    // Result should mention the remaining count
    const text = result.content?.[0]?.text ?? "";
    assert.ok(
      text.includes("remaining:") || text.includes("remaining"),
      `Result should mention remaining count, got: ${text}`,
    );

    await rm(autoDir, { recursive: true, force: true });
  });

  it("rejects spec referencing multiple ADRs for atomicity", async () => {
    const pi = mockPi();
    const { registerSpecTool } = await import("../extensions/spec-tool.ts");
    registerSpecTool(pi);

    const tool = pi.tools.find((t) => t.name === "spec_create");
    assert.ok(tool);

    const result = await tool.execute(
      "call-4",
      {
        adrNumber: 1,
        title: "Mixed Concerns",
        content:
          "# Requirements Specification\n\n- Cross-ADR feature\n\n# Design Principles\n\n- Integrates multiple ADRs\n\n# References\n\n@docs/ADR/001-dummy.md @docs/ADR/002-nonexistent.md",
      },
      new AbortController().signal,
      () => {},
      mockCtx(),
    );

    assert.ok(result.isError, "Multi-ADR spec should return an error");
    const text = result.content?.[0]?.text ?? "";
    assert.ok(
      text.includes("ADR") && (text.includes("different") || text.includes("atomic")),
      `Error should mention multiple ADRs, got: ${text}`,
    );
  });

  it("rejects spec referencing a different ADR than the target", async () => {
    const pi = mockPi();
    const { registerSpecTool } = await import("../extensions/spec-tool.ts");
    registerSpecTool(pi);

    const tool = pi.tools.find((t) => t.name === "spec_create");
    assert.ok(tool);

    const result = await tool.execute(
      "call-5",
      {
        adrNumber: 1,
        title: "Wrong ADR",
        content:
          "# Requirements Specification\n\n- Req\n\n# Design Principles\n\n- Design\n\n# References\n\nThis spec implements @docs/ADR/002-different.md",
      },
      new AbortController().signal,
      () => {},
      mockCtx(),
    );

    assert.ok(result.isError, "Wrong ADR ref should return an error");
    const text = result.content?.[0]?.text ?? "";
    assert.ok(
      text.includes("ADR 002") && text.includes("ADR 001"),
      `Error should mention both ADRs, got: ${text}`,
    );
  });

  it("allows spec referencing the correct ADR", async () => {
    const pi = mockPi();
    const { registerSpecTool } = await import("../extensions/spec-tool.ts");
    registerSpecTool(pi);

    const tool = pi.tools.find((t) => t.name === "spec_create");
    assert.ok(tool);

    const result = await tool.execute(
      "call-6",
      {
        adrNumber: 1,
        title: "Correct ADR",
        content:
          "# Requirements Specification\n\n- Req\n\n# Design Principles\n\n- Design\n\n# References\n\nThis spec implements @docs/ADR/001-correct.md",
      },
      new AbortController().signal,
      () => {},
      mockCtx(),
    );

    assert.ok(result, "Should return a result");
    assert.ok(!result.isError, `Correct ADR ref should succeed, got: ${result.content?.[0]?.text}`);
  });
});
