// ─── Deterministic language-agnostic test scan ─────────────────────────────────
// Pure module: profiles, path predicates, four derivation layers, cross-check.
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

// ─── Derivation layers ─────────────────────────────────────────────────────────

/** How a test file was matched to a source entry. */
export type MatchMethod = "structural" | "import-path" | "symbol" | "basename";
/** Confidence tag for an evidence line. */
export type MatchConfidence = "high" | "low";

/** One test-file match for one source entry. */
export interface MatchRecord {
  path: string;
  method: MatchMethod;
  confidence: MatchConfidence;
}

/** Result of deriving matches for one source entry. */
export interface DeriveResult {
  matches: MatchRecord[];
  /** Present when derivation itself is unreliable (e.g. barrel chains). */
  note?: string;
}

const BARREL = /export\s*\*\s*from\s*['"]([^'"]+)['"]/g;
const MAX_SYMBOLS = 100;
const SKIP_EXT = new Set([".snap", ".map", ".min.js", ".min.css"]);

/** Basename without directory or extension: "src/auth.ts" -> "auth". */
function baseNameNoExt(p: string): string {
  const base = p.split("/").pop() ?? p;
  const stripped = base.replace(/\.(test|spec)\.[^.]+$/i, "").replace(/\._test$/i, "");
  return stripped.replace(/\.[^.]+$/, "").replace(/_test$/, "").replace(/^test_/, "");
}

/** Normalize a test path for structural comparison: strip test decorations. */
function structuralKey(p: string): string {
  let s = p.replace(/\\/g, "/").replace(/^\.\//, "");
  s = s.replace(/(^|\/)(__tests__|tests?|spec|test)\/(test_)?/g, "$1");
  s = s.replace(/\.(test|spec)\.[^.]+$/i, "");
  s = s.replace(/_test\.[^.]+$/i, "");
  s = s.replace(/Test(s)?\.[^.]+$/i, "");
  s = s.replace(/_spec\.[^.]+$/i, "");
  s = s.replace(/test_([^/]+)\.py$/i, "$1.py");
  return s.replace(/\.[^.]+$/, "").toLowerCase();
}

/**
 * Extract exported symbol names from source content (regex-level, capped).
 *
 * Handles `export function name`-style declarations and one-level
 * `export { A, B as C }` lists (alias targets dropped: A, B survive).
 * Barrel `export * from` targets are NOT resolved here — the caller does
 * one-level resolution before calling this.
 *
 * @param profile - Language profile supplying declaration patterns.
 * @param content - Source file content.
 * @returns Deduplicated symbol names, capped at MAX_SYMBOLS.
 */
export function extractSymbols(profile: LangProfile, content: string): string[] {
  const names = new Set<string>();
  for (const re of profile.declarationPatterns) {
    re.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = re.exec(content)) !== null && names.size < MAX_SYMBOLS) {
      const capture = m[1] ?? "";
      if (re.source.includes("\\{")) {
        // export { A, B as C } — split the list, keep original names.
        for (const part of capture.split(",")) {
          const orig = part.trim().split(/\s+as\s+/)[0]?.trim();
          if (orig && /^[A-Za-z_$][\w$]*$/.test(orig)) names.add(orig);
        }
      } else if (/^[A-Za-z_$][\w$]*$/.test(capture)) {
        names.add(capture);
      }
      if (m[0] === "") re.lastIndex++;
    }
  }
  return [...names].slice(0, MAX_SYMBOLS);
}

/**
 * Derive test-file matches for one source entry via four layers.
 *
 * Layer order: structural (path mirroring) -> import-path (boundary-aware
 * import lines) -> symbol (exported names, one-level barrel resolution) ->
 * basename fallback (low confidence). First matching layer wins per file.
 *
 * @param sourceEntry - Contract files entry (e.g. "src/auth.ts").
 * @param testFiles - Map of test-file path -> content (already filtered by isTestPath).
 * @returns Match records plus an optional note when derivation is unreliable.
 */
export function deriveMatches(
  sourceEntry: string,
  testFiles: ReadonlyMap<string, string>,
): DeriveResult {
  const matches: MatchRecord[] = [];
  const basename = baseNameNoExt(sourceEntry);
  const ext = sourceEntry.slice(sourceEntry.lastIndexOf("."));
  const profile = profileFor(ext);
  const structKey = structuralKey(sourceEntry);
  let note: string | undefined;

  // Symbol layer inputs: source content with one-level barrel resolution.
  let symbolSource = "";
  if (profile) {
    // The caller may include the source file itself in the map for context;
    // fall back to scanning the map for a same-basename source entry.
    symbolSource = testFiles.get(sourceEntry) ?? "";
    if (!symbolSource && profile) {
      for (const [p, c] of testFiles) {
        if (!isTestPath(p) && baseNameNoExt(p) === basename) { symbolSource = c; break; }
      }
    }
    const barrels = [...symbolSource.matchAll(BARREL)];
    if (barrels.length > 0) {
      const target = barrels[0]![1]!;
      const resolved = resolveRelative(sourceEntry, target);
      const resolvedContent = testFiles.get(resolved) ?? findInMap(testFiles, resolved);
      if (resolvedContent && !/export\s*\*\s*from/.test(resolvedContent)) {
        symbolSource = resolvedContent;
      } else if (resolvedContent && /export\s*\*\s*from/.test(resolvedContent)) {
        note = "unverified: indirect re-export (barrel chain deeper than one level); classify by reading the tests";
        symbolSource = "";
      } else {
        note = "unverified: re-export target not readable in scan set; classify by reading the tests";
        symbolSource = "";
      }
    }
  }

  const symbols = profile && symbolSource ? extractSymbols(profile, symbolSource) : [];

  for (const [path, content] of testFiles) {
    if (!isTestPath(path)) continue;
    if (SKIP_EXT.has(path.slice(path.lastIndexOf(".")))) continue;

    // Layer 1: structural mirroring (path-segment-boundary suffix compare).
    const pk = structuralKey(path);
    if (
      pk &&
      (pk === structKey || structKey.endsWith("/" + pk) || pk.endsWith("/" + structKey))
    ) {
      matches.push({ path, method: "structural", confidence: "high" });
      continue;
    }

    // Layer 2: boundary-aware import-path.
    if (profile && buildImportRegex(profile, basename).test(content)) {
      matches.push({ path, method: "import-path", confidence: "high" });
      continue;
    }

    // Layer 3: exported symbols (import lines carry original names even
    // when aliased: `import { validateUser as vu }`).
    if (symbols.length > 0) {
      const hit = symbols.some((s) => new RegExp(`\\b${escapeRe(s)}\\b`).test(content));
      if (hit) {
        matches.push({ path, method: "symbol", confidence: "high" });
        continue;
      }
    }

    // Layer 4: basename fallback, low confidence.
    if (new RegExp(`\\b${escapeRe(basename)}\\b`).test(content)) {
      matches.push({ path, method: "basename", confidence: "low" });
    }
  }

  return note ? { matches, note } : { matches };
}

/** Resolve a relative import target against the source entry's directory. */
function resolveRelative(sourceEntry: string, target: string): string {
  if (!target.startsWith(".")) return target;
  const dir = sourceEntry.split("/").slice(0, -1).join("/");
  const parts = (dir ? dir + "/" + target : target).split("/");
  const out: string[] = [];
  for (const part of parts) {
    if (part === "." || part === "") continue;
    if (part === "..") out.pop();
    else out.push(part);
  }
  return out.join("/");
}

/** Find a map entry by path suffix (extension-flexible barrel targets). */
function findInMap(map: ReadonlyMap<string, string>, resolved: string): string | undefined {
  const key = resolved.replace(/\.[^.]+$/, "");
  for (const [p, c] of map) {
    if (p.replace(/\.[^.]+$/, "") === key) return c;
  }
  return undefined;
}

// ─── Cross-check classifier ────────────────────────────────────────────────────

/** Advisory warnings produced by crossCheck. */
export type ScanWarningKind = "undeclared-referencing" | "declared-not-found" | "no-evidence";

/** Evidence + warnings for one contract. */
export interface CrossCheckResult {
  /** Per-entry evidence lines naming method + confidence, or "unverified". */
  evidence: string[];
  /** Advisory warning lines; never blocking. */
  warnings: string[];
}

/**
 * Cross-check scan findings against the contract's declared files.
 *
 * Pure: takes findings already derived per entry. Renders evidence with
 * confidence tags; zero-hit entries render "unverified", never "clean".
 *
 * @param files - The contract's declared files entries.
 * @param findings - Per-entry deriveMatches results, keyed by files entry.
 * @param onDisk - Paths known to exist (for declared-not-found detection).
 * @returns Evidence lines and advisory warnings.
 */
export function crossCheck(
  files: readonly string[],
  findings: ReadonlyMap<string, DeriveResult>,
  onDisk: ReadonlySet<string>,
): CrossCheckResult {
  const evidence: string[] = [];
  const warnings: string[] = [];
  const declared = new Set(files);
  let totalMatches = 0;

  for (const entry of files) {
    const found = findings.get(entry);
    const matches = found?.matches ?? [];
    totalMatches += matches.length;
    if (found?.note) evidence.push(`${entry}: ${found.note}`);
    if (matches.length === 0) {
      evidence.push(
        `${entry}: unverified — no derivation hit (default export, indirect reference, or no affected tests); confirm by reading the tests or declare known paths in files`,
      );
    } else {
      for (const m of matches) {
        evidence.push(`${entry} -> ${m.path} [${m.method}, ${m.confidence}]`);
      }
    }
    if (!onDisk.has(entry)) {
      warnings.push(
        `declared-not-found: ${entry} matches nothing on disk — likely a typo or a not-yet-created path; verify before /implement`,
      );
    }
  }

  // Undeclared referencing test files (referenced but not in files).
  for (const [, found] of findings) {
    for (const m of found.matches) {
      if (!declared.has(m.path)) {
        warnings.push(
          `undeclared-referencing: ${m.path} references affected code via ${m.method} but is not in files — classify preserved/superseded/obsolete; declare it in files if the contract changes it`,
        );
      }
    }
  }

  if (files.length > 0 && totalMatches === 0) {
    warnings.push(
      `no-evidence: no derivation hits for any declared entry (additive contract?) — verify by reading tests or declare known paths in files`,
    );
  }

  return { evidence, warnings };
}
