import { afterEach, describe, it } from "vitest";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { partitionStagedPaths, resolveSlopTool } from "../extensions/slop-detect.ts";

// ─── Harness ──────────────────────────────────────────────────────────────────

const tempDirs: string[] = [];

afterEach(() => {
  while (tempDirs.length > 0) {
    rmSync(tempDirs.pop()!, { recursive: true, force: true });
  }
});

/** Fresh empty project root under the OS temp dir (registered for cleanup). */
function tmpCwd(): string {
  const dir = mkdtempSync(join(tmpdir(), "slop-detect-"));
  tempDirs.push(dir);
  return dir;
}

/** Create `<cwd>/node_modules/.bin/<bin>` as a stand-in executable file. */
function writeLocalBin(cwd: string, bin: string): string {
  const file = join(cwd, "node_modules", ".bin", bin);
  mkdirSync(join(cwd, "node_modules", ".bin"), { recursive: true });
  writeFileSync(file, "#!/bin/sh\n");
  return file;
}

/**
 * Mock ExtensionAPI whose exec answers `which <name>` lookups from a scripted
 * map (name → exit code; anything else exits 1). Every call is recorded so
 * tests can assert the detection mechanics.
 */
function mockPi(
  whichCodes: Record<string, number> = {},
): ExtensionAPI & { execCalls: Array<{ cmd: string; args: string[] }> } {
  const execCalls: Array<{ cmd: string; args: string[] }> = [];
  const pi = {
    exec: async (cmd: string, args: string[]) => {
      execCalls.push({ cmd, args });
      const code = cmd === "which" ? (whichCodes[args[0] ?? ""] ?? 1) : 1;
      return { stdout: "", stderr: "", code, killed: false };
    },
    execCalls,
  };
  return pi as unknown as ExtensionAPI & { execCalls: typeof execCalls };
}

// ─── partitionStagedPaths ─────────────────────────────────────────────────────

describe("partitionStagedPaths", () => {
  it("puts .ts .tsx .js .jsx .mjs .cjs .py .go .rs .rb .php .java .cs .c .cc .cpp .h .hpp paths in code", () => {
    const codePaths = [
      "src/a.ts",
      "src/b.tsx",
      "lib/c.js",
      "lib/d.jsx",
      "e.mjs",
      "f.cjs",
      "py/g.py",
      "h.go",
      "i.rs",
      "j.rb",
      "k.php",
      "L.java",
      "m.cs",
      "n.c",
      "o.cc",
      "p.cpp",
      "q.h",
      "r.hpp",
    ];
    const result = partitionStagedPaths([...codePaths, "README.md"]);

    assert.deepEqual(result.code, codePaths);
    assert.deepEqual(result.prose, ["README.md"]);
  });

  it("puts .md .mdx .txt paths in prose", () => {
    const prosePaths = ["README.md", "docs/guide.mdx", "notes.txt"];
    const result = partitionStagedPaths([...prosePaths, "src/a.ts"]);

    assert.deepEqual(result.prose, prosePaths);
    assert.deepEqual(result.code, ["src/a.ts"]);
  });

  it("ignores other paths such as package.json and image files", () => {
    const ignored = [
      "package.json",
      "tsconfig.json",
      "logo.png",
      "photo.jpg",
      "icon.svg",
      "Makefile",
    ];
    const result = partitionStagedPaths(ignored);

    assert.deepEqual(result.code, [], "no ignored path lands in code");
    assert.deepEqual(result.prose, [], "no ignored path lands in prose");
  });
});

// ─── resolveSlopTool ──────────────────────────────────────────────────────────

describe("resolveSlopTool", () => {
  it("returns [<cwd>/node_modules/.bin/<bin>] when that file exists", async () => {
    const cwd = tmpCwd();
    const localBin = writeLocalBin(cwd, "aislop");
    const pi = mockPi({}); // would exit 1 everywhere: local lookup must win

    const result = await resolveSlopTool(pi, cwd, "aislop", true);

    assert.deepEqual(result, [localBin]);
    assert.equal(
      pi.execCalls.length,
      0,
      "a local node_modules/.bin file short-circuits PATH probing",
    );
  });

  it("returns [<bin>] when no local bin exists and `which <bin>` exits 0", async () => {
    const cwd = tmpCwd();
    const pi = mockPi({ aislop: 0 });

    const result = await resolveSlopTool(pi, cwd, "aislop", false);

    assert.deepEqual(result, ["aislop"]);
    assert.deepEqual(pi.execCalls, [
      { cmd: "which", args: ["aislop"] },
    ]);
  });

  it('returns ["npx", "--yes", "<bin>@latest"] when not found locally or on PATH and fetchFallback is true', async () => {
    const cwd = tmpCwd();
    const pi = mockPi({}); // `which aislop` exits 1

    const result = await resolveSlopTool(pi, cwd, "aislop", true);

    assert.deepEqual(result, ["npx", "--yes", "aislop@latest"]);
  });

  it("returns null when not found locally or on PATH and fetchFallback is false", async () => {
    const cwd = tmpCwd();
    const pi = mockPi({});

    const result = await resolveSlopTool(pi, cwd, "aislop", false);

    assert.equal(result, null);
  });

  it("resolving zero-slop returns null when `which python3` exits non-zero, even with fetchFallback true", async () => {
    const cwd = tmpCwd();
    const pi = mockPi({ python3: 1, "zero-slop": 0 });

    const result = await resolveSlopTool(pi, cwd, "zero-slop", true);

    assert.equal(result, null);
  });

  it("zero-slop resolves normally when python3 is available", async () => {
    const cwd = tmpCwd();
    const pi = mockPi({ python3: 0, "zero-slop": 0 });

    const result = await resolveSlopTool(pi, cwd, "zero-slop", true);

    assert.deepEqual(result, ["zero-slop"]);
  });
});
