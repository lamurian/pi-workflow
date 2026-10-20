// ─── Deterministic test-scan derivation layers ─────────────────────────────
// Pure module, split from test-scan.ts to stay under the 300-line rule.
// Depends only on the profile/data table in test-scan-profiles.ts.

import { profileFor, isTestPath, buildImportRegex, escapeRe } from "./test-scan-profiles.ts";
import type { LangProfile } from "./test-scan-profiles.ts";

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
