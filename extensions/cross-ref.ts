import { readFile, readdir } from "node:fs/promises";
import { resolve, isAbsolute, join } from "node:path";
import { existsSync } from "node:fs";

/** Result of resolving cross-references in a document. */
export interface ResolvedRefs {
  /** The full content of the resolved document. */
  content: string;
  /** Resolved file paths in the order they were visited (document first). */
  chain: string[];
  /** Errors encountered during resolution. */
  errors: string[];
}

/**
 * Extract all @path/to/file references from text content.
 *
 * Matches `@` followed by a file path (relative or absolute).
 *
 * @param content - Text content to scan.
 * @returns Array of referenced file paths (with @ prefix stripped).
 */
export function extractRefs(content: string): string[] {
  const refs: string[] = [];
  const regex = /@(\S+(?:\.md|\.ts|\.js|\.json|\.yaml|\.yml))/g;
  let match: RegExpExecArray | null;
  while ((match = regex.exec(content)) !== null) {
    refs.push(match[1]);
  }
  return refs;
}

/**
 * Scan a directory for files matching `NNN-*.md` and build a map of number→filename.
 *
 * @param dir - Absolute path to the directory to scan.
 * @returns Map of 3-digit number string to exact filename.
 */
async function buildNumberToFileMap(dir: string): Promise<Map<string, string>> {
  const map = new Map<string, string>();
  if (!existsSync(dir)) return map;

  try {
    const files = await readdir(dir);
    for (const file of files) {
      const match = file.match(/^(\d{3})-/);
      if (match) {
        map.set(match[1], file);
      }
    }
  } catch {
    // Ignore unreadable directories
  }

  return map;
}

/**
 * Normalize cross-references in document content.
 *
 * Resolves glob patterns and human-readable labels to exact file paths:
 * 1. `@docs/ADR/NNN-*.md` → `@docs/ADR/NNN-exact-slug.md`
 * 2. `@docs/specs/NNN-*.md` → `@docs/specs/NNN-exact-slug.md`
 * 3. `ADR NNN: Title` → `ADR NNN: @docs/ADR/NNN-exact-slug.md`
 * 4. `Spec NNN: Title` → `Spec NNN: @docs/specs/NNN-exact-slug.md`
 *
 * When no matching file is found for a number, the original text is left unchanged.
 *
 * @param content - Raw markdown content with loose references.
 * @param cwd     - Project working directory.
 * @returns Content with all references resolved to exact file paths.
 */
export async function normalizeReferences(
  content: string,
  cwd: string,
): Promise<string> {
  if (!content) return content;

  const adrDir = join(cwd, "docs", "ADR");
  const specsDir = join(cwd, "docs", "specs");

  const adrMap = await buildNumberToFileMap(adrDir);
  const specMap = await buildNumberToFileMap(specsDir);

  let result = content;

  // 1. Resolve @docs/ADR/NNN-*.md globs
  result = result.replace(
    /@docs\/ADR\/(\d{3})-\*\.md/g,
    (_match, num: string) => {
      const file = adrMap.get(num);
      return file ? `@docs/ADR/${file}` : _match;
    },
  );

  // 2. Resolve @docs/specs/NNN-*.md globs
  result = result.replace(
    /@docs\/specs\/(\d{3})-\*\.md/g,
    (_match, num: string) => {
      const file = specMap.get(num);
      return file ? `@docs/specs/${file}` : _match;
    },
  );

  // 3. Convert "ADR NNN: Title" to "ADR NNN: @docs/ADR/NNN-slug.md"
  result = result.replace(
    /ADR (\d{3}): ([^\n]+)/g,
    (_match, num: string, title: string) => {
      // Skip if already an @doc reference
      if (title.trim().startsWith("@docs/")) return _match;
      const file = adrMap.get(num);
      return file ? `ADR ${num}: @docs/ADR/${file}` : _match;
    },
  );

  // 4. Convert "Spec NNN: Title" to "Spec NNN: @docs/specs/NNN-slug.md"
  result = result.replace(
    /Spec (\d{3}): ([^\n]+)/g,
    (_match, num: string, title: string) => {
      // Skip if already an @doc reference
      if (title.trim().startsWith("@docs/")) return _match;
      const file = specMap.get(num);
      return file ? `Spec ${num}: @docs/specs/${file}` : _match;
    },
  );

  return result;
}

/**
 * Build a map of number to filename for cross-reference resolution.
 *
 * Scans the ADR and specs directories and returns a combined map for
 * quick lookup.
 *
 * @param cwd - Project working directory.
 * @returns Object with adrMap and specMap.
 */
export async function buildReferenceMaps(
  cwd: string,
): Promise<{ adrMap: Map<string, string>; specMap: Map<string, string> }> {
  const adrDir = join(cwd, "docs", "ADR");
  const specsDir = join(cwd, "docs", "specs");

  return {
    adrMap: await buildNumberToFileMap(adrDir),
    specMap: await buildNumberToFileMap(specsDir),
  };
}

/**
 * Resolve a file path relative to the project root.
 *
 * If the path is already absolute, it is returned as-is.
 *
 * @param ref  - The file path from an @ reference.
 * @param cwd  - Project working directory.
 * @returns The absolute file path.
 */
function resolveRef(ref: string, cwd: string): string {
  return isAbsolute(ref) ? ref : resolve(cwd, ref);
}

/**
 * Recursively resolve cross-references in a document.
 *
 * Reads the document at `filePath`, scans for @path references,
 * and recursively reads each referenced file. The result includes
 * the full content of all resolved files concatenated in order.
 *
 * Cycle detection prevents infinite loops — if a file has already
 * been visited, it is skipped.
 *
 * @param filePath - Absolute path to the entry document.
 * @param cwd      - Project working directory.
 * @param visited  - Set of already-visited paths (for cycle detection).
 * @returns Resolved content, chain, and any errors.
 */
export async function resolveCrossReferences(
  filePath: string,
  cwd: string,
  visited: Set<string> = new Set(),
): Promise<ResolvedRefs> {
  const absPath = isAbsolute(filePath)
    ? filePath
    : resolve(cwd, filePath);

  if (visited.has(absPath)) {
    return { content: "", chain: [], errors: [] };
  }
  visited.add(absPath);

  let content: string;
  try {
    content = await readFile(absPath, "utf-8");
  } catch (err) {
    return {
      content: "",
      chain: [],
      errors: [`Failed to read ${absPath}: ${(err as Error).message}`],
    };
  }

  const chain = [absPath];
  const errors: string[] = [];

  // Recursively resolve @ refs in the content
  const refs = extractRefs(content);
  for (const ref of refs) {
    const refAbs = resolveRef(ref, cwd);
    if (visited.has(refAbs)) continue;

    const resolved = await resolveCrossReferences(refAbs, cwd, visited);
    errors.push(...resolved.errors);

    // Append referenced content after the current content
    if (resolved.content) {
      content += `\n\n---\n### Referenced: ${ref}\n\n${resolved.content}`;
    }
    chain.push(...resolved.chain);
  }

  return { content, chain, errors };
}
