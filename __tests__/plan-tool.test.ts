import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdir, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import type { ExtensionAPI, ExtensionContext, ToolDefinition } from "@earendil-works/pi-coding-agent";

/**
 * Tests for the plan_create AI tool.
 *
 * Spec (discussion):
 * - The plan_create tool lets the agent write complete plan files.
 * - It calls createPlan which handles numbering and spec cross-referencing.
 * - The tool requires specNumber, title, and content.
 * - Atomicity guardrails: title ≤5 words, references only one spec.
 * - specNumber uses 3-digit format (e.g. "001"), not dotted "1.1".
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

describe("plan_create tool", () => {
  before(async () => {
    tmpDir = join(tmpdir(), `plan-tool-test-${randomUUID()}`);
    await mkdir(tmpDir, { recursive: true });
    await mkdir(join(tmpDir, "docs", "plans"), { recursive: true });
    await mkdir(join(tmpDir, "docs", "specs"), { recursive: true });

    // Create a dummy ADR
    const { createAdr } = await import("../extensions/adr.ts");
    await createAdr(
      {
        title: "Dummy ADR",
        description: "Test ADR",
        status: "proposed",
        context: "Context",
        decision: "Decision",
        impact: "Impact",
      },
      tmpDir,
    );

    // Then create a spec linked to ADR 1
    const { createSpec } = await import("../extensions/spec.ts");
    await createSpec(1, "Dummy Spec", "# Requirements\n\nTest spec content.", tmpDir);
  });

  after(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  it("creates a plan file when called with required fields", async () => {
    const pi = mockPi();
    const { registerPlanTool } = await import("../extensions/plan-tool.ts");
    registerPlanTool(pi);

    const tool = pi.tools.find((t) => t.name === "plan_create");
    assert.ok(tool, "plan_create tool should be registered");

    const result = await tool.execute(
      "call-1",
      {
        specNumber: "001",
        title: "Implement Auth API",
        content:
          "# Overview\n\nImplement the user authentication API endpoints.\n\n" +
          "# Goals\n\n- Working login and logout\n- Token refresh\n\n" +
          "# Implementation Steps\n\n- [ ] Create auth middleware\n- [ ] Implement login endpoint\n- [ ] Add tests\n\n" +
          "# Risks\n\n| Risk | Likelihood | Impact | Mitigation |\n| --- | --- | --- | --- |\n| Security flaw | Low | High | Code review |\n\n" +
          "# UAT\n\n1. Send POST /auth/login with valid credentials\n2. Verify token is returned\n\n" +
          "# References\n\n",
      },
      new AbortController().signal,
      () => {},
      mockCtx(),
    );

    assert.ok(result, "Should return a result");
    assert.ok(!result.isError, `Should not be an error, got: ${result.content?.[0]?.text}`);

    const text = result.content?.[0]?.text ?? "";
    assert.ok(text.includes("Plan created:"), `Result should mention Plan created, got: ${text}`);

    // Verify the file exists on disk
    const files = await import("node:fs/promises").then((fs) =>
      fs.readdir(join(tmpDir, "docs", "plans")),
    );
    const mdFiles = files.filter((f) => f.endsWith(".md") && !f.startsWith("."));
    assert.ok(mdFiles.length >= 1, "Should have created at least one plan file");

    // Verify content
    const planFile = join(tmpDir, "docs", "plans", mdFiles[0]);
    const content = await readFile(planFile, "utf-8");
    assert.ok(content.includes("title: Implement Auth API"), "Should have title in frontmatter");
    assert.ok(content.includes("Create auth middleware"), "Should have implementation steps");
    assert.ok(
      content.includes("@docs/specs/001-"),
      `Should cross-reference spec 001, got content:\n${content}`,
    );
    assert.ok(content.includes("- [ ]"), "Should have task checkboxes");
    assert.ok(content.includes("UAT"), "Should have UAT section");
    assert.ok(content.includes("Risks"), "Should have risks section");
  });

  it("returns error when required fields are missing", async () => {
    const pi = mockPi();
    const { registerPlanTool } = await import("../extensions/plan-tool.ts");
    registerPlanTool(pi);

    const tool = pi.tools.find((t) => t.name === "plan_create");
    assert.ok(tool);

    const result = await tool.execute(
      "call-2",
      {
        specNumber: "",
        title: "",
        content: "",
      },
      new AbortController().signal,
      () => {},
      mockCtx(),
    );

    assert.ok(result.isError, "Missing fields should return an error");
  });

  it("registers both plan_create and plan_list tools", async () => {
    const pi = mockPi();
    const { registerPlanTool } = await import("../extensions/plan-tool.ts");
    registerPlanTool(pi);

    const createTool = pi.tools.find((t) => t.name === "plan_create");
    const listTool = pi.tools.find((t) => t.name === "plan_list");
    assert.ok(createTool, "plan_create should be registered");
    assert.ok(listTool, "plan_list should be registered");
  });

  it("rejects plan with title exceeding 5 words for atomicity", async () => {
    const pi = mockPi();
    const { registerPlanTool } = await import("../extensions/plan-tool.ts");
    registerPlanTool(pi);

    const tool = pi.tools.find((t) => t.name === "plan_create");
    assert.ok(tool);

    const result = await tool.execute(
      "call-3",
      {
        specNumber: "001",
        title: "Implement Auth API and Database Migration Plan",
        content:
          "# Overview\n\nTest\n\n# Goals\n\n- Goal\n\n# Implementation Steps\n\n- [ ] Step 1\n\n# Risks\n\n| L | I | M |\n| --- | --- | --- |\n| Low | High | Review |\n\n# UAT\n\n1. Test\n\n# References\n\n",
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

  it("auto-updates spec remaining count after creating a plan", async () => {
    const pi = mockPi();
    const { registerPlanTool } = await import("../extensions/plan-tool.ts");
    registerPlanTool(pi);

    const tool = pi.tools.find((t) => t.name === "plan_create");
    assert.ok(tool);

    // Isolated dir
    const autoDir = join(tmpdir(), `plan-auto-${randomUUID()}`);
    await mkdir(join(autoDir, "docs", "ADR"), { recursive: true });
    await mkdir(join(autoDir, "docs", "specs"), { recursive: true });
    await mkdir(join(autoDir, "docs", "plans"), { recursive: true });

    // Create an ADR
    const { createAdr } = await import("../extensions/adr.ts");
    await createAdr(
      { title: "Plan Test ADR", description: "For testing plan auto-update", status: "proposed", context: "C", decision: "D", impact: "I" },
      autoDir,
    );
    // Create a spec for it
    const { createSpec } = await import("../extensions/spec.ts");
    const specPath = await createSpec(1, "Auto Update Spec", "# Requirements\n\nTest\n\n# Design\n\nTest\n\n# References\n\n", autoDir);

    // Spec should have remaining=0 initially
    let specContent = await readFile(specPath, "utf-8");
    const initRemaining = specContent.match(/^remaining:\s*(\d+)/m)?.[1];
    assert.ok(
      initRemaining === "0" || initRemaining === undefined,
      `Spec should have no remaining plans initially, got remaining=${initRemaining}`,
    );

    const ctx = mockCtx();
    ctx.cwd = autoDir;
    const result = await tool.execute(
      "call-auto-plan-1",
      {
        specNumber: "001",
        title: "Auto Update Plan",
        content:
          "# Overview\n\nTest\n\n# Goals\n\n- Goal\n\n# Implementation Steps\n\n- [ ] Step 1\n\n# Risks\n\n| L | I | M |\n| --- | --- | --- |\n| Low | High | Review |\n\n# UAT\n\n1. Test\n\n# References\n\n",
      },
      new AbortController().signal,
      () => {},
      ctx,
    );

    assert.ok(result, "Should return a result");
    assert.ok(!result.isError, `Plan creation should succeed, got: ${result.content?.[0]?.text}`);

    await rm(autoDir, { recursive: true, force: true });

    // Result should mention the remaining count
    const text = result.content?.[0]?.text ?? "";
    assert.ok(
      text.includes("remaining:") || text.includes("remaining"),
      `Result should mention remaining count, got: ${text}`,
    );
  });

  it("rejects plan referencing multiple specs for atomicity", async () => {
    const pi = mockPi();
    const { registerPlanTool } = await import("../extensions/plan-tool.ts");
    registerPlanTool(pi);

    const tool = pi.tools.find((t) => t.name === "plan_create");
    assert.ok(tool);

    const result = await tool.execute(
      "call-4",
      {
        specNumber: "001",
        title: "Cross-Spec Task",
        content:
          "# Overview\n\nMultiple specs\n\n# Goals\n\n- Goal\n\n# Implementation Steps\n\n- [ ] Step 1\n\n# Risks\n\n| L | I | M |\n| --- | --- | --- |\n| Low | High | Review |\n\n# UAT\n\n1. Test\n\n# References\n\n@docs/specs/001-dummy @docs/specs/002-other",
      },
      new AbortController().signal,
      () => {},
      mockCtx(),
    );

    assert.ok(result.isError, "Multi-spec plan should return an error");
    const text = result.content?.[0]?.text ?? "";
    assert.ok(
      text.includes("spec") && (text.includes("different") || text.includes("atomic")),
      `Error should mention multiple specs, got: ${text}`,
    );
  });
});
