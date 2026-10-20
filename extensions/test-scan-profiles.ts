// ─── Deterministic language-agnostic test scan ─────────────────────────────────
// Pure module, split from test-scan.ts to stay under the 300-line rule.
// Holds the language profile table plus path predicates and import-regex
// builders shared by derivation (test-scan-derive.ts) and the commit gate.
// No shell grep (JS-side RegExp only), no AST, no project sniffing, no config.

/** Per-language conventions: test paths, import shape, declarations, skips. */
export interface LangProfile {
  id: string;
  /** Extensions including dot, lowercase. */
  exts: string[];
  /** Test-path patterns matched against full forward-slash paths. */
  testPathPatterns: RegExp[];
  /** Import-path pattern with {base} placeholder (boundary-aware). */
  importPattern: string;
  /** Exported-declaration patterns, capture group 1 = symbol name. */
  declarationPatterns: RegExp[];
  /** Skip/only markers for the staged-diff guard. */
  skipPatterns: RegExp[];
}

const JS_TEST = /\.(test|spec)\.[cm]?[jt]sx?$|(^|\/)(__tests__|tests?|spec)\//;
const PY_TEST = /(^|\/)(tests?|test_[^/]+)\/|test_[^/]+\.py$|_test\.py$/;
const GO_TEST = /_test\.go$|(^|\/)tests?\//;
const RUST_TEST = /(^|\/)tests\/|_test\.rs$/;
const JAVA_TEST = /Test(s)?\.(java|kt|kts)$|(^|\/)(tests?|spec)\//;
const CS_TEST = /Tests?\.(cs)$|(^|\/)(tests?|spec)\//;
const RB_TEST = /_spec\.rb$|(^|\/)(tests?|spec)\//;
const PHP_TEST = /Test\.php$|(^|\/)(tests?|spec)\//;

/** Language profiles for the mainstream ecosystems. Data, not logic. */
export const LANG_PROFILES: LangProfile[] = [
  {
    id: "javascript",
    exts: [".js", ".jsx", ".ts", ".tsx", ".mjs", ".cjs", ".mts", ".cts"],
    testPathPatterns: [JS_TEST],
    importPattern: "['\"](?:\\.\\.?/|@/)?{base}(\\.[cm]?[jt]sx?)?['\"]",
    declarationPatterns: [
      /export\s+(?:async\s+)?(?:function|class|const|let|var|interface|type|enum)\s+([A-Za-z_$][\w$]*)/g,
      /export\s*\{([^}]*)\}/g,
    ],
    skipPatterns: [
      /\b(?:it|test|describe)(?:\.\w+)*\.skip\b/g,
      /\bxit\s*\(/g,
      /\.\s*only\s*\(/g,
    ],
  },
  {
    id: "python",
    exts: [".py"],
    testPathPatterns: [PY_TEST],
    importPattern: "(?:^|\\s)(?:from\\s+{base}\\b|import\\s+{base}\\b)",
    declarationPatterns: [
      /^\s*(?:async\s+)?def\s+([A-Za-z_]\w*)/gm,
      /^\s*class\s+([A-Za-z_]\w*)/gm,
      /^([A-Za-z_]\w*)\s*=/gm,
    ],
    skipPatterns: [/@pytest\.mark\.skip(?:if)?\b/g, /\bskipTest\s*\(/g],
  },
  {
    id: "go",
    exts: [".go"],
    testPathPatterns: [GO_TEST],
    importPattern: "['\"][^'\"]*/{base}(/)?['\"]",
    declarationPatterns: [
      /^func\s+(?:\([^)]*\)\s*)?([A-Za-z_]\w*)/gm,
      /^type\s+([A-Za-z_]\w*)/gm,
      /^const\s+([A-Za-z_]\w*)/gm,
    ],
    skipPatterns: [/\bt\.Skip(f|now)?\s*\(/g],
  },
  {
    id: "rust",
    exts: [".rs"],
    testPathPatterns: [RUST_TEST],
    importPattern: "(?:^|\\s)(?:use\\s+[^;]*::{base}\\b|use\\s+[^;]*\\b{base}\\s*(?:::|;))",
    declarationPatterns: [
      /pub\s+(?:async\s+)?fn\s+([A-Za-z_]\w*)/g,
      /pub\s+(?:struct|enum|trait|type)\s+([A-Za-z_]\w*)/g,
    ],
    skipPatterns: [/#\[\s*ignore\b/g],
  },
  {
    id: "java",
    exts: [".java"],
    testPathPatterns: [JAVA_TEST],
    importPattern: "^\\s*import\\s+[\\w.]*\\.{base}\\b",
    declarationPatterns: [
      /public\s+(?:static\s+)?(?:final\s+)?(?:class|interface|enum)\s+([A-Za-z_]\w*)/g,
    ],
    skipPatterns: [/@Disabled\b/g, /@Ignore\b/g],
  },
  {
    id: "kotlin",
    exts: [".kt", ".kts"],
    testPathPatterns: [JAVA_TEST],
    importPattern: "^\\s*import\\s+[\\w.]*\\.{base}\\b",
    declarationPatterns: [
      /(?:public\s+)?(?:final\s+)?(?:class|interface|object|fun)\s+([A-Za-z_]\w*)/g,
    ],
    skipPatterns: [/@Disabled\b/g, /@Ignore\b/g],
  },
  {
    id: "csharp",
    exts: [".cs"],
    testPathPatterns: [CS_TEST],
    importPattern: "^\\s*using\\s+[\\w.]*\\.{base}\\b",
    declarationPatterns: [
      /public\s+(?:static\s+)?(?:sealed\s+)?(?:class|interface|struct|enum|record)\s+([A-Za-z_]\w*)/g,
    ],
    skipPatterns: [/\[Fact(?:\(.*\))?\]\s*\n\s*\[Skip\]/g, /\bSkip\s*=/g],
  },
  {
    id: "ruby",
    exts: [".rb"],
    testPathPatterns: [RB_TEST],
    importPattern: "(?:require|load)\\s*\\(?\\s*['\"][^'\"]*{base}['\"]",
    declarationPatterns: [
      /^\s*def\s+(?:self\.)?([A-Za-z_]\w*[?!]?)/gm,
      /^\s*class\s+([A-Za-z_]\w*)/gm,
    ],
    skipPatterns: [/\bskip\b(?![\w])/g, /\bpending\b(?![\w])/g],
  },
  {
    id: "php",
    exts: [".php"],
    testPathPatterns: [PHP_TEST],
    importPattern: "(?:use|require(?:_once)?|include(?:_once)?)\\s+[^;]*\\b{base}\\b",
    declarationPatterns: [
      /(?:public\s+|private\s+|protected\s+)?(?:static\s+)?function\s+&?(\w+)/g,
      /(?:abstract\s+|final\s+)?class\s+(\w+)/g,
    ],
    skipPatterns: [/@skip\b/g, /markTestSkipped\s*\(/g],
  },
];

/**
 * Resolve the language profile for a file extension.
 *
 * @param ext - Extension including dot, case-insensitive (e.g. ".PY").
 * @returns The matching profile, or null when no profile covers the extension.
 */
export function profileFor(ext: string): LangProfile | null {
  const lower = ext.toLowerCase();
  return LANG_PROFILES.find((p) => p.exts.includes(lower)) ?? null;
}

/**
 * Escape regex metacharacters in a literal string.
 *
 * @param s - Literal text (e.g. a basename like "a+b.ts").
 * @returns A pattern source matching only the literal string.
 */
export function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Union-semantics test-path predicate across all profiles.
 *
 * Shared with the commit-gate guard: the guard protects broadly (worst case
 * a stricter guard), while the scan applies only the matched per-entry
 * profile for precision.
 *
 * @param p - Forward-slash file path relative to repo root.
 * @returns True when any profile recognizes the path as a test file.
 */
export function isTestPath(p: string): boolean {
  const norm = p.replace(/\\/g, "/");
  return LANG_PROFILES.some((profile) =>
    profile.testPathPatterns.some((re) => re.test(norm)),
  );
}

/**
 * Build the boundary-aware import regex for a profile and basename.
 *
 * @param profile - Language profile supplying the import pattern template.
 * @param basename - Source basename without extension (e.g. "auth").
 * @returns A RegExp matching import/require/use lines referencing the basename.
 */
export function buildImportRegex(profile: LangProfile, basename: string): RegExp {
  const source = profile.importPattern.replaceAll("{base}", escapeRe(basename));
  return new RegExp(source, "m");
}
