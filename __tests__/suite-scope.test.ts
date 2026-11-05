import { describe, it } from "vitest";
import assert from "node:assert/strict";
import { routeSuites, unfilteredArgv, effectiveScope } from "../extensions/suite-scope.ts";
import type { TestSuite } from "../extensions/test-tool-detect.ts";

const py: TestSuite = { label: "py", argv: ["pytest", "{tests}"], scope: "files", cwd: "svc" };
const vt: TestSuite = { label: "vt", argv: ["npx", "vitest", "run"], scope: "files" };
const go: TestSuite = { label: "go", argv: ["go", "test", "./..."], cwd: "gosvc" };

describe("routeSuites", () => {
  it("routes by language, rewrites relative to cwd, replaces or appends", () => {
    const r = routeSuites([py, vt], [
      { path: "svc/tests/test_a.py" },
      { path: "__tests__/a.test.ts" },
      { path: "README.md" },
    ]);
    assert.deepEqual(r[0].argv, ["pytest", "tests/test_a.py"]);
    assert.deepEqual(r[1].argv, ["npx", "vitest", "run", "__tests__/a.test.ts"]);
  });

  it("maps go test paths to package dirs", () => {
    const r = routeSuites([go], [
      { path: "gosvc/x/a_test.go" },
      { path: "gosvc/x/b_test.go" },
      { path: "gosvc/root_test.go" },
    ]);
    assert.deepEqual(r[0].argv, ["go", "test", "./x/...", "./..."]);
    const p = routeSuites([{ label: "g", argv: ["go", "test", "{pkgs}", "-v"] }], [{ path: "a/a_test.go" }]);
    assert.deepEqual(p[0].argv, ["go", "test", "./a/...", "-v"]);
  });

  it("uses deepest ancestor cwd only", () => {
    const outer: TestSuite = { label: "o", argv: ["vitest", "run"], scope: "files" };
    const inner: TestSuite = { label: "i", argv: ["vitest", "run"], scope: "files", cwd: "pkg/web" };
    const other: TestSuite = { label: "x", argv: ["vitest", "run"], scope: "files", cwd: "other" };
    const r = routeSuites([outer, inner, other], [{ path: "pkg/web/a.test.ts" }]);
    assert.equal(r[0].skipped, true);
    assert.deepEqual(r[1].argv, ["vitest", "run", "a.test.ts"]);
    assert.equal(r[2].skipped, true);
    assert.deepEqual(r[2].argv, []);
  });

  it("full suites run unchanged minus placeholders; D never routed", () => {
    const full: TestSuite = { label: "f", argv: ["make", "test", "{tests}"] };
    const r = routeSuites([full, vt], [{ path: "a.test.ts", status: "D" }]);
    assert.deepEqual(r[0], { suite: full, skipped: false, argv: ["make", "test"] });
    assert.equal(r[1].skipped, true);
  });

  it("defaults scope and builds unfiltered argv", () => {
    assert.equal(effectiveScope(go), "packages");
    assert.equal(effectiveScope({ label: "n", argv: ["npm", "test"] }), "full");
    assert.deepEqual(unfilteredArgv(py), ["pytest"]);
    assert.deepEqual(unfilteredArgv({ label: "g", argv: ["go", "test", "{pkgs}"] }), ["go", "test", "./..."]);
  });
});
