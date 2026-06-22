import { describe, it } from "node:test";
import assert from "node:assert/strict";
import type { AgentConfig } from "../extensions/subagent-runner.ts";

// ═══════════════════════════════════════════════════════════════════════════════
// createTimeoutSignal — combined timeout + parent signal
// ═══════════════════════════════════════════════════════════════════════════════

describe("createTimeoutSignal", () => {
  it("creates signal that aborts after timeout", async () => {
    const { createTimeoutSignal } = await import("../extensions/subagent-runner.ts");
    const { signal, clear } = createTimeoutSignal(10);

    // Before timeout: signal is not aborted
    assert.equal(signal.aborted, false, "signal should not be aborted before timeout");

    // Wait for timeout to fire
    await new Promise((r) => setTimeout(r, 20));

    assert.equal(signal.aborted, true, "signal should be aborted after timeout");
    clear(); // clean up
  });

  it("clear prevents the timeout from firing", async () => {
    const { createTimeoutSignal } = await import("../extensions/subagent-runner.ts");
    const { signal, clear } = createTimeoutSignal(10);

    clear(); // cancel before timeout
    await new Promise((r) => setTimeout(r, 20));

    assert.equal(signal.aborted, false, "signal should NOT be aborted after clear");
  });

  it("immediately aborts when parent signal is already aborted", async () => {
    const { createTimeoutSignal } = await import("../extensions/subagent-runner.ts");
    const parent = AbortSignal.abort();
    const { signal, clear } = createTimeoutSignal(10_000, parent);

    assert.equal(signal.aborted, true, "signal should be aborted when parent is already aborted");
    clear();
  });

  it("aborts when parent signal aborts before timeout", async () => {
    const { createTimeoutSignal } = await import("../extensions/subagent-runner.ts");
    const controller = new AbortController();
    const { signal, clear } = createTimeoutSignal(10_000, controller.signal);

    assert.equal(signal.aborted, false, "signal should not be aborted yet");

    controller.abort(new Error("cancelled"));
    assert.equal(signal.aborted, true, "signal should abort when parent aborts");
    clear();
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// buildScoutArgs — constructs argv for scout subprocess
// ═══════════════════════════════════════════════════════════════════════════════

describe("buildScoutArgs", () => {
  it("includes lean flags: --no-extensions --no-skills --no-context-files --offline", async () => {
    const { buildScoutArgs } = await import("../extensions/subagent-runner.ts");

    const agent: AgentConfig = {
      name: "test-agent",
      description: "Test",
      tools: ["read", "grep"],
      systemPrompt: "Be a test",
      source: "embedded",
      filePath: "/fake/path.md",
    };

    const args = buildScoutArgs(agent, "find auth code");

    assert.ok(args.includes("--no-extensions"), "should skip extension loading");
    assert.ok(args.includes("--no-skills"), "should skip skill discovery");
    assert.ok(args.includes("--no-context-files"), "should skip AGENTS.md loading");
    assert.ok(args.includes("--offline"), "should skip network ops");
  });

  it("does NOT pass --model flag (uses user default)", async () => {
    const { buildScoutArgs } = await import("../extensions/subagent-runner.ts");

    const agent: AgentConfig = {
      name: "test-agent",
      description: "Test",
      tools: ["read", "grep"],
      systemPrompt: "Be a test",
      source: "embedded",
      filePath: "/fake/path.md",
    };

    const args = buildScoutArgs(agent, "find auth code");

    assert.ok(!args.includes("--model"), "should not force a model — use user default");
  });

  it("preserves required flags: --mode json -p --no-session", async () => {
    const { buildScoutArgs } = await import("../extensions/subagent-runner.ts");

    const agent: AgentConfig = {
      name: "test-agent",
      description: "Test",
      tools: ["read", "grep"],
      systemPrompt: "Be a test",
      source: "embedded",
      filePath: "/fake/path.md",
    };

    const args = buildScoutArgs(agent, "find auth code");

    assert.ok(args.includes("--mode"), "should set json mode");
    assert.ok(args.includes("json"), "mode value should be json");
    assert.ok(args.includes("-p"), "should be non-interactive");
    assert.ok(args.includes("--no-session"), "should be ephemeral");
  });

  it("includes --tools when agent has tools defined", async () => {
    const { buildScoutArgs } = await import("../extensions/subagent-runner.ts");

    const agent: AgentConfig = {
      name: "test-agent",
      description: "Test",
      tools: ["read", "grep", "find"],
      systemPrompt: "Be a test",
      source: "embedded",
      filePath: "/fake/path.md",
    };

    const args = buildScoutArgs(agent, "find auth code");

    const toolsIdx = args.indexOf("--tools");
    assert.notEqual(toolsIdx, -1, "--tools should be present");
    assert.equal(args[toolsIdx + 1], "read,grep,find", "tools should be comma-joined");
  });

  it("includes --append-system-prompt with a file path when agent has systemPrompt", async () => {
    const { buildScoutArgs } = await import("../extensions/subagent-runner.ts");

    const agent: AgentConfig = {
      name: "test-agent",
      description: "Test",
      tools: [],
      systemPrompt: "You are a test agent.",
      source: "embedded",
      filePath: "/fake/path.md",
    };

    const args = buildScoutArgs(agent, "find auth code");

    const promptIdx = args.indexOf("--append-system-prompt");
    assert.notEqual(promptIdx, -1, "--append-system-prompt should be present");
    const promptArg = args[promptIdx + 1];
    assert.ok(
      typeof promptArg === "string" && promptArg.length > 0,
      "should have a prompt file path",
    );
  });

  it("appends the task as the final positional argument", async () => {
    const { buildScoutArgs } = await import("../extensions/subagent-runner.ts");

    const agent: AgentConfig = {
      name: "test-agent",
      description: "Test",
      tools: [],
      systemPrompt: "",
      source: "embedded",
      filePath: "/fake/path.md",
    };

    const args = buildScoutArgs(agent, "find auth code");

    assert.equal(args[args.length - 1], "Task: find auth code");
  });
});
