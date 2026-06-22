import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdir, writeFile, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import type { ExtensionAPI, ExtensionContext, ToolDefinition } from "@earendil-works/pi-coding-agent";

/**
 * Tests for the validate_documents tool.
 *
 * Spec (plan):
 * - validate_documents scans actual files in the phase's output directory
 * - Validates atomicity, numbering, and cross-references
 * - On PASS, stores validation_token in workflow state
 */

let tmpDir: string;

function mockPi(): ExtensionAPI & { tools: ToolDefinition[]; entries: unknown[] } {
  const tools: ToolDefinition[] = [];
  const entries: unknown[] = [];
  return {
    on: () => {},
    registerCommand: () => {},
    appendEntry: (_type: string, data: unknown) => { entries.push(data); },
    sendUserMessage: () => {},
    exec: async () => ({ stdout: "", stderr: "", exitCode: 0 }),
    registerTool: (tool: ToolDefinition) => { tools.push(tool); },
    tools,
    entries,
  } as unknown as ExtensionAPI & { tools: typeof tools; entries: typeof entries };
}

function mockCtx(): ExtensionContext {
  return {
    cwd: tmpDir,
    sessionManager: { getBranch: () => [] },
    ui: {
      notify: () => {},
      setStatus: () => {},
      setWidget: () => {},
      theme: { fg: () => "" },
      addAutocompleteProvider: () => {},
    },
  } as unknown as ExtensionContext;
}

/** Helper: create an ADR file. */
async function createAdrFile(number: number, title: string, decision: string, extra?: string): Promise<void> {
  const dir = join(tmpDir, "docs", "ADR");
  await mkdir(dir, { recursive: true });
  const slug = title.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
  const content = [
    "---",
    `title: ${title}`,
    `description: ${title}`,
    "status: proposed",
    `remaining: 0`,
    `date: 2026-06-22`,
    "---",
    "",
    "# Context",
    "",
    "Test context.",
    "",
    "# Decision",
    "",
    decision,
    extra ?? "",
    "",
    "# Impact",
    "",
    "Test impact.",
  ].join("\n");
  await writeFile(join(dir, `${String(number).padStart(3, "0")}-${slug}.md`), content, "utf-8");
}

/** Helper: create a spec file. */
async function createSpecFile(number: number, title: string, adrNumber: number, hasSections = true): Promise<void> {
  const dir = join(tmpDir, "docs", "specs");
  await mkdir(dir, { recursive: true });
  const slug = title.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
  const content = [
    "---",
    `title: ${title}`,
    `description: ${title}`,
    "status: proposed",
    `remaining: 0`,
    `date: 2026-06-22`,
    "---",
    "",
    ...(hasSections ? [
      "# Requirements Specification",
      "",
      "- Requirement 1",
      "",
      "# Design Principles",
      "",
      "- Principle 1",
      "",
      "# References",
      "",
      `This spec implements @docs/ADR/${String(adrNumber).padStart(3, "0")}-*.md`,
    ] : [
      "# Some Random Section",
      "",
      "Content without proper sections.",
      "",
      "# References",
      "",
      `This spec implements @docs/ADR/${String(adrNumber).padStart(3, "0")}-*.md`,
    ]),
  ].join("\n");
  await writeFile(join(dir, `${String(number).padStart(3, "0")}-${slug}.md`), content, "utf-8");
}

/** Helper: create a plan file. */
async function createPlanFile(number: number, title: string, specNumber: number): Promise<void> {
  const dir = join(tmpDir, "docs", "plans");
  await mkdir(dir, { recursive: true });
  const slug = title.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
  const content = [
    "---",
    `title: ${title}`,
    `description: ${title}`,
    "status: proposed",
    `date: 2026-06-22`,
    "---",
    "",
    "# Overview",
    "",
    "Test overview.",
    "",
    "# Goals",
    "",
    "- Goal 1",
    "",
    "# Implementation Steps",
    "",
    "- [ ] Task 1",
    "",
    "# Risks",
    "| Risk | L | I | M |",
    "|---|---|---|---|",
    "| R1 | L | M | M1 |",
    "",
    "# UAT",
    "",
    "1. Test step 1",
    "",
    "# References",
    "",
    `This plan implements @docs/specs/${String(specNumber).padStart(3, "0")}-*.md`,
  ].join("\n");
  await writeFile(join(dir, `${String(number).padStart(3, "0")}-${slug}.md`), content, "utf-8");
}

describe("validate_documents tool registration", () => {
  after(async () => { /* no cleanup needed */ });

  it("registers validate_documents tool", async () => {
    const pi = mockPi();
    const { registerValidateDocsTool } = await import("../extensions/validate-docs.ts");
    registerValidateDocsTool(pi);

    const tool = pi.tools.find((t) => t.name === "validate_documents");
    assert.ok(tool, "validate_documents should be registered");
  });
});

describe("validate_documents for specifying phase (ADRs)", () => {
  before(async () => {
    tmpDir = join(tmpdir(), `val-adr-${randomUUID()}`);
    await mkdir(tmpDir, { recursive: true });
    await mkdir(join(tmpDir, "docs", "ADR"), { recursive: true });
    await mkdir(join(tmpDir, "docs", "specs"), { recursive: true });
  });

  after(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  it("passes when all ADRs are atomic with clean numbering", async () => {
    const pi = mockPi();
    const { registerValidateDocsTool } = await import("../extensions/validate-docs.ts");
    registerValidateDocsTool(pi);

    await createAdrFile(1, "First ADR", "Use approach A");
    await createAdrFile(2, "Second ADR", "Use approach B");

    const tool = pi.tools.find((t) => t.name === "validate_documents");
    assert.ok(tool);

    const result = await tool.execute(
      "call-v-1",
      { phase: "specifying" },
      new AbortController().signal,
      () => {},
      mockCtx(),
    );

    assert.ok(result, "Should return a result");
    assert.ok(!result.isError, `Clean ADRs should pass, got: ${result.content?.[0]?.text}`);

    // Should store a validation token in workflow state
    assert.ok(pi.entries.length >= 1, "Should store validation token in state");
    const token = pi.entries[pi.entries.length - 1] as Record<string, unknown>;
    assert.equal(token.phase, "specifying");
    assert.ok(token.timestamp, "Token should have timestamp");
    assert.ok(token.phaseHash, "Token should have phase hash");
  });

  it("fails when ADR numbering has a collision", async () => {
    const pi = mockPi();
    const { registerValidateDocsTool } = await import("../extensions/validate-docs.ts");
    registerValidateDocsTool(pi);

    // Create two ADRs with same number
    await createAdrFile(1, "Collision One", "Decision");
    // Manually create a second ADR with number 001
    const adrDir = join(tmpDir, "docs", "ADR");
    await writeFile(
      join(adrDir, "001-collision-two.md"),
      "---\ntitle: Collision Two\nstatus: proposed\nremaining: 0\n---\n\n# Context\n\nC\n\n# Decision\n\nD\n\n# Impact\n\nI\n",
      "utf-8",
    );

    const tool = pi.tools.find((t) => t.name === "validate_documents");
    assert.ok(tool);

    const result = await tool.execute(
      "call-v-2",
      { phase: "specifying" },
      new AbortController().signal,
      () => {},
      mockCtx(),
    );

    assert.ok(result, "Should return a result");
    assert.ok(result.isError, "Numbering collision should fail");

    const text = result.content?.[0]?.text ?? "";
    assert.ok(
      text.includes("collision") || text.includes("Collision"),
      `Should mention numbering collision, got: ${text}`,
    );
  });

  it("validates ADR has a Decision section in the body", async () => {
    const pi = mockPi();
    const { registerValidateDocsTool } = await import("../extensions/validate-docs.ts");
    registerValidateDocsTool(pi);

    // Delete and recreate ADR 001 without a decision section
    const adrDir = join(tmpDir, "docs", "ADR");
    for (const f of await import("node:fs/promises").then(m => m.readdir(adrDir))) {
      await rm(join(adrDir, f), { force: true });
    }

    await writeFile(
      join(adrDir, "001-no-decision.md"),
      "---\ntitle: No Decision\ndescription: Missing decision\nstatus: proposed\nremaining: 0\ndate: 2026-06-22\n---\n\n# Context\n\nThis has context but no decision.\n\n# Impact\n\nSome impact.\n",
      "utf-8",
    );

    const tool = pi.tools.find((t) => t.name === "validate_documents");
    assert.ok(tool);

    const result = await tool.execute(
      "call-v-3",
      { phase: "specifying" },
      new AbortController().signal,
      () => {},
      mockCtx(),
    );

    assert.ok(result, "Should return a result");
    assert.ok(result.isError, "Missing Decision section should fail");

    const text = result.content?.[0]?.text ?? "";
    assert.ok(
      text.includes("Decision") && (text.includes("missing") || text.includes("not found")),
      `Should mention missing decision, got: ${text}`,
    );
  });
});

describe("validate_documents for planning phase (specs)", () => {
  before(async () => {
    tmpDir = join(tmpdir(), `val-spec-${randomUUID()}`);
    await mkdir(tmpDir, { recursive: true });
    await mkdir(join(tmpDir, "docs", "ADR"), { recursive: true });
    await mkdir(join(tmpDir, "docs", "specs"), { recursive: true });

    // Create backing ADRs
    await createAdrFile(1, "ADR One", "Decision A");
    await createAdrFile(2, "ADR Two", "Decision B");
  });

  after(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  it("passes when all specs reference exactly one ADR and have proper sections", async () => {
    const pi = mockPi();
    const { registerValidateDocsTool } = await import("../extensions/validate-docs.ts");
    registerValidateDocsTool(pi);

    // Clean up any existing specs
    const specsDir = join(tmpDir, "docs", "specs");
    for (const f of await import("node:fs/promises").then(m => m.readdir(specsDir))) {
      await rm(join(specsDir, f), { force: true });
    }

    await createSpecFile(1, "Spec One", 1);
    await createSpecFile(2, "Spec Two", 2);

    const tool = pi.tools.find((t) => t.name === "validate_documents");
    assert.ok(tool);

    const result = await tool.execute(
      "call-vp-1",
      { phase: "planning" },
      new AbortController().signal,
      () => {},
      mockCtx(),
    );

    assert.ok(result, "Should return a result");
    assert.ok(!result.isError, `Valid specs should pass, got: ${result.content?.[0]?.text}`);

    const text = result.content?.[0]?.text ?? "";
    assert.ok(
      text.includes("PASS") || text.includes("passed"),
      `Should indicate pass, got: ${text}`,
    );
  });
});

describe("validate_documents for implementing phase (plans)", () => {
  before(async () => {
    tmpDir = join(tmpdir(), `val-plan-${randomUUID()}`);
    await mkdir(tmpDir, { recursive: true });
    await mkdir(join(tmpDir, "docs", "ADR"), { recursive: true });
    await mkdir(join(tmpDir, "docs", "specs"), { recursive: true });
    await mkdir(join(tmpDir, "docs", "plans"), { recursive: true });

    await createAdrFile(1, "ADR One", "Decision A");
    await createSpecFile(1, "Spec One", 1);
  });

  after(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  it("passes when plans have required sections and correct references", async () => {
    const pi = mockPi();
    const { registerValidateDocsTool } = await import("../extensions/validate-docs.ts");
    registerValidateDocsTool(pi);

    const plansDir = join(tmpDir, "docs", "plans");
    for (const f of await import("node:fs/promises").then(m => m.readdir(plansDir))) {
      await rm(join(plansDir, f), { force: true });
    }

    await createPlanFile(1, "Plan One", 1);

    const tool = pi.tools.find((t) => t.name === "validate_documents");
    assert.ok(tool);

    const result = await tool.execute(
      "call-vi-1",
      { phase: "implementing" },
      new AbortController().signal,
      () => {},
      mockCtx(),
    );

    assert.ok(result, "Should return a result");
    assert.ok(!result.isError, `Valid plan should pass, got: ${result.content?.[0]?.text}`);
  });

  it("detects broken cross-references in plans", async () => {
    const pi = mockPi();
    const { registerValidateDocsTool } = await import("../extensions/validate-docs.ts");
    registerValidateDocsTool(pi);

    const plansDir = join(tmpDir, "docs", "plans");
    await writeFile(
      join(plansDir, "002-orphan-plan.md"),
      "---\ntitle: Orphan Plan\ndescription: Orphan\nstatus: proposed\ndate: 2026-06-22\n---\n\n# Overview\n\nO\n\n# Goals\n\n- G\n\n# Implementation Steps\n\n- [ ] T\n\n# Risks\n|||\n|-|-|\n\n# UAT\n\n1. T\n\n# References\n\nThis plan references @docs/specs/999-nonexistent-*.md\n",
      "utf-8",
    );

    const tool = pi.tools.find((t) => t.name === "validate_documents");
    assert.ok(tool);

    const result = await tool.execute(
      "call-vi-2",
      { phase: "implementing" },
      new AbortController().signal,
      () => {},
      mockCtx(),
    );

    assert.ok(result, "Should return a result");
    assert.ok(result.isError, "Broken cross-reference should fail");
    const text = result.content?.[0]?.text ?? "";
    assert.ok(
      text.includes("999") || text.includes("reference") || text.includes("not found"),
      `Should mention broken reference, got: ${text}`,
    );
  });
});

describe("validate_documents common checks", () => {
  before(async () => {
    tmpDir = join(tmpdir(), `val-common-${randomUUID()}`);
    await mkdir(tmpDir, { recursive: true });
    await mkdir(join(tmpDir, "docs", "ADR"), { recursive: true });
    await mkdir(join(tmpDir, "docs", "specs"), { recursive: true });

    await createAdrFile(1, "First", "Decision A");
    await createAdrFile(3, "Third", "Decision B"); // gap: missing 002
  });

  after(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  it("detects gaps in numbering sequence greater than 1", async () => {
    const pi = mockPi();
    const { registerValidateDocsTool } = await import("../extensions/validate-docs.ts");
    registerValidateDocsTool(pi);

    const tool = pi.tools.find((t) => t.name === "validate_documents");
    assert.ok(tool);

    const result = await tool.execute(
      "call-c-1",
      { phase: "specifying" },
      new AbortController().signal,
      () => {},
      mockCtx(),
    );

    assert.ok(result, "Should return a result");
    assert.ok(result.isError, "Numbering gap should be a violation");
    const text = result.content?.[0]?.text ?? "";
    assert.ok(
      text.includes("gap") || text.includes("missing") || text.includes("002"),
      `Should mention numbering gap, got: ${text}`,
    );
  });

  it("returns error for invalid phase name", async () => {
    const pi = mockPi();
    const { registerValidateDocsTool } = await import("../extensions/validate-docs.ts");
    registerValidateDocsTool(pi);

    const tool = pi.tools.find((t) => t.name === "validate_documents");
    assert.ok(tool);

    const result = await tool.execute(
      "call-c-2",
      { phase: "invalid" },
      new AbortController().signal,
      () => {},
      mockCtx(),
    );

    assert.ok(result, "Should return a result");
    assert.ok(result.isError, "Invalid phase should fail");
  });
});

describe("validate_documents cross-reference resolution", () => {
  before(async () => {
    tmpDir = join(tmpdir(), `val-cross-${randomUUID()}`);
    await mkdir(tmpDir, { recursive: true });
    await mkdir(join(tmpDir, "docs", "ADR"), { recursive: true });
    await mkdir(join(tmpDir, "docs", "specs"), { recursive: true });
    await mkdir(join(tmpDir, "docs", "plans"), { recursive: true });

    await createAdrFile(1, "Exists", "Decision for existing ADR");
    await createSpecFile(1, "Existing Spec", 1);
  });

  after(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  it("reports unresolved cross-references in specs", async () => {
    const pi = mockPi();
    const { registerValidateDocsTool } = await import("../extensions/validate-docs.ts");
    registerValidateDocsTool(pi);

    // Create spec referencing a non-existent ADR
    const specsDir = join(tmpDir, "docs", "specs");
    await writeFile(
      join(specsDir, "002-bad-ref.md"),
      "---\ntitle: Bad Ref\ndescription: Bad\ndate: 2026-06-22\n---\n\n# Requirements Specification\n\n- Req\n\n# Design Principles\n\n- Design\n\n# References\n\n@docs/ADR/999-missing.md\n",
      "utf-8",
    );

    const tool = pi.tools.find((t) => t.name === "validate_documents");
    assert.ok(tool);

    // Run planning phase validation to check spec refs
    const result = await tool.execute(
      "call-cr-1",
      { phase: "planning" },
      new AbortController().signal,
      () => {},
      mockCtx(),
    );

    assert.ok(result, "Should return a result");
    assert.ok(result.isError, "Unresolved reference should fail");
    const text = result.content?.[0]?.text ?? "";
    assert.ok(
      text.includes("999") || text.includes("unresolved") || text.includes("not found"),
      `Should mention broken reference, got: ${text}`,
    );
  });
});
