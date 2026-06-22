import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdir, writeFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import type { ExtensionAPI, ExtensionContext, ToolDefinition } from "@earendil-works/pi-coding-agent";

/**
 * Tests for the cross_ref_chain tool.
 *
 * Spec (plan):
 * - Scans all ADRs, specs, plans
 * - Builds the chain: ADR NNN → Spec MMM → Plan PPP
 * - Reports gaps and orphans
 * - Uses existing validateMappings but presents as chain
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
    registerTool: (tool: ToolDefinition) => { tools.push(tool); },
    tools,
  } as unknown as ExtensionAPI & { tools: typeof tools };
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

describe("cross_ref_chain tool", () => {
  before(async () => {
    tmpDir = join(tmpdir(), `chain-test-${randomUUID()}`);
    await mkdir(tmpDir, { recursive: true });
    await mkdir(join(tmpDir, "docs", "ADR"), { recursive: true });
    await mkdir(join(tmpDir, "docs", "specs"), { recursive: true });
    await mkdir(join(tmpDir, "docs", "plans"), { recursive: true });

    // Create ADR 001
    await writeFile(
      join(tmpDir, "docs", "ADR", "001-database.md"),
      "---\ntitle: Database Choice\nstatus: proposed\nremaining: 0\n---\n\n# Decision\n\nPostgreSQL.\n",
      "utf-8",
    );

    // Create ADR 002
    await writeFile(
      join(tmpDir, "docs", "ADR", "002-auth.md"),
      "---\ntitle: Auth System\nstatus: proposed\nremaining: 0\n---\n\n# Decision\n\nOAuth2.\n",
      "utf-8",
    );

    // Create spec 001 → ADR 001
    await writeFile(
      join(tmpDir, "docs", "specs", "001-db-schema.md"),
      "---\ntitle: DB Schema\nstatus: proposed\nremaining: 0\n---\n\n# Requirements Specification\n\n- R\n\n# Design Principles\n\n- D\n\n# References\n\n@docs/ADR/001-database.md\n",
      "utf-8",
    );

    // Create spec 002 → ADR 002
    await writeFile(
      join(tmpDir, "docs", "specs", "002-auth-api.md"),
      "---\ntitle: Auth API\nstatus: proposed\nremaining: 0\n---\n\n# Requirements Specification\n\n- R\n\n# Design Principles\n\n- D\n\n# References\n\n@docs/ADR/002-auth.md\n",
      "utf-8",
    );

    // Create plan 001 → spec 001
    await writeFile(
      join(tmpDir, "docs", "plans", "001-create-tables.md"),
      "---\ntitle: Create Tables\nstatus: proposed\n---\n\n# Overview\n\nCreate tables.\n\n# Goals\n\n- G\n\n# Implementation Steps\n\n- [ ] T\n\n# Risks\n| | | |\n|-|-|-|\n\n# UAT\n\n1. T\n\n# References\n\n@docs/specs/001-db-schema.md\n",
      "utf-8",
    );
  });

  after(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  it("registers cross_ref_chain tool", async () => {
    const pi = mockPi();
    const { registerChainTool } = await import("../extensions/chain-tool.ts");
    registerChainTool(pi);

    const tool = pi.tools.find((t) => t.name === "cross_ref_chain");
    assert.ok(tool, "cross_ref_chain should be registered");
  });

  it("builds chain visualization with chains and counts", async () => {
    const pi = mockPi();
    const { registerChainTool } = await import("../extensions/chain-tool.ts");
    registerChainTool(pi);

    const tool = pi.tools.find((t) => t.name === "cross_ref_chain");
    assert.ok(tool);

    const result = await tool.execute(
      "call-c-1",
      {},
      new AbortController().signal,
      () => {},
      mockCtx(),
    );

    assert.ok(result, "Should return a result");
    const text = result.content?.[0]?.text ?? "";

    // Should show chains
    assert.ok(
      text.includes("001") && text.includes("002"),
      `Should mention both chains, got: ${text}`,
    );

    // Should show counts
    assert.ok(
      text.includes("ADR") && text.includes("Spec") && text.includes("Plan"),
      `Should mention doc types, got: ${text}`,
    );
  });

  it("detects orphan specs", async () => {
    // Create an orphan spec with no ADR reference
    await writeFile(
      join(tmpDir, "docs", "specs", "003-orphan.md"),
      "---\ntitle: Orphan Spec\nstatus: proposed\nremaining: 0\n---\n\n# Requirements Specification\n\n- R\n\n# Design Principles\n\n- D\n\n# References\n\n@docs/ADR/999-missing.md\n",
      "utf-8",
    );

    const pi = mockPi();
    const { registerChainTool } = await import("../extensions/chain-tool.ts");
    registerChainTool(pi);

    const tool = pi.tools.find((t) => t.name === "cross_ref_chain");
    assert.ok(tool);

    const result = await tool.execute(
      "call-c-2",
      {},
      new AbortController().signal,
      () => {},
      mockCtx(),
    );

    await rm(join(tmpDir, "docs", "specs", "003-orphan.md"), { force: true });

    assert.ok(result, "Should return a result");
    const text = result.content?.[0]?.text ?? "";
    assert.ok(
      text.includes("orphan") || text.includes("Orphan") || text.includes("999"),
      `Should mention orphan spec, got: ${text}`,
    );
  });
});
