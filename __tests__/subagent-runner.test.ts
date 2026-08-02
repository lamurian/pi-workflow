import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
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

  it("includes --thinking minimal to cap scout latency", async () => {
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

    const thinkingIdx = args.indexOf("--thinking");
    assert.notEqual(thinkingIdx, -1, "--thinking should be present");
    assert.equal(args[thinkingIdx + 1], "minimal", "scouts inherit the user's high thinking level — pin it low");
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

  it("includes --append-system-prompt followed by the system prompt TEXT (not a file path)", async () => {
    const { buildScoutArgs } = await import("../extensions/subagent-runner.ts");

    const agent: AgentConfig = {
      name: "test-agent",
      description: "Test",
      tools: [],
      systemPrompt: "You are a test agent.\n\n### Files Examined\n- list files here",
      source: "embedded",
      filePath: "/fake/path.md",
    };

    const args = buildScoutArgs(agent, "find auth code");

    const promptIdx = args.indexOf("--append-system-prompt");
    assert.notEqual(promptIdx, -1, "--append-system-prompt should be present");
    assert.equal(
      args[promptIdx + 1],
      agent.systemPrompt,
      "value must be the literal system prompt text — the CLI flag takes text, not a file path",
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

// ═══════════════════════════════════════════════════════════════════════════════
// getScoutTimeoutMs — per-scout timeout resolution
// ═══════════════════════════════════════════════════════════════════════════════

describe("getScoutTimeoutMs", () => {
  it("defaults to 120000 when no env var is set", async () => {
    const { getScoutTimeoutMs } = await import("../extensions/subagent-runner.ts");
    assert.equal(getScoutTimeoutMs({}), 120_000, "default budget should be 120s");
  });

  it("honors PI_EXPLORE_TIMEOUT_MS when set", async () => {
    const { getScoutTimeoutMs } = await import("../extensions/subagent-runner.ts");
    assert.equal(
      getScoutTimeoutMs({ PI_EXPLORE_TIMEOUT_MS: "30000" }),
      30_000,
      "env override should win",
    );
  });

  it("falls back to the default for invalid values", async () => {
    const { getScoutTimeoutMs } = await import("../extensions/subagent-runner.ts");
    assert.equal(getScoutTimeoutMs({ PI_EXPLORE_TIMEOUT_MS: "abc" }), 120_000);
    assert.equal(getScoutTimeoutMs({ PI_EXPLORE_TIMEOUT_MS: "-5" }), 120_000);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// runScoutSubprocess — integration against a real pi binary
// ═══════════════════════════════════════════════════════════════════════════════

/** True when a real `pi` binary is reachable on PATH. */
function hasPiOnPath(): boolean {
  try {
    const r = spawnSync("pi", ["--version"], { stdio: "ignore", timeout: 8_000 });
    return r.error === undefined && r.status === 0;
  } catch {
    return false;
  }
}

describe("runScoutSubprocess integration (real pi)", () => {
  it(
    "extracts non-empty assistant text from a real pi subprocess",
    { skip: !hasPiOnPath() && "pi not on PATH" },
    async () => {
      const { runScoutSubprocess } = await import("../extensions/subagent-runner.ts");

      const agent: AgentConfig = {
        name: "scout",
        description: "Test",
        tools: [],
        systemPrompt: "Reply with only the single word OK and nothing else.",
        source: "embedded",
        filePath: "/fake/path.md",
      };

      // Under `node --test` getPiInvocation would spawn the test file itself;
      // force the real pi binary so the subprocess path is exercised end-to-end.
      const prev = process.env.PI_BIN;
      process.env.PI_BIN = "pi";
      try {
        const output = await runScoutSubprocess(
          agent,
          "Ignore this task",
          process.cwd(),
          undefined,
          30_000,
        );
        assert.ok(output.trim().length > 0, "expected non-empty assistant text");
      } finally {
        if (prev === undefined) delete process.env.PI_BIN;
        else process.env.PI_BIN = prev;
      }
    },
  );
});

// ═══════════════════════════════════════════════════════════════════════════════
// runScoutSubprocess — kill signal handling
// ═══════════════════════════════════════════════════════════════════════════════

describe("runScoutSubprocess kill handling", () => {
  it("rejects with the abort reason when killed by signal", async () => {
    const { runScoutSubprocess } = await import("../extensions/subagent-runner.ts");

    const agent: AgentConfig = {
      name: "test-agent",
      description: "Test",
      tools: [],
      systemPrompt: "",
      source: "embedded",
      filePath: "/fake/path.md",
    };

    await assert.rejects(
      runScoutSubprocess(agent, "test task", "/tmp", AbortSignal.abort()),
      /abort/i,
      "a signal-killed scout should reject with the abort reason, " +
        "not resolve with (no output)",
    );
  });
});
