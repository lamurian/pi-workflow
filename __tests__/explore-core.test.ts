import { describe, it } from "vitest";
import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
  parseFrontmatter,
  type ExtensionContext,
} from "@earendil-works/pi-coding-agent";

// ── Test utilities ───────────────────────────────────────────────────────────────

/** Resolve the package root from the test file location. */
const PACKAGE_ROOT = resolve(import.meta.dirname!, "..");

/**
 * Write an executable fake pi that records the `--model` ref it received
 * (one `MODEL=` line per spawn) and exits 0 without emitting messages.
 *
 * @param file - Path of the record file the fake appends to.
 * @returns Absolute path of the fake pi script.
 */
function fakePiModelRecorder(file: string): string {
  const dir = mkdtempSync(join(tmpdir(), "pi-scout-fake-"));
  const fake = join(dir, "fake-pi.sh");
  writeFileSync(
    fake,
    "#!/bin/sh\n" +
      'prev=""\nmodel="none"\n' +
      'for a in "$@"; do\n' +
      '  if [ "$prev" = "--model" ]; then model="$a"; fi\n' +
      '  prev="$a"\n' +
      "done\n" +
      'printf "MODEL=%s\\n" "$model" >> "$PI_ARGV_FILE"\n' +
      "exit 0\n",
  );
  chmodSync(fake, 0o755);
  return fake;
}

/**
 * Run `fn` with PI_BIN pinned to the argv-recording fake and PI_ARGV_FILE
 * set to `file` (truncated first); restores both env vars afterwards.
 *
 * @param file - Record file the fake appends one MODEL= line per spawn to.
 * @param fn   - Work to run under the pinned env.
 * @returns Whatever `fn` resolves to.
 */
async function withModelRecorder<T>(file: string, fn: () => Promise<T>): Promise<T> {
  const prevBin = process.env.PI_BIN;
  const prevFile = process.env.PI_ARGV_FILE;
  process.env.PI_BIN = fakePiModelRecorder(file);
  process.env.PI_ARGV_FILE = file;
  writeFileSync(file, "");
  try {
    return await fn();
  } finally {
    if (prevBin === undefined) delete process.env.PI_BIN;
    else process.env.PI_BIN = prevBin;
    if (prevFile === undefined) delete process.env.PI_ARGV_FILE;
    else process.env.PI_ARGV_FILE = prevFile;
  }
}

/** Create a mock ExtensionContext with configurable model availability. */
function mockCtx(
  cwd: string,
  overrides: Partial<ExtensionContext> = {},
): ExtensionContext {
  return {
    cwd,
    sessionManager: {
      getBranch: () => [],
      getSessionFile: () => null,
    },
    ui: {
      notify: () => {},
      setStatus: () => {},
      setWidget: () => {},
      theme: { fg: () => "" },
      addAutocompleteProvider: () => {},
      confirm: async () => true,
      select: async () => null,
      input: async () => "",
      custom: async () => null,
      editor: async () => "",
      setEditorText: () => {},
      setTitle: () => {},
    },
    mode: "tui",
    hasUI: true,
    model: { provider: "anthropic", id: "claude-sonnet-4-5" },
    modelRegistry: {
      getApiKeyAndHeaders: async () => ({
        ok: true,
        apiKey: "test-key",
        headers: {},
      }),
    },
    signal: undefined as AbortSignal | undefined,
    ...overrides,
  } as unknown as ExtensionContext;
}

// ═══════════════════════════════════════════════════════════════════════════════
// Content files
// ═══════════════════════════════════════════════════════════════════════════════

describe("explore content files", () => {
  it("scout.md exists in content/agents/ with valid frontmatter", async () => {
    const filePath = resolve(PACKAGE_ROOT, "content", "agents", "scout.md");
    const content = await readFile(filePath, "utf-8");
    const { frontmatter, body } = parseFrontmatter(content);

    assert.equal(frontmatter.name, "scout");
    assert.ok(frontmatter.description, "scout.md should have a description");
    assert.ok(frontmatter.tools, "scout.md should specify tools");
    assert.equal(frontmatter.model, undefined, "scout.md should NOT specify a model — use user's default");
    assert.ok(body.length > 50, "scout.md body should contain system prompt instructions");
    assert.match(
      body,
      /ls.*find.*grep.*read|ls.*grep.*read|ls.*find/is,
      "strategy should instruct efficient tool order: ls -> find -> grep -> read",
    );
  });

  it("explore-decompose.md exists and is substantial", async () => {
    const filePath = resolve(PACKAGE_ROOT, "content", "explore-decompose.md");
    const content = await readFile(filePath, "utf-8");
    assert.ok(content.length > 100, "decompose prompt should be substantial");
    assert.match(content, /JSON array/i, "should instruct to return JSON");
  });

  it("explore-synthesis.md exists and is substantial", async () => {
    const filePath = resolve(PACKAGE_ROOT, "content", "explore-synthesis.md");
    const content = await readFile(filePath, "utf-8");
    assert.ok(content.length > 100, "synthesis prompt should be substantial");
    assert.match(content, /summary|synthesis/i, "should instruct to produce a summary");
  });

  it("explore-synthesis.md forbids fabricating file paths", async () => {
    const filePath = resolve(PACKAGE_ROOT, "content", "explore-synthesis.md");
    const content = await readFile(filePath, "utf-8");
    assert.match(
      content,
      /never\s+invent|do not fabricate|fabricat/i,
      "synthesis prompt must forbid inventing file paths",
    );
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// Agent discovery
// ═══════════════════════════════════════════════════════════════════════════════

describe("discoverEmbeddedAgents", () => {
  it("discovers scout agent from content/agents/ directory", async () => {
    const { discoverEmbeddedAgents } = await import("../extensions/scout-runner.ts");
    const agents = discoverEmbeddedAgents(PACKAGE_ROOT);

    assert.ok(agents.length >= 1, "should discover at least one agent");
    const scout = agents.find((a: { name: string }) => a.name === "scout");
    assert.ok(scout, "should discover the scout agent");
    assert.equal(scout.source, "embedded");
    assert.equal(scout.tools?.join(","), "read,grep,find,ls,bash");
    assert.ok(scout.systemPrompt.length > 50, "scout should have a system prompt");
  });

  it("returns agent with correct AgentConfig shape", async () => {
    const { discoverEmbeddedAgents } = await import("../extensions/scout-runner.ts");
    const agents = discoverEmbeddedAgents(PACKAGE_ROOT);
    const scout = agents.find((a: { name: string }) => a.name === "scout");
    assert.ok(scout);
    assert.equal(typeof scout.name, "string");
    assert.equal(typeof scout.description, "string");
    assert.equal(typeof scout.systemPrompt, "string");
    assert.equal(typeof scout.filePath, "string");
    assert.ok(Array.isArray(scout.tools));
    assert.ok(typeof scout.model === "string" || scout.model === undefined);
  });

  it("returns empty array when agents directory does not exist", async () => {
    const { discoverEmbeddedAgents } = await import("../extensions/scout-runner.ts");
    const agents = discoverEmbeddedAgents("/nonexistent/path");
    assert.deepEqual(agents, []);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// Concurrency limiter
// ═══════════════════════════════════════════════════════════════════════════════

describe("mapWithConcurrencyLimit", () => {
  it("runs all items and returns results in order", async () => {
    const { mapWithConcurrencyLimit } = await import("../extensions/process-utils.ts");
    const input = [1, 2, 3, 4, 5];
    const results = await mapWithConcurrencyLimit(input, 2, async (n) => n * 2);
    assert.deepEqual(results, [2, 4, 6, 8, 10]);
  });

  it("respects max concurrency by tracking concurrent runs", async () => {
    const { mapWithConcurrencyLimit } = await import("../extensions/process-utils.ts");
    let maxConcurrent = 0;
    let currentConcurrent = 0;

    const results = await mapWithConcurrencyLimit(
      [1, 2, 3, 4, 5, 6, 7, 8],
      3,
      async (n) => {
        currentConcurrent++;
        maxConcurrent = Math.max(maxConcurrent, currentConcurrent);
        await new Promise((r) => setTimeout(r, 10));
        currentConcurrent--;
        return n;
      },
    );

    assert.equal(maxConcurrent, 3, "should not exceed concurrency limit of 3");
    assert.deepEqual(results, [1, 2, 3, 4, 5, 6, 7, 8]);
  });

  it("handles empty input", async () => {
    const { mapWithConcurrencyLimit } = await import("../extensions/process-utils.ts");
    const results = await mapWithConcurrencyLimit([], 4, async (n) => n);
    assert.deepEqual(results, []);
  });

  it("handles single item", async () => {
    const { mapWithConcurrencyLimit } = await import("../extensions/process-utils.ts");
    const results = await mapWithConcurrencyLimit([42], 4, async (n) => n);
    assert.deepEqual(results, [42]);
  });

  it("when concurrency > items, still works", async () => {
    const { mapWithConcurrencyLimit } = await import("../extensions/process-utils.ts");
    const results = await mapWithConcurrencyLimit([1, 2], 10, async (n) => n);
    assert.deepEqual(results, [1, 2]);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// T2 — session model threading into scout spawns
// ═══════════════════════════════════════════════════════════════════════════════

describe("runScoutSubprocess model threading (T2)", () => {
  it("starts the scout child with --model <provider>/<id> when a model ref is given", async () => {
    const { runScoutSubprocess, discoverEmbeddedAgents } = await import(
      "../extensions/scout-runner.ts"
    );
    const scout = discoverEmbeddedAgents(PACKAGE_ROOT).find((a) => a.name === "scout")!;
    assert.ok(scout, "scout agent must be discovered");
    const file = join(mkdtempSync(join(tmpdir(), "pi-model-ref-")), "argv.txt");

    await withModelRecorder(file, async () => {
      await runScoutSubprocess(
        scout,
        "find auth code",
        "/tmp",
        undefined,
        undefined,
        "anthropic/claude-sonnet-4-5",
      );
    });

    assert.equal(
      readFileSync(file, "utf8").trim(),
      "MODEL=anthropic/claude-sonnet-4-5",
      "the scout child must receive --model <provider>/<id>",
    );
  });

  it("records no --model in the scout argv when no model ref is given", async () => {
    const { runScoutSubprocess, discoverEmbeddedAgents } = await import(
      "../extensions/scout-runner.ts"
    );
    const scout = discoverEmbeddedAgents(PACKAGE_ROOT).find((a) => a.name === "scout")!;
    const file = join(mkdtempSync(join(tmpdir(), "pi-model-ref-")), "argv.txt");

    await withModelRecorder(file, async () => {
      await runScoutSubprocess(scout, "find auth code", "/tmp");
    });

    assert.equal(readFileSync(file, "utf8").trim(), "MODEL=none", "no --model without a model ref");
  });
});

describe("runParallelExploration model threading (T2)", () => {
  it("forwards the model ref so every spawned scout child carries --model in its argv", async () => {
    const { runParallelExploration } = await import("../extensions/explore-core.ts");
    const file = join(mkdtempSync(join(tmpdir(), "pi-model-ref-")), "argv.txt");

    await withModelRecorder(file, async () => {
      const results = await runParallelExploration(
        [
          { agent: "scout", task: "list files" },
          { agent: "scout", task: "find config" },
        ],
        "/tmp",
        undefined,
        undefined,
        "anthropic/claude-sonnet-4-5",
      );
      assert.equal(results.length, 2, "both tasks must return results");
      assert.ok(
        results.every((r) => r.exitCode === 0),
        `both scouts must spawn successfully: ${JSON.stringify(results.map((r) => r.errorMessage))}`,
      );
    });

    const lines = readFileSync(file, "utf8").trim().split("\n").filter(Boolean);
    assert.equal(lines.length, 2, "both scout children must spawn");
    assert.deepEqual(
      lines,
      ["MODEL=anthropic/claude-sonnet-4-5", "MODEL=anthropic/claude-sonnet-4-5"],
      "every spawned scout carries the session model ref",
    );
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// runParallelExploration — progress reporting
// ═══════════════════════════════════════════════════════════════════════════════

describe("runParallelExploration", () => {
  it("calls _onUpdate after each scout completes", async () => {
    const { runParallelExploration } = await import("../extensions/explore-core.ts");

    const tasks = [
      { agent: "scout", task: "list files in src/" },
      { agent: "scout", task: "find config files" },
    ];

    const updates: Array<Array<{ exitCode: number }>> = [];
    const signal = AbortSignal.abort();

    await runParallelExploration(
      tasks,
      process.cwd(),
      signal,
      (partial) => {
        updates.push([...partial]);
      },
    );

    assert.equal(updates.length, 2, "should call _onUpdate once per task");

    // First update: exactly 1 task completed (exitCode >= 0)
    const firstDone = updates[0].filter((r) => r.exitCode >= 0).length;
    assert.equal(firstDone, 1, "first callback should report 1 completed task");

    // Last (second) update: all tasks completed
    const lastDone = updates[updates.length - 1].filter((r) => r.exitCode >= 0).length;
    assert.equal(lastDone, 2, "last callback should report all tasks completed");
  });

  it("returns results for all tasks even when _onUpdate not provided", async () => {
    const { runParallelExploration } = await import("../extensions/explore-core.ts");

    const tasks = [
      { agent: "scout", task: "find auth handlers" },
    ];

    const results = await runParallelExploration(
      tasks,
      process.cwd(),
      AbortSignal.abort(),
    );

    assert.equal(results.length, 1, "should return result for the task");
    assert.ok(results[0].exitCode !== undefined, "result should have an exitCode");
  });

  it("records exitCode 1 and a descriptive errorMessage for killed scouts", async () => {
    const { runParallelExploration } = await import("../extensions/explore-core.ts");

    const tasks = [
      { agent: "scout", task: "find auth handlers" },
    ];

    // An already-aborted signal kills the scout immediately (no real pi run).
    const results = await runParallelExploration(
      tasks,
      process.cwd(),
      AbortSignal.abort(),
    );

    assert.equal(results[0].exitCode, 1, "killed scout should not be reported as success");
    assert.ok(
      results[0].errorMessage && results[0].errorMessage.length > 0,
      "killed scout should carry a descriptive errorMessage",
    );
  });

  it("returns empty array for empty tasks", async () => {
    const { runParallelExploration } = await import("../extensions/explore-core.ts");
    const results = await runParallelExploration(
      [],
      process.cwd(),
      AbortSignal.abort(),
      () => {},
    );
    assert.deepEqual(results, []);
  });

});

// ═══════════════════════════════════════════════════════════════════════════════
// createLoader — progress indicator
// ═══════════════════════════════════════════════════════════════════════════════

describe("createLoader", () => {
  it("update writes spinner text to stderr", async () => {
    const { createLoader } = await import("../extensions/explore-core.ts");

    const written: string[] = [];
    const origWrite = process.stderr.write.bind(process.stderr);
    process.stderr.write = (chunk: any) => {
      written.push(String(chunk));
      return true;
    };

    try {
      const loader = createLoader("test exploration");
      loader.update("3/5 scouts complete");
      loader.done();

      assert.ok(written.length >= 1, "should have written to stderr at least once");
      assert.match(written[0], /scouts complete/, "output should contain progress text");
    } finally {
      process.stderr.write = origWrite;
    }
  });

  it("done clears the interval and writes final newline", async () => {
    const { createLoader } = await import("../extensions/explore-core.ts");

    const written: string[] = [];
    const origWrite = process.stderr.write.bind(process.stderr);
    process.stderr.write = (chunk: any) => {
      written.push(String(chunk));
      return true;
    };

    try {
      const loader = createLoader("test");
      loader.update("processing");
      loader.done();

      // After done(), the last write should contain a newline
      const lastWrite = written[written.length - 1];
      assert.ok(lastWrite?.endsWith("\n"), "done() should write a final newline");
    } finally {
      process.stderr.write = origWrite;
    }
  });

  it("returns spinner loader object with update and done methods (and cleans up interval)", async () => {
    const { createLoader } = await import("../extensions/explore-core.ts");
    const loader = createLoader("test");

    assert.equal(typeof loader.update, "function");
    assert.equal(typeof loader.done, "function");

    // Must call done() to clear the internal setInterval, otherwise
    // the dangling interval keeps the event loop alive indefinitely,
    // causing the test suite to hang for the full test timeout (~30s).
    loader.done();
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// decomposeInstruction — fallback behavior
// ═══════════════════════════════════════════════════════════════════════════════

describe("decomposeInstruction", () => {
  it("returns fallback single task when model is null", async () => {
    const { decomposeInstruction } = await import("../extensions/explore-core.ts");
    const ctx = mockCtx("/tmp/test", {
      model: null as unknown as ExtensionContext["model"],
    });
    const tasks = await decomposeInstruction("find auth code", ctx);

    assert.equal(tasks.length, 1);
    assert.equal(tasks[0].agent, "scout");
    assert.ok(tasks[0].task.includes("auth"), "fallback task should reference the instruction");
  });

  it("returns fallback single task when auth fails", async () => {
    const { decomposeInstruction } = await import("../extensions/explore-core.ts");
    const ctx = mockCtx("/tmp/test", {
      modelRegistry: {
        getApiKeyAndHeaders: async () => ({ ok: false, error: "No API key" }),
      },
    });
    const tasks = await decomposeInstruction("find config files", ctx);

    assert.equal(tasks.length, 1);
    assert.equal(tasks[0].agent, "scout");
    assert.ok(tasks[0].task.includes("config"), "fallback should reference instruction");
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// synthesizeResults — fallback behavior
// ═══════════════════════════════════════════════════════════════════════════════

describe("synthesizeResults", () => {
  it("returns fallback summary when model is null", async () => {
    const { synthesizeResults } = await import("../extensions/explore-synthesis.ts");
    const ctx = mockCtx("/tmp/test", {
      model: null as unknown as ExtensionContext["model"],
    });
    const results = [
      {
        agent: "scout",
        task: "search for auth patterns",
        output: "## Files Examined\n- `src/auth/login.ts`",
        usage: { input: 100, output: 50, cost: 0.002, turns: 2 },
        exitCode: 0,
      },
    ];

    const summary = await synthesizeResults("find auth code", results, ctx);
    assert.ok(summary.length > 10, "summary should be non-trivial");
    assert.match(summary, /auth/i, "summary should reference the topic");
    assert.match(summary, /src\/auth/, "summary should include file paths");
  });

  it("includes partial results when some scouts failed", async () => {
    const { synthesizeResults } = await import("../extensions/explore-synthesis.ts");
    const ctx = mockCtx("/tmp/test", {
      model: null as unknown as ExtensionContext["model"],
    });
    const results = [
      {
        agent: "scout",
        task: "search src/",
        output: "## Files Examined\n- `src/main.ts`",
        usage: { input: 100, output: 50, cost: 0.002, turns: 2 },
        exitCode: 0,
      },
      {
        agent: "scout",
        task: "search docs/",
        output: "",
        usage: { input: 50, output: 0, cost: 0.001, turns: 1 },
        exitCode: 1,
        errorMessage: "Process exited with code 1",
      },
    ];

    const summary = await synthesizeResults("find code", results, ctx);
    assert.ok(summary.length > 10);
    assert.match(summary, /search docs/, "should mention failed task");
  });

  it("fallback summary includes file paths from succeeded scouts", async () => {
    const { synthesizeResults } = await import("../extensions/explore-synthesis.ts");
    const ctx = mockCtx("/tmp/test", {
      model: null as unknown as ExtensionContext["model"],
    });
    const results = [
      {
        agent: "scout",
        task: "find auth handlers",
        output: "## Files Examined\n- `src/handlers/auth.ts`\n- `src/middleware/auth.ts`",
        usage: { input: 100, output: 50, cost: 0.002, turns: 2 },
        exitCode: 0,
      },
    ];

    const summary = await synthesizeResults("find auth", results, ctx);
    assert.match(summary, /src\/handlers\/auth\.ts/);
    assert.match(summary, /src\/middleware\/auth\.ts/);
  });

  it("returns an explicit no-output summary when ALL scouts produced nothing (skips LLM)", async () => {
    const { synthesizeResults } = await import("../extensions/explore-synthesis.ts");

    const ctx = mockCtx("/tmp/test", {
      modelRegistry: {
        // If the LLM is (wrongly) called, this throws and fails the test.
        getApiKeyAndHeaders: async () => {
          throw new Error("LLM should not be called when every scout is empty/failed");
        },
      },
    });

    const results = [
      {
        agent: "scout",
        task: "read page.tsx",
        output: "",
        usage: { input: 100, output: 0, cost: 0, turns: 1 },
        exitCode: 0,
      },
      {
        agent: "scout",
        task: "list fab/",
        output: "   \n  ",
        usage: { input: 50, output: 0, cost: 0, turns: 1 },
        exitCode: 0,
      },
      {
        agent: "scout",
        task: "read api",
        output: "",
        usage: { input: 50, output: 0, cost: 0, turns: 1 },
        exitCode: 1,
        errorMessage: "Operation timed out after 120000ms",
      },
    ];

    const summary = await synthesizeResults("read the files", results, ctx);

    assert.match(
      summary,
      /no scout produced output/i,
      "summary must state explicitly that no scout produced output",
    );
    assert.doesNotMatch(
      summary,
      /`[^`]+`/,
      "summary must not fabricate backtick file paths",
    );
    assert.match(summary, /timed out/i, "failed tasks should still be surfaced");
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// Integration: phase prompts include exploration guideline
// ═══════════════════════════════════════════════════════════════════════════════

describe("phase prompts include exploration guideline", () => {
  it("phase-discussing.md mentions the explore tool", async () => {
    const { loadContent } = await import("../extensions/utils.ts");
    const content = await loadContent("phase-discussing.md");
    assert.match(content, /explore/i, "discuss phase should mention the explore tool");
  });
});
