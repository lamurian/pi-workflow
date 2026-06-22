import { describe, it, before, mock } from "node:test";
import assert from "node:assert/strict";
import { mkdir, writeFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import type {
  ExtensionAPI,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";

// ── Mock factories ───────────────────────────────────────────────────────────

function mockPi(): ExtensionAPI & { calls: Record<string, unknown[]> } {
  const calls: Record<string, unknown[]> = {};
  const record = (name: string) => {
    calls[name] = [];
    return (...args: unknown[]) => {
      calls[name]!.push(args);
    };
  };

  return {
    on: record("on") as ExtensionAPI["on"],
    registerCommand: record("registerCommand") as ExtensionAPI["registerCommand"],
    appendEntry: record("appendEntry") as ExtensionAPI["appendEntry"],
    sendUserMessage: record("sendUserMessage") as ExtensionAPI["sendUserMessage"],
    exec: async () => ({ stdout: "", stderr: "", exitCode: 0 }),
    calls,
  } as unknown as ExtensionAPI & { calls: typeof calls };
}

function mockCtx(cwd: string): ExtensionContext {
  return {
    cwd,
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

// ═══════════════════════════════════════════════════════════════════════════════
// runBrainstorming
// ═══════════════════════════════════════════════════════════════════════════════

describe("runBrainstorming", () => {
  before(async () => {
    // Set up mocks once for all tests in this suite
    mock.module("../extensions/architecture.ts", {
      namedExports: {
        ensureArchitectureMd: async () => {},
        addAdrToArchitecture: async () => {},
      },
    });

    mock.module("../extensions/detect-hooks.ts", {
      namedExports: {
        detectExistingHooks: async () => ({}),
      },
    });

    mock.module("../extensions/cross-ref.ts", {
      namedExports: {
        resolveCrossReferences: async () => ({ content: "", chain: [], errors: [] }),
      },
    });
  });

  it("sends a user message with deliverAs 'steer' in requirements phase", async () => {
    const { runBrainstorming } = await import("../extensions/brainstorm.ts");

    const pi = mockPi();
    const ctx = mockCtx("/tmp/test");

    await runBrainstorming("build a new API", pi, ctx);

    const sendCalls = pi.calls["sendUserMessage"] ?? [];
    assert.ok(sendCalls.length >= 1, "sendUserMessage should be called");

    const lastCall = sendCalls[sendCalls.length - 1] as [string, { deliverAs: string }];
    const opts = lastCall[1];
    assert.equal(opts.deliverAs, "steer");
  });

  it("prepends project initiation context when AGENTS.md is missing", async () => {
    const tmpDir = join(tmpdir(), `brainstorm-init-${randomUUID()}`);
    await mkdir(tmpDir, { recursive: true });

    try {
      const { runBrainstorming } = await import("../extensions/brainstorm.ts");

      const pi = mockPi();
      const ctx = mockCtx(tmpDir);

      await runBrainstorming("build a new API", pi, ctx);

      const sendCalls = pi.calls["sendUserMessage"] ?? [];
      assert.ok(sendCalls.length >= 1, "sendUserMessage should be called");

      const lastCall = sendCalls[sendCalls.length - 1] as [string, { deliverAs: string }];
      const message = lastCall[0];
      assert.ok(
        message.includes("AGENTS.md"),
        `Expected message to mention AGENTS.md, got: ${message.slice(0, 200)}`,
      );
      assert.ok(
        message.includes("Project Initiation"),
        `Expected message to mention project initiation, got: ${message.slice(0, 200)}`,
      );
      assert.ok(
        message.includes("project directories"),
        `Expected message to mention project directories, got: ${message.slice(0, 200)}`,
      );
    } finally {
      await rm(tmpDir, { recursive: true, force: true });
    }
  });

  // ── checkProjectInitiation (exported) ──

  it("omits src/ from required directories for pi packages", { timeout: 5000 }, async () => {
    const tmpDir = join(tmpdir(), `brainstorm-pi-pkg-${randomUUID()}`);
    await mkdir(tmpDir, { recursive: true });
    await writeFile(
      join(tmpDir, "package.json"),
      JSON.stringify({ name: "test-pkg", pi: { extensions: ["./extensions/index.ts"] } }),
      "utf-8",
    );

    const { checkProjectInitiation } = await import("../extensions/brainstorm.ts");
    const result = await checkProjectInitiation(tmpDir);

    assert.ok(result !== null, "Should return initiation context (AGENTS.md missing)");
    assert.ok(result.includes("AGENTS.md"), "Should mention missing AGENTS.md");
    assert.ok(result.includes("project directories"), "Should mention missing dirs");

    const missingMatch = result.match(/missing: ([^.]+)\./);
    if (missingMatch) {
      assert.ok(
        !missingMatch[1].includes("src"),
        `Should NOT require src/ for pi packages, missing list was: ${missingMatch[1]}`,
      );
    } else {
      assert.fail(`Could not find missing: list in: ${result.slice(0, 300)}`);
    }
    assert.ok(
      result.includes("docs/"),
      `Should mention docs/ directories, got: ${result.slice(0, 200)}`,
    );

    await rm(tmpDir, { recursive: true, force: true });
  }, 5000);

  it("includes src/ in required directories for non-pi packages", { timeout: 5000 }, async () => {
    const tmpDir = join(tmpdir(), `brainstorm-nonpi-${randomUUID()}`);
    await mkdir(tmpDir, { recursive: true });
    await writeFile(
      join(tmpDir, "package.json"),
      JSON.stringify({ name: "test-pkg", version: "1.0.0" }),
      "utf-8",
    );

    const { checkProjectInitiation } = await import("../extensions/brainstorm.ts");
    const result = await checkProjectInitiation(tmpDir);

    assert.ok(result !== null, "Should return initiation context (AGENTS.md missing)");
    const missingMatch = result.match(/missing: ([^.]+)\./);
    if (missingMatch) {
      assert.ok(
        missingMatch[1].includes("src"),
        `Should require src/ for non-pi packages, missing list was: ${missingMatch[1]}`,
      );
    } else {
      assert.fail(`Could not find missing: list in: ${result.slice(0, 300)}`);
    }

    await rm(tmpDir, { recursive: true, force: true });
  }, 5000);

  it("omits src/ when no package.json exists (plain project)", { timeout: 5000 }, async () => {
    const tmpDir = join(tmpdir(), `brainstorm-plain-${randomUUID()}`);
    await mkdir(tmpDir, { recursive: true });

    const { checkProjectInitiation } = await import("../extensions/brainstorm.ts");
    const result = await checkProjectInitiation(tmpDir);

    assert.ok(result !== null, "Should return initiation context (AGENTS.md missing)");
    const missingMatch = result.match(/missing: ([^.]+)\./);
    if (missingMatch) {
      assert.ok(
        missingMatch[1].includes("src"),
        `Should include src/ by default when no package.json, got: ${missingMatch[1]}`,
      );
    }

    await rm(tmpDir, { recursive: true, force: true });
  }, 5000);

  it("skips project initiation when AGENTS.md already exists", async () => {
    const tmpDir = join(tmpdir(), `brainstorm-skip-init-${randomUUID()}`);
    await mkdir(tmpDir, { recursive: true });
    await writeFile(join(tmpDir, "AGENTS.md"), "# Test Project\n\nThis is a test project.\n", "utf-8");

    try {
      const { runBrainstorming } = await import("../extensions/brainstorm.ts");

      const pi = mockPi();
      const ctx = mockCtx(tmpDir);

      await runBrainstorming("build a new API", pi, ctx);

      const sendCalls = pi.calls["sendUserMessage"] ?? [];
      assert.ok(sendCalls.length >= 1);

      const lastCall = sendCalls[sendCalls.length - 1] as [string, { deliverAs: string }];
      const message = lastCall[0];
      assert.ok(
        !message.includes("AGENTS.md"),
        `Expected message NOT to mention AGENTS.md when file exists, got: ${message.slice(0, 200)}`,
      );
    } finally {
      await rm(tmpDir, { recursive: true, force: true });
    }
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// isDocumentDir / isWithinLineLimit
// ═══════════════════════════════════════════════════════════════════════════════

describe("document path helpers", () => {
  it("identifies ADR directory paths", async () => {
    const { isDocumentDir } = await import("../extensions/brainstorm.ts");

    assert.equal(isDocumentDir("/project/docs/ADR/001-auth.md"), "adr");
    assert.equal(isDocumentDir("/project/docs/adr/001-auth.md"), "adr");
    assert.equal(isDocumentDir("/project/ADR/001-auth.md"), "adr");
    assert.equal(isDocumentDir("/project/docs/specs/002-api.md"), "spec");
    assert.equal(isDocumentDir("/project/docs/plans/003-task.md"), "plan");
    assert.equal(isDocumentDir("/project/src/index.ts"), null);
    assert.equal(isDocumentDir("/project/AGENTS.md"), null);
    assert.equal(isDocumentDir("/project/ARCHITECTURE.md"), null);
  });

  it("counts lines in content", async () => {
    const { countLines } = await import("../extensions/brainstorm.ts");

    assert.equal(countLines(""), 0);
    assert.equal(countLines("single line"), 1);
    assert.equal(countLines("line 1\nline 2\nline 3"), 3);
    assert.equal(countLines("line 1\n\nline 3"), 3);
    assert.equal(countLines("\n"), 2);
  });

  it("blocks content exceeding 100 lines", async () => {
    const { checkLineLimit } = await import("../extensions/brainstorm.ts");

    // 50 lines: ok
    const short = Array.from({ length: 50 }, (_, i) => `line ${i + 1}`).join("\n");
    assert.equal(checkLineLimit(short, "/path/to/file.md"), null);

    // Exactly 100 lines: ok (boundary)
    const exact = Array.from({ length: 100 }, (_, i) => `line ${i + 1}`).join("\n");
    assert.equal(checkLineLimit(exact, "/path/to/file.md"), null);

    // 101 lines: blocked
    const over = Array.from({ length: 101 }, (_, i) => `line ${i + 1}`).join("\n");
    const result = checkLineLimit(over, "/path/to/file.md");
    assert.ok(result !== null, "Expected a block reason for >100 lines");
    assert.ok(result!.includes("101"), `Expected line count in message, got: ${result}`);
    assert.ok(result!.includes("100"), `Expected limit mention, got: ${result}`);
  });
});
