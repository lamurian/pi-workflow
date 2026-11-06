import { describe, it } from "vitest";
import assert from "node:assert/strict";
import {
  extractFailingPaths,
  markFailingTest,
  triageFullGate,
  formatFailingTest,
  renderFullGateHalt,
} from "../extensions/full-gate-triage.ts";
import type { GateSuiteResult } from "../extensions/state-types.ts";
import type { DeclaredFile } from "../extensions/contract-guard-core.ts";

/** Build one red suite verdict (label/passed/tail, optional repo-relative cwd). */
function redSuite(tail: string, cwd?: string, label = "suite"): GateSuiteResult {
  return { label, passed: false, tail, ...(cwd ? { cwd } : {}) };
}

// ═══ Assertion 1: pytest / vitest / go extraction mapped via the suite cwd ═══
describe("extractFailingPaths (T7)", () => {
  it("extracts pytest FAILED path:: lines mapped to repo-relative paths via the suite cwd", () => {
    assert.deepEqual(
      extractFailingPaths(redSuite("FAILED tests/test_a.py::test_name - assert False")),
      ["tests/test_a.py"],
      "a root-suite pytest summary yields the test file",
    );
    assert.deepEqual(
      extractFailingPaths(
        redSuite("FAILED tests/test_a.py::test_other", "services/api"),
        ),
      ["services/api/tests/test_a.py"],
      "a suite cwd prefixes the reported path",
    );
    assert.deepEqual(
      extractFailingPaths(redSuite("FAILED ./tests/test_x.py::test_y - failed")),
      ["tests/test_x.py"],
      "a leading ./ is stripped",
    );
  });

  it("extracts vitest FAIL path lines (first token before ' > ') mapped via the suite cwd", () => {
    assert.deepEqual(
      extractFailingPaths(redSuite("FAIL  src/app.test.ts > suite > test")),
      ["src/app.test.ts"],
    );
    assert.deepEqual(
      extractFailingPaths(redSuite("FAIL  ./src/b.test.ts > other", "web")),
      ["web/src/b.test.ts"],
      "the suite cwd prefixes vitest file paths too",
    );
  });

  it("extracts go FAIL pkg lines and resolves --- FAIL: block detail refs against the package dir", () => {
    const goTail =
      "--- FAIL: TestFoo (0.00s)\n    foo_test.go:12: boom\nFAIL\tpkg/foo";
    assert.deepEqual(
      extractFailingPaths(redSuite(goTail)),
      ["pkg/foo", "pkg/foo/foo_test.go"],
      "the package ref and the bare detail ref both resolve repo-relative",
    );
    assert.deepEqual(
      extractFailingPaths(redSuite("FAIL\t./pkg/bar/...")),
      ["pkg/bar"],
      "a ./pkg/... token is normalized to the package dir",
    );
    assert.deepEqual(
      extractFailingPaths(redSuite("FAIL\tfoo", "pkg")),
      ["pkg/foo"],
      "the suite cwd prefixes a go package ref",
    );
  });

  it("skips go import-path refs that do not map into the repository tree", () => {
    assert.deepEqual(
      extractFailingPaths(redSuite("FAIL github.com/x/y")),
      [],
      "an import path is never a repo-relative failing test path",
    );
    assert.deepEqual(extractFailingPaths(redSuite("FAIL\t...")), []);
  });

  it("deduplicates paths reported more than once in one tail", () => {
    const tail =
      "FAIL  src/a.test.ts > suite > test\nFAIL  src/a.test.ts > other";
    assert.deepEqual(extractFailingPaths(redSuite(tail)), ["src/a.test.ts"]);
  });
});

// ═══ Assertion 2: declared marking with owning task ids ═══
describe("markFailingTest (T7)", () => {
  const declared: DeclaredFile[] = [
    { path: "pkg/foo/foo_test.go", refs: ["T1"] },
    { path: "src/a.ts", status: "M", tasks: ["T2"] },
    { path: "shared/x.ts", tasks: ["T1", "T2"] },
  ];

  it("marks an exact declared path with its owning task ids", () => {
    assert.deepEqual(markFailingTest("pkg/foo/foo_test.go", declared), {
      path: "pkg/foo/foo_test.go",
      declared: true,
      owners: ["T1"],
    });
    assert.deepEqual(markFailingTest("src/a.ts", declared).owners, ["T2"]);
    assert.deepEqual(markFailingTest("shared/x.ts", declared).owners, ["T1", "T2"]);
  });

  it("covers a go package dir vs. its declared test file in both directions", () => {
    assert.deepEqual(markFailingTest("pkg/foo", declared), {
      path: "pkg/foo",
      declared: true,
      owners: ["T1"],
    });
    assert.deepEqual(markFailingTest("pkg/foo/extra", declared), {
      path: "pkg/foo/extra",
      declared: true,
      owners: ["T1"],
    });
  });

  it("marks a path no entry covers as undeclared with no owners", () => {
    assert.deepEqual(markFailingTest("secrets.py", declared), {
      path: "secrets.py",
      declared: false,
      owners: [],
    });
  });
});

// ═══ Assertions 2+3: triage verdict over a final-gate run ═══
describe("triageFullGate (T7)", () => {
  const declared: DeclaredFile[] = [
    { path: "__tests__/a.test.ts", refs: ["T1"] },
    { path: "pkg/foo/foo_test.go", refs: ["T2"] },
  ];

  it("skips passing suites, dedupes failing paths and marks each declared/undeclared", () => {
    const suites: GateSuiteResult[] = [
      { label: "js", passed: true, tail: "FAIL  __tests__/a.test.ts > x" },
      redSuite("FAIL  __tests__/a.test.ts > y", undefined, "js2"),
      redSuite("FAIL\tsecrets/pkg", undefined, "go"),
    ];
    const triage = triageFullGate(suites, declared);

    assert.deepEqual(
      triage.failing.map((f) => f.path),
      ["__tests__/a.test.ts", "secrets/pkg"],
      "a passing suite's FAIL lines never enter the triage; duplicates collapse",
    );
    assert.equal(triage.failing[0]!.declared, true);
    assert.deepEqual(triage.failing[0]!.owners, ["T1"]);
    assert.equal(triage.failing[1]!.declared, false);
    assert.deepEqual(triage.failing[1]!.owners, []);
    assert.deepEqual(triage.unparseableSuites, []);
  });

  it("reports a red suite unparseable when it yields no failing test path", () => {
    const triage = triageFullGate(
      [redSuite("some random error with no test paths", undefined, "python (pytest)")],
      declared,
    );
    assert.deepEqual(triage.failing, []);
    assert.deepEqual(triage.unparseableSuites, ["python (pytest)"]);
  });

  it("maps a package ref to its declared test file's owners through the suite cwd", () => {
    const triage = triageFullGate(
      [redSuite("--- FAIL: TestFoo (0.00s)\nFAIL\tpkg/foo", undefined, "go")],
      declared,
    );
    assert.equal(triage.failing.length, 1);
    assert.deepEqual(triage.failing[0], {
      path: "pkg/foo",
      declared: true,
      owners: ["T2"],
    });
  });
});

// ═══ Assertions 1+10: rendered lines and the undeclared/unparseable halt ═══
describe("formatFailingTest and renderFullGateHalt (T7)", () => {
  it("formats declared and undeclared failing tests", () => {
    assert.equal(
      formatFailingTest({ path: "src/app.test.ts", declared: true, owners: ["T1", "T2"] }),
      "src/app.test.ts — declared (owners: T1, T2)",
    );
    assert.equal(
      formatFailingTest({ path: "src/app.test.ts", declared: true, owners: [] }),
      "src/app.test.ts — declared (owners: none)",
    );
    assert.equal(
      formatFailingTest({ path: "secrets.py", declared: false, owners: [] }),
      "secrets.py — undeclared",
    );
  });

  it("renders the halt listing every failing test with its marking and the /discuss -> /finalize -> /implement steer", () => {
    const text = renderFullGateHalt({
      failing: [
        { path: "__tests__/a.test.ts", declared: true, owners: ["T1"] },
        { path: "secrets/pkg", declared: false, owners: [] },
      ],
      unparseableSuites: ["python (pytest)"],
    });

    assert.match(text, /## Final gate triage/, "the halt heading");
    assert.match(text, /- __tests__\/a\.test\.ts — declared \(owners: T1\)/);
    assert.match(text, /- secrets\/pkg — undeclared/);
    assert.match(
      text,
      /Unparseable red suites[\s\S]*- python \(pytest\)/,
      "unparseable red suites are named",
    );
    assert.match(text, /No\s+FULL-GATE fix unit runs/, "no fix round runs in this case");
    assert.match(text, /\/discuss -> \/finalize -> \/implement/, "the contract-change steer");
  });
});
