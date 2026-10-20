import { describe, it } from "vitest";
import assert from "node:assert/strict";
import {
  LANG_PROFILES,
  profileFor,
  escapeRe,
  isTestPath,
  buildImportRegex,
} from "../extensions/test-scan-profiles.ts";
import { deriveMatches } from "../extensions/test-scan-derive.ts";
import { crossCheck } from "../extensions/test-scan-check.ts";
import {
  renderEvidence,
  BASENAME_FANOUT_CAP,
  MAX_EVIDENCE_LINES,
} from "../extensions/test-scan-render.ts";

// ═══ LANG_PROFILES / profileFor / escapeRe / isTestPath ═══
describe("test-scan profiles and predicates", () => {
  it("ships profiles for all eight languages", () => {
    for (const want of ["javascript", "python", "go", "rust", "java", "kotlin", "csharp", "ruby", "php"]) {
      assert.ok(LANG_PROFILES.some((p) => p.id === want), `missing profile ${want}`);
    }
  });

  it("profileFor maps extensions and returns null for unknowns", () => {
    assert.equal(profileFor(".py")?.id, "python");
    assert.equal(profileFor(".ts")?.id, "javascript");
    assert.equal(profileFor(".go")?.id, "go");
    assert.equal(profileFor(".xyz"), null);
  });

  it("isTestPath uses union semantics across all profiles", () => {
    assert.equal(isTestPath("src/auth.test.ts"), true);
    assert.equal(isTestPath("pkg/auth_test.go"), true);
    assert.equal(isTestPath("tests/test_auth.py"), true);
    assert.equal(isTestPath("src/auth.ts"), false);
  });

  it("escapeRe produces a pattern matching only the literal string", () => {
    const re = new RegExp(escapeRe("a+b.ts"));
    assert.equal(re.test("a+b.ts"), true);
    assert.equal(re.test("axb.ts"), false);
    assert.equal(re.test("abts"), false);
  });

  it("buildImportRegex matches aliases and relatives but not supersets", () => {
    const js = profileFor(".ts")!;
    const re = buildImportRegex(js, "auth");
    assert.equal(re.test('import x from "@/auth"'), true);
    assert.equal(re.test("const a = require('../auth')"), true);
    assert.equal(re.test('import y from "./auth.js"'), true);
    assert.equal(re.test('import z from "../oauth"'), false);
  });
});

// ═══ deriveMatches — four derivation layers ═══
describe("deriveMatches derivation layers", () => {
  it("structural layer mirrors colocated and conventional test paths", () => {
    const r1 = deriveMatches("src/auth.ts", new Map([["__tests__/auth.test.ts", "x"]]));
    assert.equal(r1.matches.length, 1);
    assert.equal(r1.matches[0]!.method, "structural");
    assert.equal(r1.matches[0]!.confidence, "high");

    const r2 = deriveMatches("src/auth/x.ts", new Map([["tests/auth/x_test.go", "x"]]));
    assert.equal(r2.matches.length, 1);
    assert.equal(r2.matches[0]!.method, "structural");
  });

  it("import-path layer matches boundary-aware import lines", () => {
    const files = new Map([
      ["tests/flows.test.ts", 'import { go } from "@/auth"\n'],
      ["tests/rel.test.ts", "const a = require('../auth')\n"],
      ["tests/ext.test.ts", 'import { b } from "./auth.js"\n'],
    ]);
    const r = deriveMatches("src/auth.ts", files);
    const methods = new Map(r.matches.map((m) => [m.path, m.method]));
    assert.equal(methods.get("tests/flows.test.ts"), "import-path");
    assert.equal(methods.get("tests/rel.test.ts"), "import-path");
    assert.equal(methods.get("tests/ext.test.ts"), "import-path");
  });

  it("import-path does not match supersets like ../oauth", () => {
    const files = new Map([["tests/oauth.test.ts", 'import z from "../oauth"\n']]);
    const r = deriveMatches("src/auth.ts", files);
    assert.deepEqual(r.matches, []);
  });

  it("symbol layer extracts named exports and export lists, matches aliased imports", () => {
    // Import path deliberately differs (@/lib, not @/auth) so the symbol
    // layer — not import-path — is what catches the aliased original name.
    const files = new Map([
      ["src/auth.ts", "export async function validateUser() {}\n"],
      ["tests/user-flows.test.ts", 'import { validateUser as vu } from "@/lib"\n'],
    ]);
    const r = deriveMatches("src/auth.ts", files);
    const m = r.matches.find((x) => x.path === "tests/user-flows.test.ts");
    assert.ok(m, "aliased import should match via symbol layer");
    assert.equal(m!.method, "symbol");

    // Non-mirroring test path so structural does not win over symbol.
    const files2 = new Map([
      ["src/models.ts", "export { Session, User as UserModel }\n"],
      ["tests/domain.test.ts", "const u = new User();\n"],
    ]);
    const r2 = deriveMatches("src/models.ts", files2);
    assert.equal(r2.matches[0]?.method, "symbol");
  });

  it("resolves one-level export * barrels and tags deeper chains unverified", () => {
    const files = new Map([
      ["src/index.ts", "export * from './auth'\n"],
      ["src/auth.ts", "export function validateUser() {}\n"],
      ["tests/core.test.ts", "validateUser();\n"],
    ]);
    const r = deriveMatches("src/index.ts", files);
    const m = r.matches.find((x) => x.path === "tests/core.test.ts");
    assert.ok(m, "barrel-resolved symbol should match");
    assert.equal(m!.method, "symbol");

    const deep = new Map([
      ["src/index.ts", "export * from './inner'\n"],
      ["src/inner.ts", "export * from './deep'\n"],
      ["src/deep.ts", "export function hidden() {}\n"],
      ["tests/deep.test.ts", "hidden();\n"],
    ]);
    const r2 = deriveMatches("src/index.ts", deep);
    assert.match(r2.note ?? "", /unverified/);
    assert.match(r2.note ?? "", /re-export/);
  });

  it("basename fallback is tagged low confidence", () => {
    const files = new Map([
      ["src/util.ts", "export default function main() {}\n"],
      ["tests/misc.test.ts", "the util module works\n"],
    ]);
    const r = deriveMatches("src/util.ts", files);
    assert.equal(r.matches.length, 1);
    assert.equal(r.matches[0]!.method, "basename");
    assert.equal(r.matches[0]!.confidence, "low");
  });

  it("unknown extensions degrade to basename fallback, low confidence", () => {
    const files = new Map([["tests/cfg.test.ts", "config loaded\n"]]);
    const r = deriveMatches("src/config.xyz", files);
    assert.equal(r.matches[0]?.method, "basename");
    assert.equal(r.matches[0]?.confidence, "low");
  });

  it("first matching layer wins; non-matching tests yield no record", () => {
    const files = new Map([
      ["__tests__/auth.test.ts", "structural + basename would both hit\n"],
      ["tests/unrelated.test.ts", "nothing relevant here at all\n"],
    ]);
    const r = deriveMatches("src/auth.ts", files);
    assert.equal(r.matches.length, 1);
    assert.equal(r.matches[0]!.method, "structural");
  });
});

// ═══ crossCheck ═══
describe("crossCheck classifier", () => {
  it("flags referencing-but-undeclared test files", () => {
    const findings = new Map([
      ["src/auth.ts", { matches: [{ path: "tests/flows.test.ts", method: "import-path" as const, confidence: "high" as const }] }],
    ]);
    const r = crossCheck(["src/auth.ts"], findings, new Set(["src/auth.ts"]));
    assert.ok(
      r.warnings.some((w) => /undeclared-referencing/.test(w) && /tests\/flows\.test\.ts/.test(w)),
      `expected undeclared-referencing warning, got ${JSON.stringify(r.warnings)}`,
    );
  });

  it("aggregates undeclared-referencing into one warning per distinct test path", () => {
    // Three declared entries all match the same undeclared test file via two
    // different methods: import-path (x2) and symbol (x1).
    const findings = new Map([
      ["src/a.ts", { matches: [{ path: "tests/shared.test.ts", method: "import-path" as const, confidence: "high" as const }] }],
      ["src/b.ts", { matches: [{ path: "tests/shared.test.ts", method: "symbol" as const, confidence: "high" as const }] }],
      ["src/c.ts", { matches: [{ path: "tests/shared.test.ts", method: "import-path" as const, confidence: "high" as const }] }],
    ]);
    const declared = ["src/a.ts", "src/b.ts", "src/c.ts"];
    const r = crossCheck(declared, findings, new Set(declared));
    const undeclaredLines = r.warnings.filter((w) => /undeclared-referencing/.test(w));
    assert.equal(
      undeclaredLines.length,
      1,
      `expected exactly 1 aggregated warning, got ${JSON.stringify(undeclaredLines)}`,
    );
    const line = undeclaredLines[0]!;
    assert.match(line, /tests\/shared\.test\.ts/, "warning must name the test path");
    assert.match(line, /import-path/, "warning must name the matched method(s)");
    assert.match(line, /symbol/, "warning must name the matched method(s)");
    assert.match(line, /\b3\b/, "warning must state how many declaring entries matched");
  });

  it("emits one warning per distinct path, not per match pair", () => {
    const findings = new Map([
      ["src/a.ts", { matches: [
        { path: "tests/one.test.ts", method: "symbol" as const, confidence: "high" as const },
        { path: "tests/two.test.ts", method: "basename" as const, confidence: "low" as const },
      ] }],
      ["src/b.ts", { matches: [{ path: "tests/one.test.ts", method: "basename" as const, confidence: "low" as const }] }],
    ]);
    const declared = ["src/a.ts", "src/b.ts"];
    const r = crossCheck(declared, findings, new Set(declared));
    const undeclaredLines = r.warnings.filter((w) => /undeclared-referencing/.test(w));
    // 3 match pairs (a->one, a->two, b->one) but only 2 distinct paths.
    assert.equal(
      undeclaredLines.length,
      2,
      `expected 2 warnings (distinct paths), got ${JSON.stringify(undeclaredLines)}`,
    );
    const singleEntryLine = undeclaredLines.find((w) => /tests\/two\.test\.ts/.test(w));
    assert.ok(singleEntryLine);
    assert.match(singleEntryLine!, /\b1\b/);
  });

  it("flags declared entries that match nothing on disk", () => {
    const r = crossCheck(["src/typo.ts"], new Map(), new Set());
    assert.ok(
      r.warnings.some((w) => /declared-not-found/.test(w) && /src\/typo\.ts/.test(w)),
      `expected declared-not-found warning, got ${JSON.stringify(r.warnings)}`,
    );
  });

  it("emits a no-evidence note for all-new additive contracts", () => {
    const r = crossCheck(["src/newfeature.ts"], new Map(), new Set());
    assert.ok(
      r.warnings.some((w) => /no-evidence/.test(w)),
      `expected no-evidence note, got ${JSON.stringify(r.warnings)}`,
    );
  });

  it("zero-hit entries render unverified, never clean", () => {
    const r = crossCheck(["src/auth.ts"], new Map([["src/auth.ts", { matches: [] }]]), new Set(["src/auth.ts"]));
    assert.ok(r.evidence.some((e) => /src\/auth\.ts/.test(e) && /unverified/.test(e)));
    assert.ok(!r.evidence.some((e) => /\bclean\b/.test(e)), "evidence must never say clean");
  });

  it("matched entries render method and confidence per evidence line", () => {
    const findings = new Map([
      ["src/auth.ts", { matches: [{ path: "tests/flows.test.ts", method: "symbol" as const, confidence: "high" as const }] }],
    ]);
    const r = crossCheck(["src/auth.ts"], findings, new Set(["src/auth.ts"]));
    const line = r.evidence.find((e) => /tests\/flows\.test\.ts/.test(e));
    assert.ok(line);
    assert.match(line!, /symbol/);
    assert.match(line!, /high/);
  });
});

// ═══ renderEvidence — basename fan-out collapse ═══
describe("renderEvidence basename fan-out collapse", () => {
  it("caps the per-entry basename fan-out at 5", () => {
    assert.equal(BASENAME_FANOUT_CAP, 5);
  });

  it("collapses 88 basename matches into one summary line", () => {
    const evidence = Array.from(
      { length: 88 },
      (_, i) => `src/messages/en/research.json -> src/app/f${i}.test.tsx [basename, low]`,
    );
    const lines = renderEvidence(evidence).split("\n");
    assert.equal(lines.length, 1, `expected 1 summary line, got ${lines.length}`);
    const line = lines[0]!;
    assert.match(line, /src\/messages\/en\/research\.json/, "summary must name the entry");
    assert.match(line, /88/, "summary must state the total count");
    assert.match(line, /src\/app\/f0\.test\.tsx/, "summary must keep sample path 1");
    assert.match(line, /src\/app\/f1\.test\.tsx/, "summary must keep sample path 2");
    assert.match(line, /src\/app\/f2\.test\.tsx/, "summary must keep sample path 3");
    assert.match(line, /grep/, "summary must carry the grep hint");
    assert.match(line, /\\bresearch\\b/, "grep hint must use a word-boundary pattern");
    assert.ok(!/f3\.test\.tsx/.test(line), "samples beyond the first 3 must be omitted");
  });

  it("lists basename matches individually at or below the cap", () => {
    for (const n of [1, 5]) {
      const evidence = Array.from(
        { length: n },
        (_, i) => `src/util.ts -> tests/util-${i}.test.ts [basename, low]`,
      );
      const out = renderEvidence(evidence);
      const lines = out.split("\n");
      assert.equal(lines.length, n, `n=${n}: expected every line kept, got ${lines.length}`);
      for (const l of lines) assert.match(l, /\[basename, low\]/);
      assert.ok(!/too generic/.test(out), `n=${n}: must not collapse`);
    }
  });

  it("collapses at cap + 1, keeping the first 3 samples", () => {
    const evidence = Array.from(
      { length: 6 },
      (_, i) => `src/util.ts -> tests/util-${i}.test.ts [basename, low]`,
    );
    const lines = renderEvidence(evidence).split("\n");
    assert.equal(lines.length, 1);
    assert.match(lines[0]!, /\b6\b/);
    assert.match(lines[0]!, /tests\/util-0\.test\.ts/);
    assert.match(lines[0]!, /tests\/util-2\.test\.ts/);
    assert.ok(!/util-3\.test\.ts/.test(lines[0]!));
  });

  it("never collapses high-confidence matches regardless of count", () => {
    const evidence = Array.from(
      { length: 20 },
      (_, i) => `src/auth.ts -> tests/auth-${i}.test.ts [structural, high]`,
    );
    const out = renderEvidence(evidence);
    const lines = out.split("\n");
    assert.equal(lines.length, 20, "all high-confidence lines must stay enumerated");
    for (const l of lines) assert.match(l, /\[structural, high\]/);
    assert.ok(!/too generic/.test(out), "high-confidence lines must never collapse");
  });

  it("keeps mixed entries: high enumerated, basename block collapsed in place", () => {
    const evidence = [
      "src/messages/en/research.json -> __tests__/research.test.ts [structural, high]",
      ...Array.from(
        { length: 10 },
        (_, i) => `src/messages/en/research.json -> src/x/t${i}.test.ts [basename, low]`,
      ),
    ];
    const lines = renderEvidence(evidence).split("\n");
    assert.equal(lines.length, 2);
    assert.match(lines[0]!, /__tests__\/research\.test\.ts \[structural, high\]/);
    assert.match(lines[1]!, /too generic/);
  });

  it("passes non-match entry lines through unchanged", () => {
    const unverified =
      "src/new.ts: unverified — no derivation hit (default export, indirect reference, or no affected tests); confirm by reading the tests or declare known paths in files";
    assert.equal(renderEvidence([unverified]), unverified);
  });

  it("returns an empty string for empty evidence", () => {
    assert.equal(renderEvidence([]), "");
  });
});

// ═══ renderEvidence — global line cap (MAX_EVIDENCE_LINES) ═══
describe("renderEvidence global line cap (MAX_EVIDENCE_LINES)", () => {
  it("caps the global evidence line budget at 150", () => {
    assert.equal(MAX_EVIDENCE_LINES, 150);
  });

  /** 1,800 low-confidence lines spread over 360 entries (5 each, no collapse). */
  function lowFanOut(count: number): string[] {
    return Array.from({ length: count }, (_, i) => {
      const entry = `src/e${Math.floor(i / 5)}.ts`;
      return `${entry} -> tests/lo-${i}.test.ts [basename, low]`;
    });
  }

  it("keeps all high-confidence lines, adds no low-confidence past the cap, one trailer", () => {
    // 2,000 lines: 200 high-confidence + 1,800 low-confidence.
    const high = Array.from(
      { length: 200 },
      (_, i) => `src/h${i}.ts -> tests/h-${i}.test.ts [structural, high]`,
    );
    const evidence = [...high, ...lowFanOut(1800)];
    const lines = renderEvidence(evidence).split("\n");

    const trailer = lines[lines.length - 1]!;
    const kept = lines.slice(0, -1);
    assert.match(trailer, /omitted/, "last line must be the omission trailer");
    assert.match(trailer, /1800/, "trailer must name the omitted count");
    assert.match(trailer, /\[basename, low\]/, "trailer must name what was omitted");

    // High-confidence lines are never dropped: all 200 present, stable order.
    const keptHigh = kept.filter((l) => /\[structural, high\]/.test(l));
    assert.equal(keptHigh.length, 200, "all 200 high-confidence lines must be present");
    assert.deepEqual(keptHigh, high, "high-confidence lines must keep stable order");
    // No low-confidence lines admitted: the cap is already exceeded by high lines.
    assert.equal(kept.length, 200, "no low-confidence line may displace a high one");
    assert.equal(lines.length, 201, "exactly high lines plus one trailer");
  });

  it("fills low-confidence lines up to the cap when high lines leave budget", () => {
    const high = Array.from(
      { length: 40 },
      (_, i) => `src/h${i}.ts -> tests/h-${i}.test.ts [import-path, high]`,
    );
    const evidence = [...high, ...lowFanOut(1800)];
    const lines = renderEvidence(evidence).split("\n");

    assert.equal(lines.length, MAX_EVIDENCE_LINES + 1, "150 match lines plus one trailer");
    const trailer = lines[lines.length - 1]!;
    assert.match(trailer, /omitted/);
    assert.match(trailer, /1690/, "1,800 low lines minus the 110 admitted");

    const kept = lines.slice(0, -1);
    const keptHigh = kept.filter((l) => /\[import-path, high\]/.test(l));
    assert.deepEqual(keptHigh, high, "all 40 high-confidence lines first, stable order");
    const keptLow = kept.filter((l) => /\[basename, low\]/.test(l));
    assert.equal(keptLow.length, 110, "low-confidence fills exactly the remaining budget");
    assert.deepEqual(
      keptLow,
      evidence.filter((l) => /\[basename, low\]/.test(l)).slice(0, 110),
      "admitted low lines keep stable order",
    );
  });

  it("leaves rendered evidence under the cap untouched", () => {
    const evidence = [...lowFanOut(100), "src/x.ts -> tests/x.test.ts [symbol, high]"];
    const out = renderEvidence(evidence);
    assert.equal(out.split("\n").length, 101, "no trailer when under the cap");
    assert.ok(!/omitted/.test(out), "no omission trailer below the cap");
  });
});
