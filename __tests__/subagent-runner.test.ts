import { describe, it } from "vitest";
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
// T8 — getImplementerTimeoutMs — dedicated implementer budget
// ═══════════════════════════════════════════════════════════════════════════════

describe("getImplementerTimeoutMs (T8)", () => {
  it("defaults to 600000 — implementer units are far heavier than scouts", async () => {
    const { getImplementerTimeoutMs } = await import("../extensions/subagent-runner.ts");
    assert.equal(getImplementerTimeoutMs({}), 600_000);
  });

  it("honors PI_IMPLEMENT_TIMEOUT_MS when set", async () => {
    const { getImplementerTimeoutMs } = await import("../extensions/subagent-runner.ts");
    assert.equal(
      getImplementerTimeoutMs({ PI_IMPLEMENT_TIMEOUT_MS: "90000" }),
      90_000,
    );
  });

  it("is independent of PI_EXPLORE_TIMEOUT_MS (T8)", async () => {
    const { getImplementerTimeoutMs } = await import("../extensions/subagent-runner.ts");
    assert.equal(
      getImplementerTimeoutMs({ PI_EXPLORE_TIMEOUT_MS: "1000" }),
      600_000,
      "the scout budget must not leak into implementer units",
    );
  });

  it("falls back to the default for invalid values", async () => {
    const { getImplementerTimeoutMs } = await import("../extensions/subagent-runner.ts");
    assert.equal(getImplementerTimeoutMs({ PI_IMPLEMENT_TIMEOUT_MS: "abc" }), 600_000);
    assert.equal(getImplementerTimeoutMs({ PI_IMPLEMENT_TIMEOUT_MS: "-1" }), 600_000);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// T8 — unit-prompt.md contract
// ═══════════════════════════════════════════════════════════════════════════════

describe("content/unit-prompt.md contract (T8)", () => {
  it("states self-checks are optional, the gate is the main process, failures return as instructions", async () => {
    const { loadContent } = await import("../extensions/utils.ts");
    const prompt = await loadContent("unit-prompt.md");
    assert.match(prompt, /optional/i, "self-check test runs must be optional");
    assert.match(prompt, /main process/i, "the commit-hook gate is owned by the main process");
    assert.match(prompt, /return.*as instruction/i, "failures of any stage return as instructions");
    assert.match(prompt, /never commit|do NOT run `git commit`/i, "units must not commit");
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// runScoutSubprocess — integration against a real pi binary
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Live-LLM integration tests are opt-in. They spawn a real `pi` subprocess
 * and call a model, so they cannot finish inside the default unit-test
 * timeout and depend on network/auth. Enable with PI_RUN_INTEGRATION=1.
 */
const RUN_INTEGRATION = process.env.PI_RUN_INTEGRATION === "1";

describe("runScoutSubprocess integration (real pi)", () => {
  it(
    "extracts non-empty assistant text from a real pi subprocess",
    {
      skip:
        !RUN_INTEGRATION &&
        "integration test — set PI_RUN_INTEGRATION=1 to run against a live pi",
    },
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
// T5 — implementer subprocess argv builder and report parser
// ═══════════════════════════════════════════════════════════════════════════════

describe("buildImplementerArgs (T5/T8)", () => {
  const SYSTEM = "You are an implementation unit.";
  const TASK = "Implement behavior T3: add retry backoff.";

  it("includes the lean flag set", async () => {
    const { buildImplementerArgs } = await import("../extensions/subagent-runner.ts");
    const args = buildImplementerArgs(SYSTEM, TASK);

    assert.ok(args.includes("--mode") && args[args.indexOf("--mode") + 1] === "json");
    assert.ok(args.includes("-p"), "should be non-interactive");
    assert.ok(args.includes("--no-session"));
    assert.ok(args.includes("--no-extensions"));
    assert.ok(args.includes("--no-skills"));
    assert.ok(args.includes("--offline"));
    const t = args.indexOf("--thinking");
    assert.notEqual(t, -1);
    assert.equal(args[t + 1], "minimal");
  });

  it("restricts --tools to read,write,edit,bash (T8)", async () => {
    delete process.env.PI_IMPLEMENTER_TOOLS;
    const { buildImplementerArgs } = await import("../extensions/subagent-runner.ts");
    const args = buildImplementerArgs(SYSTEM, TASK);

    const idx = args.indexOf("--tools");
    assert.notEqual(idx, -1, "--tools should be present");
    assert.equal(args[idx + 1], "read,write,edit,bash");
    assert.doesNotMatch(
      args[idx + 1],
      /run_tests|mark_task_done|commit_changes|commit_amend/,
      "implementer must not receive workflow or commit tools",
    );
  });

  it("honors PI_IMPLEMENTER_TOOLS as a full override (T8)", async () => {
    process.env.PI_IMPLEMENTER_TOOLS = "read,write";
    try {
      const { buildImplementerArgs } = await import("../extensions/subagent-runner.ts");
      const args = buildImplementerArgs(SYSTEM, TASK);
      const idx = args.indexOf("--tools");
      assert.equal(args[idx + 1], "read,write", "env override must replace the default list");
    } finally {
      delete process.env.PI_IMPLEMENTER_TOOLS;
    }
  });

  it("sources --append-system-prompt from content/unit-prompt.md", async () => {
    const { buildImplementerArgs } = await import("../extensions/subagent-runner.ts");
    const { loadContent } = await import("../extensions/utils.ts");
    const unitPrompt = await loadContent("unit-prompt.md");

    const args = buildImplementerArgs(unitPrompt, TASK);

    const idx = args.indexOf("--append-system-prompt");
    assert.notEqual(idx, -1);
    assert.equal(args[idx + 1], unitPrompt, "must pass the literal unit prompt text");
  });

  it("appends the unit task text as the final positional argument", async () => {
    const { buildImplementerArgs } = await import("../extensions/subagent-runner.ts");
    const args = buildImplementerArgs(SYSTEM, TASK);
    assert.equal(args[args.length - 1], TASK);
  });
});

describe("parseImplementerReport (T5)", () => {
  function assistantEvent(text: string): string {
    return JSON.stringify({
      type: "message_end",
      message: { role: "assistant", content: [{ type: "text", text }] },
    });
  }

  it("extracts summary and suggestedCommit from the last assistant message", async () => {
    const { parseImplementerReport } = await import("../extensions/subagent-runner.ts");
    const stdout = [
      assistantEvent("First pass, still working."),
      assistantEvent(
        'Done.\n```json\n{"summary": "added retry backoff with jitter", "suggestedCommit": "feat(http): add retry backoff"}\n```',
      ),
    ].join("\n");

    const report = parseImplementerReport(stdout);

    assert.equal(report.summary, "added retry backoff with jitter");
    assert.equal(report.suggestedCommit, "feat(http): add retry backoff");
  });

  it("uses the final message when no JSON block is present", async () => {
    const { parseImplementerReport } = await import("../extensions/subagent-runner.ts");
    const stdout = assistantEvent("Implemented the behavior and tests pass.");

    const report = parseImplementerReport(stdout);

    assert.equal(report.summary, "Implemented the behavior and tests pass.");
    assert.equal(report.suggestedCommit, undefined);
  });

  it("tolerates malformed JSON lines between events", async () => {
    const { parseImplementerReport } = await import("../extensions/subagent-runner.ts");
    const stdout = [
      "{{{ not json",
      assistantEvent('ok\n```json\n{"summary": "touched one file", "suggestedCommit": "fix: handle null head"}\n```'),
      "}}} still not json",
    ].join("\n");

    const report = parseImplementerReport(stdout);

    assert.equal(report.summary, "touched one file");
    assert.equal(report.suggestedCommit, "fix: handle null head");
  });

  it("tolerates killed processes: empty and partial output do not throw", async () => {
    const { parseImplementerReport } = await import("../extensions/subagent-runner.ts");

    assert.deepEqual(parseImplementerReport(""), { summary: "" });
    assert.deepEqual(parseImplementerReport("\n\n"), { summary: "" });
    // Killed mid-write: truncated JSON event, no closing braces.
    const partial = assistantEvent("half a mess").slice(0, 25);
    assert.deepEqual(parseImplementerReport(partial), { summary: "" });
  });

  it("falls back to the whole message when the JSON block is malformed", async () => {
    const { parseImplementerReport } = await import("../extensions/subagent-runner.ts");
    const stdout = assistantEvent('Tried.\n```json\n{"summary": "broken\n```');

    const report = parseImplementerReport(stdout);

    assert.match(report.summary, /Tried\./);
    assert.equal(report.suggestedCommit, undefined);
  });
});


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

// ═══════════════════════════════════════════════════════════════════════════════
// T7 — subprocess diagnostics: spawn errors, stdout tails, named timeouts
// ═══════════════════════════════════════════════════════════════════════════════

describe("runRawPiProcess diagnostics (T7)", () => {
  it("reports the ENOENT message when PI_BIN names a missing binary", async () => {
    const { runRawPiProcess } = await import("../extensions/implementer-runner.ts");
    const prev = process.env.PI_BIN;
    process.env.PI_BIN = "/nonexistent/pi-binary-for-test";
    try {
      const res = await runRawPiProcess(["--version"], "/tmp", undefined, 5_000);
      assert.equal(res.exitCode, 1, "spawn failure resolves with a non-zero exit code");
      assert.match(
        res.stderr,
        /ENOENT|no such file/i,
        "spawn error message must be captured in stderr, not swallowed",
      );
    } finally {
      if (prev === undefined) delete process.env.PI_BIN;
      else process.env.PI_BIN = prev;
    }
  });

  it("names the timeout on stderr when the kill signal fires", async () => {
    const { runRawPiProcess } = await import("../extensions/implementer-runner.ts");
    const prev = process.env.PI_BIN;
    process.env.PI_BIN = "node";
    try {
      // node sleeps 60s; timeout 300ms → SIGKILL. Must settle promptly even
      // though the killed process is gone — a hung orchestrator is the exact
      // failure class this contract removes.
      const started = Date.now();
      const res = await runRawPiProcess(
        ["-e", "setTimeout(() => {}, 60000)"],
        "/tmp",
        undefined,
        300,
      );
      assert.equal(res.exitCode, 1, "killed process resolves non-zero");
      assert.match(
        res.stderr,
        /timed out after 300ms/,
        "timeout must be named explicitly so callers can distinguish it from hook/unit failures",
      );
      assert.ok(
        Date.now() - started < 5_000,
        "must settle promptly after the kill, not hang on lingering stdio pipes",
      );
    } finally {
      if (prev === undefined) delete process.env.PI_BIN;
      else process.env.PI_BIN = prev;
    }
  });
});

describe("runImplementerUnit diagnostics (T7)", () => {
  /** Write an executable fake pi: prints one assistant JSON event, then behaves per `tail`. */
  async function fakePi(tail: string): Promise<string> {
    const { writeFileSync, chmodSync, mkdtempSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const dir = mkdtempSync(join(tmpdir(), "pi-fake-"));
    const fake = join(dir, "fake-pi.sh");
    writeFileSync(
      fake,
      "#!/bin/sh\n" +
        "echo '{\"type\":\"message_end\",\"message\":{\"role\":\"assistant\",\"content\":[{\"type\":\"text\",\"text\":\"halfway there\"}]}}'\n" +
        tail,
    );
    chmodSync(fake, 0o755);
    return fake;
  }

  it("includes a stdout tail in the error when the unit exits non-zero", async () => {
    const { runImplementerUnit } = await import("../extensions/implementer-runner.ts");
    const prev = process.env.PI_BIN;
    process.env.PI_BIN = await fakePi("exit 3\n");
    try {
      const res = await runImplementerUnit("sys", "task", "/tmp", undefined, 5_000);
      assert.equal(typeof res.error, "string");
      assert.match(res.error!, /halfway there/, "error must carry a tail of captured stdout");
      assert.equal(res.summary, "halfway there", "parsed report survives alongside the error");
    } finally {
      if (prev === undefined) delete process.env.PI_BIN;
      else process.env.PI_BIN = prev;
    }
  });

  it("names timeouts and keeps the last assistant text when available", async () => {
    const { runImplementerUnit } = await import("../extensions/implementer-runner.ts");
    const prev = process.env.PI_BIN;
    process.env.PI_BIN = await fakePi("sleep 60\n");
    try {
      const res = await runImplementerUnit("sys", "task", "/tmp", undefined, 400);
      assert.match(res.error ?? "", /timed out after 400ms/, "timeout must be named");
      assert.match(res.summary, /halfway there/, "partial assistant text must survive the kill");
    } finally {
      if (prev === undefined) delete process.env.PI_BIN;
      else process.env.PI_BIN = prev;
    }
  });
});
