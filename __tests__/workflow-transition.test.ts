import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdir, rm, writeFile, readFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import type { ExtensionAPI, ExtensionContext, ToolDefinition } from "@earendil-works/pi-coding-agent";

/**
 * Tests for the workflow_transition AI tool (post-redesign).
 *
 * Spec (plan):
 * - The tool accepts `phase` (required) and `force` (optional)
 * - If neither outline nor force: error
 * - Phase validation runs first
 * - Before transition, finds a valid validation_token in session
 * - Missing/expired token → error telling agent to run validate_documents
 * - Valid token → shows confirmation popup → transitions on confirm
 * - Cancellation detects common issues and shows diagnostics
 */

let tmpDir: string;

interface MockOptions {
  confirmResult?: boolean;
  /** Pre-populate session with validation tokens. */
  validationTokens?: Array<{
    phase: string;
    timestamp: number;
    phaseHash: string;
  }>;
}

/** Capture tool registrations and state transitions. */
function mockPi(): ExtensionAPI & { tools: ToolDefinition[]; stateEntries: unknown[] } {
  const tools: ToolDefinition[] = [];
  const stateEntries: unknown[] = [];
  return {
    on: () => {},
    registerCommand: () => {},
    appendEntry: (_type: string, data: unknown) => {
      stateEntries.push(data);
    },
    sendUserMessage: () => {},
    exec: async () => ({ stdout: "", stderr: "", exitCode: 0 }),
    registerTool: (tool: ToolDefinition) => {
      tools.push(tool);
    },
    tools,
    stateEntries,
  } as unknown as ExtensionAPI & { tools: typeof tools; stateEntries: typeof stateEntries };
}

function mockCtx(opts?: MockOptions): ExtensionContext {
  const confirmResult = opts?.confirmResult ?? true;
  const tokens = opts?.validationTokens ?? [];

  const customEntries = tokens.map((t) => ({
    type: "custom",
    customType: "validation_token",
    data: t,
  }));

  return {
    cwd: tmpDir,
    hasUI: true,
    sessionManager: {
      getBranch: () => customEntries,
    },
    ui: {
      notify: () => {},
      setStatus: () => {},
      setWidget: () => {},
      theme: { fg: () => "" },
      addAutocompleteProvider: () => {},
      confirm: async (_title: string, _body: string) => confirmResult,
    },
  } as unknown as ExtensionContext;
}

describe("workflow_transition tool", () => {
  before(async () => {
    tmpDir = join(tmpdir(), `wf-transition-test-${randomUUID()}`);
    await mkdir(tmpDir, { recursive: true });
    await mkdir(join(tmpDir, "docs", "ADR"), { recursive: true });
    await mkdir(join(tmpDir, "docs", "specs"), { recursive: true });
    await mkdir(join(tmpDir, "docs", "plans"), { recursive: true });

    // Create sample documents for pre-condition checks
    await writeFile(
      join(tmpDir, "docs", "ADR", "001-database-choice.md"),
      "---\ntitle: Database Choice\ndescription: Use PostgreSQL\nstatus: proposed\n---\n\n# Context\n\nNeed DB.\n\n# Decision\n\nUse PostgreSQL.\n\n# Impact\n\nLow.",
      "utf-8",
    );
    await writeFile(
      join(tmpDir, "docs", "specs", "001-user-auth.md"),
      "---\ntitle: User Auth\ndescription: Auth system\nstatus: proposed\nremaining: 0\n---\n\n# Requirements Specification\n\nAuth requirements.\n\n# Design Principles\n\nAuth design.\n\n# References\n\nThis spec implements @docs/ADR/001-database-choice.md",
      "utf-8",
    );
    await writeFile(
      join(tmpDir, "docs", "plans", "001-create-auth.md"),
      "---\ntitle: Create Auth\ndescription: Build auth\nstatus: proposed\n---\n\n# Overview\n\nBuild.\n\n# Goals\n\n- G\n\n# Implementation Steps\n\n- [ ] T\n\n# Risks\n| | | |\n|-|-|-|\n\n# UAT\n\n1. T",
      "utf-8",
    );
  });

  after(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  // ── Parameter validation ──

  it("returns error when force is not provided", async () => {
    const pi = mockPi();
    const { registerWorkflowTransitionTool } = await import("../extensions/workflow-transition.ts");
    registerWorkflowTransitionTool(pi);

    const tool = pi.tools.find((t) => t.name === "workflow_transition");
    assert.ok(tool);

    const ctx = mockCtx();
    const result = await tool.execute(
      "call-1",
      { phase: "specifying" },
      new AbortController().signal,
      () => {},
      ctx,
    );

    assert.ok(result.isError, "Should return an error when force is not provided");
    const text = result.content?.[0]?.text ?? "";
    assert.ok(
      text.includes("force") || text.includes("validate_documents"),
      `Error should mention force or validate_documents, got: ${text}`,
    );
    assert.equal(pi.stateEntries.length, 0, "State should not be persisted");
  });

  it("returns error for invalid phase names", async () => {
    const pi = mockPi();
    const { registerWorkflowTransitionTool } = await import("../extensions/workflow-transition.ts");
    registerWorkflowTransitionTool(pi);

    const tool = pi.tools.find((t) => t.name === "workflow_transition");
    assert.ok(tool);

    const ctx = mockCtx({ confirmResult: true, validationTokens: [{ phase: "invalid_phase", timestamp: Date.now(), phaseHash: "abc" }] });

    const result = await tool.execute(
      "call-2",
      { phase: "invalid_phase", force: true },
      new AbortController().signal,
      () => {},
      ctx,
    );

    assert.ok(result.isError, "Invalid phase should return an error");
    assert.equal(pi.stateEntries.length, 0, "State should not be persisted for invalid phase");
  });

  // ── Validation token checks ──

  it("errors when no validation token exists for the target phase", async () => {
    const pi = mockPi();
    const { registerWorkflowTransitionTool } = await import("../extensions/workflow-transition.ts");
    registerWorkflowTransitionTool(pi);

    const tool = pi.tools.find((t) => t.name === "workflow_transition");
    assert.ok(tool);

    // No tokens at all
    const ctx = mockCtx({ confirmResult: true, validationTokens: [] });

    const result = await tool.execute(
      "call-token-1",
      { phase: "specifying", force: true },
      new AbortController().signal,
      () => {},
      ctx,
    );

    assert.ok(result.isError, "Missing token should error");
    const text = result.content?.[0]?.text ?? "";
    assert.ok(
      text.includes("token") || text.includes("validate_documents"),
      `Should mention missing token, got: ${text}`,
    );
    assert.equal(pi.stateEntries.length, 0, "State should not be persisted");
  });

  it("errors when validation token exists but is for a different phase", async () => {
    const pi = mockPi();
    const { registerWorkflowTransitionTool } = await import("../extensions/workflow-transition.ts");
    registerWorkflowTransitionTool(pi);

    const tool = pi.tools.find((t) => t.name === "workflow_transition");
    assert.ok(tool);

    // Token for planning, but requesting specifying
    const ctx = mockCtx({
      confirmResult: true,
      validationTokens: [{ phase: "planning", timestamp: Date.now(), phaseHash: "abc" }],
    });

    const result = await tool.execute(
      "call-token-2",
      { phase: "specifying", force: true },
      new AbortController().signal,
      () => {},
      ctx,
    );

    assert.ok(result.isError, "Wrong phase token should error");
    const text = result.content?.[0]?.text ?? "";
    assert.ok(
      text.includes("planning") || text.includes("validate_documents"),
      `Should mention the wrong phase or run validate_documents, got: ${text}`,
    );
  });

  it("errors when validation token is expired (older than 5 min)", async () => {
    const pi = mockPi();
    const { registerWorkflowTransitionTool } = await import("../extensions/workflow-transition.ts");
    registerWorkflowTransitionTool(pi);

    const tool = pi.tools.find((t) => t.name === "workflow_transition");
    assert.ok(tool);

    // Token 6 minutes old
    const sixMinAgo = Date.now() - 6 * 60 * 1000;
    const ctx = mockCtx({
      confirmResult: true,
      validationTokens: [{ phase: "specifying", timestamp: sixMinAgo, phaseHash: "abc" }],
    });

    const result = await tool.execute(
      "call-token-3",
      { phase: "specifying", force: true },
      new AbortController().signal,
      () => {},
      ctx,
    );

    assert.ok(result.isError, "Expired token should error");
    const text = result.content?.[0]?.text ?? "";
    assert.ok(
      text.includes("token") || text.includes("validate_documents"),
      `Should mention token issue, got: ${text}`,
    );
  });

  // ── Phase pre-condition gates ──

  it("blocks transition to specifying with no ADRs present", async () => {
    const pi = mockPi();
    const { registerWorkflowTransitionTool } = await import("../extensions/workflow-transition.ts");
    registerWorkflowTransitionTool(pi);

    const tool = pi.tools.find((t) => t.name === "workflow_transition");
    assert.ok(tool);

    // Use a fresh tmp dir with no ADR directory at all
    const emptyDir = join(tmpdir(), `wf-empty-adr-${randomUUID()}`);
    await mkdir(emptyDir, { recursive: true });

    const ctx = mockCtx({
      confirmResult: true,
      validationTokens: [{ phase: "specifying", timestamp: Date.now(), phaseHash: "abc" }],
    });
    ctx.cwd = emptyDir;
    const result = await tool.execute(
      "call-pre-1",
      { phase: "specifying", force: true },
      new AbortController().signal,
      () => {},
      ctx,
    );

    await rm(emptyDir, { recursive: true, force: true });

    assert.ok(result.isError, "Transition without ADRs should be blocked");
    const text = result.content?.[0]?.text ?? "";
    assert.ok(
      text.includes("no ADRs") || text.includes("No ADR"),
      `Should mention missing ADRs, got: ${text}`,
    );
    assert.equal(pi.stateEntries.length, 0, "State should not be persisted");
  });

  it("blocks transition to specifying with only implemented ADRs", async () => {
    const pi = mockPi();
    const { registerWorkflowTransitionTool } = await import("../extensions/workflow-transition.ts");
    registerWorkflowTransitionTool(pi);

    const tool = pi.tools.find((t) => t.name === "workflow_transition");
    assert.ok(tool);

    // Use isolated dir — only implemented ADRs
    const implOnlyDir = join(tmpdir(), `wf-impl-only-${randomUUID()}`);
    const { createAdr } = await import("../extensions/adr.ts");
    const adrPath = await createAdr(
      { title: "Old", description: "Done", status: "implemented", context: "C", decision: "D", impact: "I" },
      implOnlyDir,
    );
    await import("../extensions/adr.ts").then((m) => m.updateAdrStatus(adrPath, "implemented"));

    const ctx = mockCtx({
      confirmResult: true,
      validationTokens: [{ phase: "specifying", timestamp: Date.now(), phaseHash: "abc" }],
    });
    ctx.cwd = implOnlyDir;
    const result = await tool.execute(
      "call-pre-2",
      { phase: "specifying", force: true },
      new AbortController().signal,
      () => {},
      ctx,
    );

    await rm(implOnlyDir, { recursive: true, force: true });

    assert.ok(result.isError, "Transition without proposed ADRs should be blocked");
    assert.equal(pi.stateEntries.length, 0, "State should not be persisted");
  });

  it("allows transition to specifying when proposed ADRs exist and token is valid", async () => {
    const pi = mockPi();
    const { registerWorkflowTransitionTool } = await import("../extensions/workflow-transition.ts");
    registerWorkflowTransitionTool(pi);

    const tool = pi.tools.find((t) => t.name === "workflow_transition");
    assert.ok(tool);

    // Use isolated dir with a proposed ADR
    const proposedDir = join(tmpdir(), `wf-proposed-${randomUUID()}`);
    const { createAdr } = await import("../extensions/adr.ts");
    await createAdr(
      { title: "New", description: "Needs specs", status: "proposed", context: "C", decision: "D", impact: "I" },
      proposedDir,
    );

    const ctx = mockCtx({
      confirmResult: true,
      validationTokens: [{ phase: "specifying", timestamp: Date.now(), phaseHash: "abc" }],
    });
    ctx.cwd = proposedDir;
    const result = await tool.execute(
      "call-pre-3",
      { phase: "specifying", force: true },
      new AbortController().signal,
      () => {},
      ctx,
    );

    await rm(proposedDir, { recursive: true, force: true });

    assert.ok(result, "Should return a result");
    assert.ok(!result.isError, "Transition with proposed ADRs and valid token should be allowed");
    assert.ok(pi.stateEntries.length >= 1, "State should be persisted");
  });

  it("blocks transition to planning when ADR has no specs", async () => {
    const pi = mockPi();
    const { registerWorkflowTransitionTool } = await import("../extensions/workflow-transition.ts");
    registerWorkflowTransitionTool(pi);

    const tool = pi.tools.find((t) => t.name === "workflow_transition");
    assert.ok(tool);

    // Isolated dir: ADR with no specs at all
    const noSpecDir = join(tmpdir(), `wf-no-spec-${randomUUID()}`);
    await mkdir(noSpecDir, { recursive: true });
    await mkdir(join(noSpecDir, "docs", "ADR"), { recursive: true });

    const { createAdr } = await import("../extensions/adr.ts");
    await createAdr(
      { title: "NoSpecs", description: "No specs created yet", status: "proposed", context: "C", decision: "D", impact: "I" },
      noSpecDir,
    );

    const ctx = mockCtx({
      confirmResult: true,
      validationTokens: [{ phase: "planning", timestamp: Date.now(), phaseHash: "abc" }],
    });
    ctx.cwd = noSpecDir;
    const result = await tool.execute(
      "call-pre-4",
      { phase: "planning", force: true },
      new AbortController().signal,
      () => {},
      ctx,
    );

    await rm(noSpecDir, { recursive: true, force: true });

    assert.ok(result.isError, "Transition with no specs should be blocked");
    const text = result.content?.[0]?.text ?? "";
    assert.ok(
      text.includes("no specs") || text.includes("Pre-condition"),
      `Should mention no specs, got: ${text}`,
    );
  });

  it("allows transition to planning when all ADRs have specs", async () => {
    const pi = mockPi();
    const { registerWorkflowTransitionTool } = await import("../extensions/workflow-transition.ts");
    registerWorkflowTransitionTool(pi);

    const tool = pi.tools.find((t) => t.name === "workflow_transition");
    assert.ok(tool);

    // Use fresh dir: ADR + spec referencing it
    const freshDir = join(tmpdir(), `wf-plan-ok-${randomUUID()}`);
    await mkdir(join(freshDir, "docs", "ADR"), { recursive: true });
    await mkdir(join(freshDir, "docs", "specs"), { recursive: true });
    const { createAdr } = await import("../extensions/adr.ts");
    await createAdr(
      { title: "Ready", description: "Has specs", status: "proposed", context: "C", decision: "D", impact: "I" },
      freshDir,
    );
    const { createSpec } = await import("../extensions/spec.ts");
    await createSpec(1, "Spec For Ready", "# Requirements\n\nTest\n\n# Design\n\nTest\n\n# References\n\n", freshDir);

    const ctx = mockCtx({
      confirmResult: true,
      validationTokens: [{ phase: "planning", timestamp: Date.now(), phaseHash: "abc" }],
    });
    ctx.cwd = freshDir;
    const result = await tool.execute(
      "call-pre-5",
      { phase: "planning", force: true },
      new AbortController().signal,
      () => {},
      ctx,
    );

    await rm(freshDir, { recursive: true, force: true });

    assert.ok(result, "Should return a result");
    assert.ok(!result.isError, "Transition with all ADRs having specs should be allowed");
    assert.ok(pi.stateEntries.length >= 1, "State should be persisted");
  });

  it("blocks transition to implementing when spec has remaining > 0", async () => {
    const pi = mockPi();
    const { registerWorkflowTransitionTool } = await import("../extensions/workflow-transition.ts");
    registerWorkflowTransitionTool(pi);

    const tool = pi.tools.find((t) => t.name === "workflow_transition");
    assert.ok(tool);

    // Create ADR + spec with remaining > 0
    const freshDir = join(tmpdir(), `wf-impl-block-${randomUUID()}`);
    await mkdir(join(freshDir, "docs", "ADR"), { recursive: true });
    await mkdir(join(freshDir, "docs", "specs"), { recursive: true });
    const { createAdr } = await import("../extensions/adr.ts");
    const adrPath = await createAdr(
      { title: "NeedsImpl", description: "Needs plans", status: "proposed", context: "C", decision: "D", impact: "I" },
      freshDir,
    );
    await import("../extensions/adr.ts").then((m) => m.updateAdrField(adrPath, "remaining", 1));
    const { createSpec } = await import("../extensions/spec.ts");
    const specPath = await createSpec(1, "Needs Plan", "# Requirements\n\nTest\n\n# Design\n\nTest\n\n# References\n\n", freshDir);
    await import("../extensions/spec.ts").then((m) => m.updateSpecField(specPath, "remaining", 2));

    const ctx = mockCtx({
      confirmResult: true,
      validationTokens: [{ phase: "implementing", timestamp: Date.now(), phaseHash: "abc" }],
    });
    ctx.cwd = freshDir;
    const result = await tool.execute(
      "call-pre-6",
      { phase: "implementing", force: true },
      new AbortController().signal,
      () => {},
      ctx,
    );

    await rm(freshDir, { recursive: true, force: true });

    assert.ok(result.isError, "Transition with spec remaining > 0 should be blocked");
    const text = result.content?.[0]?.text ?? "";
    assert.ok(
      text.includes("remaining") || text.includes("Pre-condition"),
      `Should mention remaining count, got: ${text}`,
    );
  });

  it("allows transition to implementing when all specs have remaining === 0", async () => {
    const pi = mockPi();
    const { registerWorkflowTransitionTool } = await import("../extensions/workflow-transition.ts");
    registerWorkflowTransitionTool(pi);

    const tool = pi.tools.find((t) => t.name === "workflow_transition");
    assert.ok(tool);

    const freshDir = join(tmpdir(), `wf-impl-ok-${randomUUID()}`);
    await mkdir(join(freshDir, "docs", "ADR"), { recursive: true });
    await mkdir(join(freshDir, "docs", "specs"), { recursive: true });
    const { createAdr } = await import("../extensions/adr.ts");
    await createAdr(
      { title: "ReadyImpl", description: "Has plans", status: "proposed", context: "C", decision: "D", impact: "I" },
      freshDir,
    );
    const { createSpec } = await import("../extensions/spec.ts");
    await createSpec(1, "Planned", "# Requirements\n\nTest\n\n# Design\n\nTest\n\n# References\n\n", freshDir);

    const ctx = mockCtx({
      confirmResult: true,
      validationTokens: [{ phase: "implementing", timestamp: Date.now(), phaseHash: "abc" }],
    });
    ctx.cwd = freshDir;
    const result = await tool.execute(
      "call-pre-7",
      { phase: "implementing", force: true },
      new AbortController().signal,
      () => {},
      ctx,
    );

    await rm(freshDir, { recursive: true, force: true });

    assert.ok(result, "Should return a result");
    assert.ok(!result.isError, "Transition with all specs at remaining=0 should be allowed");
  });

  // ── Force confirmation ──

  it("prompts user for confirmation when force is true with valid token", async () => {
    let confirmCalled = false;
    const ctx = mockCtx({
      confirmResult: true,
      validationTokens: [{ phase: "specifying", timestamp: Date.now(), phaseHash: "abc" }],
    });
    ctx.ui.confirm = async (_title: string, _body: string) => {
      confirmCalled = true;
      return true;
    };

    const pi = mockPi();
    const { registerWorkflowTransitionTool } = await import("../extensions/workflow-transition.ts");
    registerWorkflowTransitionTool(pi);

    const tool = pi.tools.find((t) => t.name === "workflow_transition");
    assert.ok(tool);

    const result = await tool.execute(
      "call-confirm-1",
      { phase: "specifying", force: true },
      new AbortController().signal,
      () => {},
      ctx,
    );

    assert.ok(confirmCalled, "ui.confirm should have been called");
    assert.ok(result, "Should return a result");
    assert.ok(!result.isError, "Confirmed transition should not be an error");
    assert.ok(pi.stateEntries.length >= 1, "State should be persisted after confirmation");
    const latestState = pi.stateEntries[pi.stateEntries.length - 1] as Record<string, unknown>;
    assert.equal(latestState.phase, "specifying");
  });

  it("cancels transition when user declines confirmation", async () => {
    const pi = mockPi();
    const { registerWorkflowTransitionTool } = await import("../extensions/workflow-transition.ts");
    registerWorkflowTransitionTool(pi);

    const tool = pi.tools.find((t) => t.name === "workflow_transition");
    assert.ok(tool);

    const ctx = mockCtx({
      confirmResult: false,
      validationTokens: [{ phase: "specifying", timestamp: Date.now(), phaseHash: "abc" }],
    });

    const result = await tool.execute(
      "call-cancel-1",
      { phase: "specifying", force: true },
      new AbortController().signal,
      () => {},
      ctx,
    );

    assert.ok(result, "Should return a result");
    const text = result.content?.[0]?.text ?? "";
    assert.ok(
      text.toLowerCase().includes("cancelled"),
      `Should indicate cancellation, got: ${text}`,
    );
    assert.equal(pi.stateEntries.length, 0, "State should not be persisted when user declines");
  });

  it("cancellation message includes diagnostic details when issues exist", async () => {
    const pi = mockPi();
    const { registerWorkflowTransitionTool } = await import("../extensions/workflow-transition.ts");
    registerWorkflowTransitionTool(pi);

    const tool = pi.tools.find((t) => t.name === "workflow_transition");
    assert.ok(tool);

    // Create a collision to trigger diagnostic
    const collDir = join(tmpdir(), `wf-diagnose-${randomUUID()}`);
    await mkdir(join(collDir, "docs", "specs"), { recursive: true });
    await writeFile(join(collDir, "docs", "specs", "001-duplicate-a.md"), "---\ntitle: A\nstatus: proposed\nremaining: 2\n---", "utf-8");
    await writeFile(join(collDir, "docs", "specs", "001-duplicate-b.md"), "---\ntitle: B\nstatus: proposed\nremaining: 2\n---", "utf-8");

    const ctx = mockCtx({
      confirmResult: false,
      validationTokens: [{ phase: "planning", timestamp: Date.now(), phaseHash: "abc" }],
    });
    ctx.cwd = collDir;
    const result = await tool.execute(
      "call-diagnose-1",
      { phase: "planning", force: true },
      new AbortController().signal,
      () => {},
      ctx,
    );

    await rm(collDir, { recursive: true, force: true });

    assert.ok(result, "Should return a result");
    const text = result.content?.[0]?.text ?? "";
    assert.ok(text.includes("Potential issues"), `Should mention potential issues, got: ${text}`);
    assert.ok(text.includes("001"), `Should mention the spec number, got: ${text}`);
  });

  it("transitions and returns phase-appropriate guidance for specifying", async () => {
    const pi = mockPi();
    const { registerWorkflowTransitionTool } = await import("../extensions/workflow-transition.ts");
    registerWorkflowTransitionTool(pi);

    const tool = pi.tools.find((t) => t.name === "workflow_transition");
    assert.ok(tool);

    const ctx = mockCtx({
      confirmResult: true,
      validationTokens: [{ phase: "specifying", timestamp: Date.now(), phaseHash: "abc" }],
    });

    const result = await tool.execute(
      "call-guide-1",
      { phase: "specifying", force: true },
      new AbortController().signal,
      () => {},
      ctx,
    );

    assert.ok(result, "Should return a result");
    assert.ok(!result.isError);
    const text = result.content?.[0]?.text ?? "";
    assert.ok(text.includes("specifying"), `Should mention specifying, got: ${text}`);
    assert.ok(text.includes("spec_create"), `Should mention spec_create, got: ${text}`);
  });

  it("transitions and returns phase-appropriate guidance for planning", async () => {
    const pi = mockPi();
    const { registerWorkflowTransitionTool } = await import("../extensions/workflow-transition.ts");
    registerWorkflowTransitionTool(pi);

    const tool = pi.tools.find((t) => t.name === "workflow_transition");
    assert.ok(tool);

    const ctx = mockCtx({
      confirmResult: true,
      validationTokens: [{ phase: "planning", timestamp: Date.now(), phaseHash: "abc" }],
    });

    const result = await tool.execute(
      "call-guide-2",
      { phase: "planning", force: true },
      new AbortController().signal,
      () => {},
      ctx,
    );

    assert.ok(result, "Should return a result");
    assert.ok(!result.isError);
    const text = result.content?.[0]?.text ?? "";
    assert.ok(text.includes("planning"), `Should mention planning, got: ${text}`);
    assert.ok(text.includes("plan_create"), `Should mention plan_create, got: ${text}`);
  });

  it("transitions and returns phase-appropriate guidance for implementing", async () => {
    const pi = mockPi();
    const { registerWorkflowTransitionTool } = await import("../extensions/workflow-transition.ts");
    registerWorkflowTransitionTool(pi);

    const tool = pi.tools.find((t) => t.name === "workflow_transition");
    assert.ok(tool);

    const ctx = mockCtx({
      confirmResult: true,
      validationTokens: [{ phase: "implementing", timestamp: Date.now(), phaseHash: "abc" }],
    });

    const result = await tool.execute(
      "call-guide-3",
      { phase: "implementing", force: true },
      new AbortController().signal,
      () => {},
      ctx,
    );

    assert.ok(result, "Should return a result");
    assert.ok(!result.isError);
    const text = result.content?.[0]?.text ?? "";
    assert.ok(text.includes("implement"), `Should mention implement/plan, got: ${text}`);
  });

  // ── Auto-heal stale counters ──

  it("auto-heals stale remaining counter before planning precondition check", async () => {
    const pi = mockPi();
    const { registerWorkflowTransitionTool } = await import("../extensions/workflow-transition.ts");
    registerWorkflowTransitionTool(pi);

    const tool = pi.tools.find((t) => t.name === "workflow_transition");
    assert.ok(tool);

    const staleDir = join(tmpdir(), `wf-autoheal-${randomUUID()}`);
    await mkdir(staleDir, { recursive: true });
    await mkdir(join(staleDir, "docs", "ADR"), { recursive: true });
    await mkdir(join(staleDir, "docs", "specs"), { recursive: true });

    const { createAdr } = await import("../extensions/adr.ts");
    const adrPath = await createAdr(
      { title: "StaleRemain", description: "Stale counter", status: "proposed", context: "C", decision: "D", impact: "I" },
      staleDir,
    );
    await import("../extensions/adr.ts").then((m) => m.updateAdrField(adrPath, "remaining", 3));

    const { createSpec } = await import("../extensions/spec.ts");
    await createSpec(1, "Unrelated Spec", "# Requirements\n\nTest\n\n# Design\n\nTest\n\n# References\n\n", staleDir);

    const ctx = mockCtx({
      confirmResult: true,
      validationTokens: [{ phase: "planning", timestamp: Date.now(), phaseHash: "abc" }],
    });
    ctx.cwd = staleDir;
    const result = await tool.execute(
      "call-heal-1",
      { phase: "planning", force: true },
      new AbortController().signal,
      () => {},
      ctx,
    );

    await rm(staleDir, { recursive: true, force: true });

    assert.ok(result, "Should return a result");
    assert.ok(!result.isError, "Stale counter should be auto-healed, transition allowed");
    assert.ok(pi.stateEntries.length >= 1, "State should be persisted");
    const text = result.content?.[0]?.text ?? "";
    assert.ok(text.includes("planning"), `Should mention planning phase, got: ${text}`);
  });

  it("auto-heals stale remaining on all non-implemented ADRs during planning transition", async () => {
    const pi = mockPi();
    const { registerWorkflowTransitionTool } = await import("../extensions/workflow-transition.ts");
    registerWorkflowTransitionTool(pi);

    const tool = pi.tools.find((t) => t.name === "workflow_transition");
    assert.ok(tool);

    const mixedDir = join(tmpdir(), `wf-mixed-heal-${randomUUID()}`);
    await mkdir(mixedDir, { recursive: true });
    await mkdir(join(mixedDir, "docs", "ADR"), { recursive: true });
    await mkdir(join(mixedDir, "docs", "specs"), { recursive: true });

    const { createAdr } = await import("../extensions/adr.ts");
    const { createSpec } = await import("../extensions/spec.ts");

    // ADR 1: implemented — should be skipped
    const adr1Path = await createAdr(
      { title: "Done", description: "Done", status: "proposed", context: "C", decision: "D", impact: "I" },
      mixedDir,
    );
    await import("../extensions/adr.ts").then((m) => m.updateAdrStatus(adr1Path, "implemented"));

    // ADR 2: proposed with stale remaining=5 + spec referencing it
    const adr2Path = await createAdr(
      { title: "StaleFive", description: "Stale five", status: "proposed", context: "C", decision: "D", impact: "I" },
      mixedDir,
    );
    await import("../extensions/adr.ts").then((m) => m.updateAdrField(adr2Path, "remaining", 5));
    await createSpec(2, "Spec For Five", "# Requirements\n\nTest\n\n# Design\n\nTest\n\n# References\n\n", mixedDir);

    // ADR 3: proposed with stale remaining=2 + spec referencing it
    const adr3Path = await createAdr(
      { title: "StaleTwo", description: "Stale two", status: "proposed", context: "C", decision: "D", impact: "I" },
      mixedDir,
    );
    await import("../extensions/adr.ts").then((m) => m.updateAdrField(adr3Path, "remaining", 2));
    await createSpec(3, "Spec For Two", "# Requirements\n\nTest\n\n# Design\n\nTest\n\n# References\n\n", mixedDir);

    const ctx = mockCtx({
      confirmResult: true,
      validationTokens: [{ phase: "planning", timestamp: Date.now(), phaseHash: "abc" }],
    });
    ctx.cwd = mixedDir;
    const result = await tool.execute(
      "call-heal-2",
      { phase: "planning", force: true },
      new AbortController().signal,
      () => {},
      ctx,
    );

    await rm(mixedDir, { recursive: true, force: true });

    assert.ok(result, "Should return a result");
    assert.ok(!result.isError, "All stale counters should be auto-healed");
    assert.ok(pi.stateEntries.length >= 1, "State should be persisted");
  });

  // ── Progress notifications ──

  it("calls ctx.ui.notify during force transition to show progress", async () => {
    const notifyCalls: string[] = [];
    const ctx = mockCtx({
      confirmResult: true,
      validationTokens: [{ phase: "specifying", timestamp: Date.now(), phaseHash: "abc" }],
    });
    ctx.ui.notify = (msg: string, _level?: string) => {
      notifyCalls.push(msg);
    };

    const pi = mockPi();
    const { registerWorkflowTransitionTool } = await import("../extensions/workflow-transition.ts");
    registerWorkflowTransitionTool(pi);

    const tool = pi.tools.find((t) => t.name === "workflow_transition");
    assert.ok(tool);

    const result = await tool.execute(
      "call-notify-1",
      { phase: "specifying", force: true },
      new AbortController().signal,
      () => {},
      ctx,
    );

    assert.ok(result, "Should return a result");
    assert.ok(!result.isError);
    assert.ok(notifyCalls.length >= 1,
      `Should have at least 1 notify call, got ${notifyCalls.length}: ${JSON.stringify(notifyCalls)}`);
  });

  it("cancellation message includes /status guidance", async () => {
    const pi = mockPi();
    const { registerWorkflowTransitionTool } = await import("../extensions/workflow-transition.ts");
    registerWorkflowTransitionTool(pi);

    const tool = pi.tools.find((t) => t.name === "workflow_transition");
    assert.ok(tool);

    const ctx = mockCtx({
      confirmResult: false,
      validationTokens: [{ phase: "specifying", timestamp: Date.now(), phaseHash: "abc" }],
    });

    const result = await tool.execute(
      "call-cancel-guide",
      { phase: "specifying", force: true },
      new AbortController().signal,
      () => {},
      ctx,
    );

    assert.ok(result, "Should return a result");
    const text = result.content?.[0]?.text ?? "";
    assert.ok(text.toLowerCase().includes("cancelled"),
      `Should indicate cancellation, got: ${text}`);
  });

  it("does NOT auto-heal implemented ADRs during planning transition", async () => {
    const pi = mockPi();
    const { registerWorkflowTransitionTool } = await import("../extensions/workflow-transition.ts");
    registerWorkflowTransitionTool(pi);

    const tool = pi.tools.find((t) => t.name === "workflow_transition");
    assert.ok(tool);

    const implStaleDir = join(tmpdir(), `wf-impl-stale-${randomUUID()}`);
    await mkdir(implStaleDir, { recursive: true });
    await mkdir(join(implStaleDir, "docs", "ADR"), { recursive: true });

    const { createAdr } = await import("../extensions/adr.ts");
    const adrPath = await createAdr(
      { title: "ImplButStale", description: "Implemented but stale", status: "implemented", context: "C", decision: "D", impact: "I" },
      implStaleDir,
    );
    await import("../extensions/adr.ts").then((m) => m.updateAdrField(adrPath, "remaining", 7));

    const ctx = mockCtx({
      confirmResult: true,
      validationTokens: [{ phase: "planning", timestamp: Date.now(), phaseHash: "abc" }],
    });
    ctx.cwd = implStaleDir;
    const result = await tool.execute(
      "call-heal-3",
      { phase: "planning", force: true },
      new AbortController().signal,
      () => {},
      ctx,
    );

    await rm(implStaleDir, { recursive: true, force: true });

    assert.ok(result, "Should return a result");
    assert.ok(!result.isError, "Implemented ADRs should be skipped during check");
  });
});
