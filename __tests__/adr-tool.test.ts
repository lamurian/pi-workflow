import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdir, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import type { ExtensionAPI, ExtensionContext, ToolDefinition } from "@earendil-works/pi-coding-agent";

/**
 * Tests for the adr_create AI tool.
 *
 * Spec (discussion):
 * - The adr_create tool lets the agent write complete ADR files with
 *   full context, decision, and impact (not TBD skeletons).
 * - It calls createAdrFromBrainstorm which handles numbering, slug,
 *   overlap detection, and ARCHITECTURE.md registration.
 * - The tool returns the created file path.
 */

let tmpDir: string;

function t(...parts: string[]): string {
  return join(tmpDir, ...parts);
}

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

describe("adr_create tool", () => {
  before(async () => {
    tmpDir = join(tmpdir(), `adr-tool-test-${randomUUID()}`);
    await mkdir(tmpDir, { recursive: true });
    // Create AGENTS.md so project initiation check passes
    await mkdir(join(tmpDir, "docs", "ADR"), { recursive: true });
  });

  after(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  it("creates a complete ADR file when called with all fields", async () => {
    const pi = mockPi();
    const { registerAdrTool } = await import("../extensions/adr-tool.ts");
    registerAdrTool(pi);

    // Find the adr_create tool
    const tool = pi.tools.find((t) => t.name === "adr_create");
    assert.ok(tool, "adr_create tool should be registered");

    // Execute the tool
    const result = await tool.execute(
      "call-1",
      {
        title: "Test Decision",
        description: "A test decision for unit testing",
        context: "We need to test whether adr_create works correctly. Options considered: manual file write, using the tool.",
        decision: "Use the adr_create tool because it handles numbering and cross-references automatically.",
        impact: "Tests become more reliable. No manual file handling needed.",
        summary: "A test decision for unit testing",
      },
      new AbortController().signal,
      () => {},
      mockCtx(),
    );

    assert.ok(result, "Should return a result");
    assert.ok(!result.isError, `Should not be an error, got: ${result.content?.[0]?.text}`);

    const text = result.content?.[0]?.text ?? "";
    assert.ok(text.includes("ADR created:"), `Result should mention ADR created, got: ${text}`);

    // Verify the file exists on disk
    const files = await import("node:fs/promises").then((fs) =>
      fs.readdir(join(tmpDir, "docs", "ADR")),
    );
    const mdFiles = files.filter((f) => f.endsWith(".md"));
    assert.ok(mdFiles.length >= 1, "Should have created at least one ADR file");

    // Read the file and verify content
    const adrFile = join(tmpDir, "docs", "ADR", mdFiles[0]);
    const content = await readFile(adrFile, "utf-8");

    // Verify ADR template fields are filled
    assert.ok(content.includes("title: Test Decision"), "Should have title in frontmatter");
    assert.ok(content.includes("description: A test decision for unit testing"), "Should have description");
    assert.ok(content.includes("status: proposed"), "Default status should be proposed");
    assert.ok(content.includes("# Context"), "Should have Context section");
    assert.ok(content.includes("# Decision"), "Should have Decision section");
    assert.ok(content.includes("# Impact"), "Should have Impact section");
    assert.ok(content.includes("We need to test whether adr_create works correctly"), "Should have full context");

    // Verify ARCHITECTURE.md was updated
    const archContent = await readFile(join(tmpDir, "ARCHITECTURE.md"), "utf-8");
    assert.ok(archContent.includes("@docs/ADR/"), "ARCHITECTURE.md should reference the ADR");
    assert.ok(
      archContent.includes("A test decision for unit testing"),
      "ARCHITECTURE.md should contain the summary, got: " + archContent,
    );
  });

  it("returns error when required fields are missing", async () => {
    const pi = mockPi();
    const { registerAdrTool } = await import("../extensions/adr-tool.ts");
    registerAdrTool(pi);

    const tool = pi.tools.find((t) => t.name === "adr_create");
    assert.ok(tool);

    const result = await tool.execute(
      "call-2",
      {
        title: "Incomplete",
        description: "",
        context: "",
        decision: "",
        impact: "",
        summary: "",
      },
      new AbortController().signal,
      () => {},
      mockCtx(),
    );

    assert.ok(result.isError, "Missing fields should return an error");
  });

  it("registers both adr_create and adr_list tools", async () => {
    const pi = mockPi();
    const { registerAdrTool } = await import("../extensions/adr-tool.ts");
    registerAdrTool(pi);

    const createTool = pi.tools.find((t) => t.name === "adr_create");
    const listTool = pi.tools.find((t) => t.name === "adr_list");
    assert.ok(createTool, "adr_create should be registered");
    assert.ok(listTool, "adr_list should be registered");
  });

  it("adr_list returns created ADRs", async () => {
    const pi = mockPi();
    const { registerAdrTool } = await import("../extensions/adr-tool.ts");
    registerAdrTool(pi);

    const listTool = pi.tools.find((t) => t.name === "adr_list");
    assert.ok(listTool);

    const result = await listTool.execute(
      "call-3",
      {},
      new AbortController().signal,
      () => {},
      mockCtx(),
    );

    assert.ok(result, "Should return a result");
    const text = result.content?.[0]?.text ?? "";
    assert.ok(text.includes("ADR(s)") || text.includes("No ADRs found"), "Should list ADRs or indicate none");
  });
});
