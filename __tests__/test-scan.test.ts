import { describe, it } from "vitest";
import assert from "node:assert/strict";
import {
  LANG_PROFILES,
  profileFor,
  escapeRe,
  isTestPath,
  buildImportRegex,
  deriveMatches,
  crossCheck,
} from "../extensions/test-scan.ts";

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
