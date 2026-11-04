import { describe, it } from "vitest";
import assert from "node:assert/strict";
import {
  classifySlop,
  parseAddedLines,
  parseAislopJson,
  parseWritingScore,
} from "../extensions/slop-scan.ts";
import type {
  AislopDiagnostic,
  ClassifySlopInput,
} from "../extensions/slop-scan.ts";
import type { SlopConfig } from "../extensions/slop-config.ts";

// ─── Harness ──────────────────────────────────────────────────────────────────

const BASE: SlopConfig = {
  mode: "advisory",
  fetchFallback: true,
  codeFailBelow: 80,
  proseGate: 25,
};

/** Resolved config with one mode overridden. */
function config(
  mode: SlopConfig["mode"],
  overrides: Partial<SlopConfig> = {},
): SlopConfig {
  return { ...BASE, mode, ...overrides };
}

/** classifySlop input with benign defaults (nothing breaches). */
function input(overrides: Partial<ClassifySlopInput> = {}): ClassifySlopInput {
  return {
    aislop: { score: 95, diagnostics: [] },
    prose: [],
    addedLines: new Map<string, number[]>(),
    ...overrides,
  };
}

/** Diagnostic shorthand pointing at src/a.ts. */
function diag(line: number | null, message: string): AislopDiagnostic {
  return {
    filePath: "src/a.ts",
    line,
    rule: "no-console",
    severity: "warning",
    message,
  };
}

// ─── parseAislopJson ──────────────────────────────────────────────────────────

describe("parseAislopJson", () => {
  it("returns score and diagnostics (filePath, line, rule, severity, message) from aislop --json stdout", () => {
    const stdout = JSON.stringify({
      score: 71.5,
      diagnostics: [
        {
          filePath: "src/a.ts",
          line: 12,
          rule: "no-console",
          severity: "warning",
          message: "avoid console",
        },
        {
          filePath: "src/b.ts",
          line: 40,
          rule: "no-var",
          severity: "error",
          message: "use const",
        },
      ],
    });

    assert.deepEqual(parseAislopJson(stdout), {
      score: 71.5,
      diagnostics: [
        {
          filePath: "src/a.ts",
          line: 12,
          rule: "no-console",
          severity: "warning",
          message: "avoid console",
        },
        {
          filePath: "src/b.ts",
          line: 40,
          rule: "no-var",
          severity: "error",
          message: "use const",
        },
      ],
    });
  });

  it("returns null for non-JSON output", () => {
    assert.equal(parseAislopJson("score: 71 (ok)"), null);
    assert.equal(parseAislopJson(""), null);
  });

  it("returns null for output without a diagnostics array", () => {
    assert.equal(parseAislopJson(JSON.stringify({ score: 71 })), null);
    assert.equal(
      parseAislopJson(JSON.stringify({ score: 71, diagnostics: "nope" })),
      null,
    );
  });

  it("reports a null score when the JSON carries no numeric score", () => {
    assert.deepEqual(parseAislopJson(JSON.stringify({ diagnostics: [] })), {
      score: null,
      diagnostics: [],
    });
  });
});

// ─── parseWritingScore ────────────────────────────────────────────────────────

describe("parseWritingScore", () => {
  it("returns 82.8 for output containing a Writing score line", () => {
    const out =
      "Scanning 3 files...\nWriting score: 82.8/100  [major rewrite]\nDone.";
    assert.equal(parseWritingScore(out), 82.8);
  });

  it("returns null when no score line exists", () => {
    assert.equal(parseWritingScore("nothing to report\nall clean"), null);
  });
});

// ─── parseAddedLines ──────────────────────────────────────────────────────────

describe("parseAddedLines", () => {
  it("maps each file to its added (new-side) line numbers, counting every line of a new file", () => {
    const diff = [
      "diff --git a/src/a.ts b/src/a.ts",
      "--- a/src/a.ts",
      "+++ b/src/a.ts",
      "@@ -3,0 +4 @@",
      "+added line",
      "@@ -10,2 +11,3 @@",
      "+one",
      "+two",
      "+three",
      "diff --git a/new.md b/new.md",
      "new file mode 100644",
      "--- /dev/null",
      "+++ b/new.md",
      "@@ -0,0 +1,3 @@",
      "+# one",
      "+# two",
      "+# three",
      "diff --git a/gone.ts b/gone.ts",
      "deleted file mode 100644",
      "--- a/gone.ts",
      "+++ /dev/null",
      "@@ -1,2 +0,0 @@",
      "-old",
      "-older",
      "",
    ].join("\n");

    const added = parseAddedLines(diff);

    assert.equal(added.size, 3, "every file in the diff gets an entry");
    assert.deepEqual(added.get("src/a.ts"), [4, 11, 12, 13]);
    assert.deepEqual(added.get("new.md"), [1, 2, 3], "new file: all lines");
    assert.deepEqual(added.get("gone.ts"), [], "deletion adds no lines");
  });
});

// ─── classifySlop ─────────────────────────────────────────────────────────────

describe("classifySlop", () => {
  it("mode off returns clean with no notes, ignoring every breach", () => {
    const v = classifySlop(
      input({
        aislop: {
          score: 10,
          diagnostics: [diag(1, "bad")],
        },
        prose: [{ path: "README.md", staged: 99, head: 10 }],
      }),
      config("off"),
    );

    assert.equal(v.kind, "clean");
    assert.deepEqual(v.notes, []);
    assert.deepEqual(v.violations, []);
  });

  it("advisory mode never blocks: one 'slop advisory:' note for a code breach", () => {
    const v = classifySlop(
      input({ aislop: { score: 62, diagnostics: [diag(1, "bad")] } }),
      config("advisory"),
    );

    assert.notEqual(v.kind, "block");
    assert.equal(v.kind, "annotate");
    assert.equal(v.notes.length, 1);
    assert.ok(v.notes[0]!.startsWith("slop advisory:"));
    assert.ok(v.notes[0]!.includes("62"));
    assert.ok(v.notes[0]!.includes("codeFailBelow"));
    assert.deepEqual(v.violations, []);
  });

  it("advisory mode never blocks: one 'slop advisory:' note for a prose breach", () => {
    const v = classifySlop(
      input({ prose: [{ path: "README.md", staged: 44, head: 10 }] }),
      config("advisory"),
    );

    assert.notEqual(v.kind, "block");
    assert.equal(v.kind, "annotate");
    assert.equal(v.notes.length, 1);
    assert.ok(v.notes[0]!.startsWith("slop advisory:"));
    assert.ok(v.notes[0]!.includes("README.md"));
    assert.ok(v.notes[0]!.includes("proseGate"));
  });

  it("advisory mode emits exactly one note per breach when both breach", () => {
    const v = classifySlop(
      input({
        aislop: { score: 62, diagnostics: [diag(1, "bad")] },
        prose: [{ path: "README.md", staged: 44, head: 10 }],
      }),
      config("advisory"),
    );

    assert.notEqual(v.kind, "block");
    assert.equal(v.notes.length, 2);
    assert.ok(v.notes.every((n) => n.startsWith("slop advisory:")));
  });

  it("hard mode blocks on a code score below codeFailBelow, listing each diagnostic as 'path:line rule — message'", () => {
    const v = classifySlop(
      input({
        aislop: {
          score: 62,
          diagnostics: [
            {
              filePath: "src/a.ts",
              line: 12,
              rule: "no-console",
              severity: "warning",
              message: "avoid console",
            },
            {
              filePath: "src/b.ts",
              line: 40,
              rule: "no-var",
              severity: "error",
              message: "use const",
            },
          ],
        },
      }),
      config("hard"),
    );

    assert.equal(v.kind, "block");
    assert.deepEqual(v.violations, [
      "src/a.ts:12 no-console — avoid console",
      "src/b.ts:40 no-var — use const",
    ]);
    assert.deepEqual(v.notes, []);
  });

  it("hard mode blocks when any prose file score is above proseGate", () => {
    const v = classifySlop(
      input({ prose: [{ path: "README.md", staged: 44, head: 44 }] }),
      config("hard"),
    );

    assert.equal(v.kind, "block");
    assert.ok(
      v.violations.some(
        (x) => x.includes("README.md") && x.includes("proseGate"),
      ),
    );
  });

  it("treats a null aislop score (not scoreable) as no code breach", () => {
    for (const aislop of [null, { score: null, diagnostics: [] }]) {
      const v = classifySlop(input({ aislop }), config("hard"));
      assert.equal(v.kind, "clean", JSON.stringify(aislop));
      assert.deepEqual(v.notes, []);
      assert.deepEqual(v.violations, []);
    }
  });

  it("baseline mode blocks only on diagnostics whose line is an added line", () => {
    const v = classifySlop(
      input({
        aislop: {
          score: 10, // below codeFailBelow: baseline must ignore the raw score
          diagnostics: [
            diag(4, "on an added line"),
            diag(99, "on an untouched line"),
            diag(null, "without a line"),
          ],
        },
        addedLines: new Map([["src/a.ts", [4, 11]]]),
      }),
      config("baseline"),
    );

    assert.equal(v.kind, "block");
    assert.deepEqual(v.violations, ["src/a.ts:4 no-console — on an added line"]);
  });

  it("baseline mode never blocks on untouched or lineless diagnostics", () => {
    const v = classifySlop(
      input({
        aislop: {
          score: 10,
          diagnostics: [diag(99, "untouched"), diag(null, "no line")],
        },
        addedLines: new Map([["src/a.ts", [4, 11]]]),
      }),
      config("baseline"),
    );

    assert.equal(v.kind, "clean");
    assert.deepEqual(v.notes, []);
    assert.deepEqual(v.violations, []);
  });

  it("baseline mode blocks a prose file only when staged exceeds both proseGate and its HEAD score", () => {
    const withHead = (staged: number, head: number | null) =>
      classifySlop(
        input({ prose: [{ path: "a.md", staged, head }] }),
        config("baseline"),
      );

    assert.equal(withHead(30, 20).kind, "block", "above gate and above HEAD");
    assert.equal(withHead(30, 30).kind, "clean", "equal to HEAD: no breach");
    assert.equal(withHead(30, 40).kind, "clean", "below HEAD: no breach");
    assert.equal(withHead(20, 10).kind, "clean", "below gate: no breach");
  });

  it("baseline mode compares a prose file with no HEAD score to proseGate alone", () => {
    const withHead = (staged: number) =>
      classifySlop(
        input({ prose: [{ path: "new.md", staged, head: null }] }),
        config("baseline"),
      );

    assert.equal(withHead(30).kind, "block", "above gate with no HEAD score");
    assert.equal(withHead(20).kind, "clean", "below gate with no HEAD score");
  });

  it("returns clean with no notes when nothing breaches, in every mode", () => {
    for (const mode of ["off", "advisory", "baseline", "hard"] as const) {
      const v = classifySlop(
        input({ prose: [{ path: "a.md", staged: 25, head: 25 }] }),
        config(mode),
      );
      assert.deepEqual(
        {
          kind: v.kind,
          notes: v.notes,
          violations: v.violations,
          investigation: v.investigation,
        },
        { kind: "clean", notes: [], violations: [], investigation: "" },
        mode,
      );
    }
  });

  it("the block investigation names the mode and thresholds and is capped at 4000 characters", () => {
    const diagnostics: AislopDiagnostic[] = Array.from(
      { length: 400 },
      (_, i) => ({
        filePath: `src/file-${i}.ts`,
        line: i + 1,
        rule: "no-console",
        severity: "warning",
        message: `message number ${i} with padding text to exceed the cap`,
      }),
    );
    const v = classifySlop(
      input({ aislop: { score: 10, diagnostics } }),
      config("hard"),
    );

    assert.equal(v.kind, "block");
    assert.equal(v.violations.length, 400, "violations are not truncated");
    assert.ok(v.investigation.length <= 4000, "investigation is capped");
    assert.ok(v.investigation.includes("mode=hard"));
    assert.ok(v.investigation.includes("codeFailBelow=80"));
    assert.ok(v.investigation.includes("proseGate=25"));

    const base = classifySlop(
      input({
        aislop: { score: 95, diagnostics: [diag(4, "added line")] },
        addedLines: new Map([["src/a.ts", [4]]]),
      }),
      config("baseline"),
    );
    assert.equal(base.kind, "block");
    assert.ok(base.investigation.includes("mode=baseline"));
    assert.ok(base.investigation.includes("codeFailBelow=80"));
    assert.ok(base.investigation.includes("proseGate=25"));
  });
});
