import { describe, it, afterEach } from "vitest";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseTestsConfig } from "../extensions/test-suite-config.ts";
import { detectTestSuites, projectFacts, type DetectionFacts } from "../extensions/test-tool-detect.ts";

const dirs = new Set(["pkg", "sub/dir"]);
const exists = (rel: string): boolean => dirs.has(rel);

const exploding: DetectionFacts = {
  hasFile: (n) => {
    if (n === "go.mod" || n === "package.json") throw new Error("manifest scanned");
    return dirs.has(n);
  },
  readFile: () => {
    throw new Error("manifest read");
  },
};

describe("parseTestsConfig — implement.tests", () => {
  it("scoped accepts argv arrays and objects with scope/cwd", () => {
    const r = parseTestsConfig(
      { tests: { scoped: [["vitest", "run"], { argv: ["go", "test"], scope: "packages", cwd: "pkg" }] } },
      exists,
    )!;
    assert.deepEqual(r.scoped, [
      { label: "config (vitest run)", argv: ["vitest", "run"] },
      { label: "config (go test)", argv: ["go", "test"], scope: "packages", cwd: "pkg" },
    ]);
    assert.deepEqual(r.full, []);
    assert.deepEqual(r.warnings, []);
  });

  it("full accepts argv arrays and objects with cwd", () => {
    const r = parseTestsConfig(
      { tests: { full: [["make", "test"], { argv: ["npm", "test"], cwd: "sub/dir" }] } },
      exists,
    )!;
    assert.deepEqual(r.full, [
      { label: "config (make test)", argv: ["make", "test"] },
      { label: "config (npm test)", argv: ["npm", "test"], cwd: "sub/dir" },
    ]);
  });

  it("drops absolute, '..' and missing cwds with a warning naming the suite", () => {
    const r = parseTestsConfig(
      {
        tests: {
          scoped: [{ argv: ["a"], cwd: "/abs" }, { argv: ["b"], cwd: "pkg/../x" }],
          full: [{ argv: ["c"], cwd: "nope" }, ["ok"]],
        },
      },
      exists,
    )!;
    assert.deepEqual(r.scoped, []);
    assert.deepEqual(r.full.map((s) => s.argv), [["ok"]]);
    assert.equal(r.warnings.length, 3);
    assert.match(r.warnings[0]!, /config \(a\).*absolute/);
    assert.match(r.warnings[1]!, /config \(b\).*'\.\.'/);
    assert.match(r.warnings[2]!, /config \(c\).*does not exist/);
  });

  it("checks cwd existence on the real repo root via projectFacts", () => {
    const root = mkdtempSync(join(tmpdir(), "pi-cfg-"));
    try {
      mkdirSync(join(root, "real"));
      const r = detectTestSuites(projectFacts(root), {
        implement: { tests: { full: [{ argv: ["x"], cwd: "real" }, { argv: ["y"], cwd: "fake" }] } },
      });
      assert.deepEqual(r.full, [{ label: "config (x)", argv: ["x"], cwd: "real" }]);
      assert.match(r.warnings![0]!, /config \(y\)/);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("parseTestsConfig — legacy testCommands", () => {
  it("populates both lists; go test scoped as packages, others full", () => {
    const r = parseTestsConfig({ testCommands: [["go", "test", "./..."], ["pytest"]] }, exists)!;
    assert.deepEqual(r.scoped, [
      { label: "config (go test ./...)", argv: ["go", "test", "./..."], scope: "packages" },
      { label: "config (pytest)", argv: ["pytest"], scope: "full" },
    ]);
    assert.deepEqual(r.full, [
      { label: "config (go test ./...)", argv: ["go", "test", "./..."] },
      { label: "config (pytest)", argv: ["pytest"] },
    ]);
  });

  it("returns undefined when nothing is configured", () => {
    assert.equal(parseTestsConfig(undefined, exists), undefined);
    assert.equal(parseTestsConfig({ tests: { scoped: [] } }, exists), undefined);
  });
});

describe("detectTestSuites — implement.tests override", () => {
  it("a non-empty implement.tests overrides manifest detection (source config)", () => {
    const r = detectTestSuites(exploding, {
      implement: { tests: { scoped: [["vitest", "run"]], full: [["npm", "test"]] } },
    });
    assert.equal(r.source, "config");
    assert.deepEqual(r.suites, [{ label: "config (vitest run)", argv: ["vitest", "run"] }]);
    assert.deepEqual(r.full, [{ label: "config (npm test)", argv: ["npm", "test"] }]);
  });
});
