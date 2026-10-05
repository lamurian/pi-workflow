import { describe, it } from "vitest";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const PKG_PATH = new URL("../package.json", import.meta.url);
const README_PATH = new URL("../README.md", import.meta.url);

describe("package.json packaging", () => {
  it("should keep peerDependencies for pi core packages (pi docs recommend this)", async () => {
    const pkg = JSON.parse(await readFile(PKG_PATH, "utf-8"));
    assert.ok(
      pkg.peerDependencies,
      "peerDependencies should exist per pi package conventions. " +
        "Pi core packages (@earendil-works/*, typebox) go in peerDependencies with '*' range.",
    );
  });

  it("should retain fast-glob as a direct dependency", async () => {
    const pkg = JSON.parse(await readFile(PKG_PATH, "utf-8"));
    assert.ok(
      pkg.dependencies?.["fast-glob"],
      "fast-glob is a third-party dependency not provided by pi, so it must remain",
    );
  });
});

// ═══ README content assertions (T9) ═══
describe("README content assertions (T9)", () => {
  async function readme(): Promise<string> {
    return readFile(README_PATH, "utf-8");
  }

  it("documents the guard semantics: staged-diff inspection, immediate halt, no commit attempted", async () => {
    const content = await readme();
    assert.match(content, /staged-diff/i);
    assert.match(content, /test-guard/i);
    assert.match(content, /never invoked|no commit attempted|not invoked/i);
  });

  it("documents the files-allowlist contract rule", async () => {
    const content = await readme();
    assert.match(content, /files.*allowlist|allowlist.*files/i);
    assert.match(content, /superseded|obsolete/);
  });

  it("documents the red-baseline assumption with its halt signature", async () => {
    const content = await readme();
    assert.match(content, /red.baseline/i);
    assert.match(content, /signature/i);
    assert.match(content, /hook-rejected/);
  });

  it("documents the solo prompt-only asymmetry", async () => {
    const content = await readme();
    assert.match(content, /prompt.only|prompt discipline/i);
    assert.match(content, /solo/i);
  });

  it("describes the test-scan mechanism: advisory, confidence-tagged, never blocking", async () => {
    const content = await readme();
    assert.match(content, /test.scan|scan evidence/i);
    assert.match(content, /advisory/i);
    assert.match(content, /confidence.tag/i);
  });

  it("makes no false claims: extension never runs test commands; solo has no extension-level enforcement", async () => {
    const content = await readme();
    assert.doesNotMatch(
      content,
      /extension (runs|executes) test/i,
      "README must not claim the extension runs test commands itself",
    );
    assert.doesNotMatch(
      content,
      /solo mode has (extension-level|a) .*diff enforce/i,
      "README must not claim solo mode has extension-level diff enforcement",
    );
  });
});
