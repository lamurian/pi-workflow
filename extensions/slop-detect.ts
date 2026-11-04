// ── Slop toolchain detection and staged-path partitioning (T2) ────────────────
// Pure extension-based partitioning plus resolveSlopTool's lookup ladder:
// local node_modules/.bin → `which` on PATH → npx fetch fallback. Every
// subprocess answer comes from ExecResult.code; fs facts from node:fs.

import { existsSync } from "node:fs";
import { join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

// ── Data tables ───────────────────────────────────────────────────────────────

/** File extensions classified as code (scored against codeFailBelow). */
const CODE_EXTENSIONS: ReadonlySet<string> = new Set([
  "ts", "tsx", "js", "jsx", "mjs", "cjs", "py", "go", "rs", "rb", "php",
  "java", "cs", "c", "cc", "cpp", "h", "hpp",
]);

/** File extensions classified as prose (scored against proseGate). */
const PROSE_EXTENSIONS: ReadonlySet<string> = new Set(["md", "mdx", "txt"]);

/** Specification for one supported slop tool. */
interface SlopToolSpec {
  /** npm package name for the npx fetch fallback (equals the bin name). */
  pkg: string;
  /** When true the tool needs python3 on PATH before it can run. */
  requiresPython: boolean;
}

/** Supported slop tools keyed by executable name; other bins resolve to null. */
const SLOP_TOOLS: Readonly<Record<string, SlopToolSpec>> = {
  aislop: { pkg: "aislop", requiresPython: false },
  "zero-slop": { pkg: "zero-slop", requiresPython: true },
};

// ── Types ─────────────────────────────────────────────────────────────────────

/** Partitioned staged paths: code and prose buckets, input order preserved. */
export interface StagedPartition {
  /** Paths with a code extension. */
  code: string[];
  /** Paths with a prose extension. */
  prose: string[];
}

// ── Helpers ───────────────────────────────────────────────────────────────────

/**
 * Extract the lowercase file extension of a (possibly nested) path.
 *
 * @param path - Staged path using `/` separators (git style).
 * @returns The extension without the dot, or null when the path has none
 *          (dotfiles such as `.gitignore` count as extension-less).
 */
function extensionOf(path: string): string | null {
  const base = path.slice(Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\")) + 1);
  const dot = base.lastIndexOf(".");
  if (dot <= 0) return null;
  return base.slice(dot + 1).toLowerCase();
}

/**
 * Probe PATH for an executable via `which <name>`.
 *
 * @param pi  - ExtensionAPI reference (for exec access).
 * @param cwd - Working directory for the probe.
 * @param name - Executable name to look up.
 * @returns True only when `which` exits 0; a thrown exec counts as not found.
 */
async function onPath(
  pi: ExtensionAPI,
  cwd: string,
  name: string,
): Promise<boolean> {
  try {
    const res = await pi.exec("which", [name], { cwd });
    return res.code === 0;
  } catch {
    return false;
  }
}

// ── Partitioning ──────────────────────────────────────────────────────────────

/**
 * Partition staged paths into code and prose buckets by file extension.
 *
 * Classification is extension-based: the text after the last dot of the
 * basename decides (`src/x.ts` → code). Paths without a recognized code or
 * prose extension (package.json, images, Makefile, …) are ignored — they
 * belong to neither bucket. Input order is preserved within each bucket.
 *
 * @param paths - Staged paths, e.g. from `git diff --cached --name-only`.
 * @returns The code and prose buckets.
 */
export function partitionStagedPaths(paths: readonly string[]): StagedPartition {
  const partition: StagedPartition = { code: [], prose: [] };
  for (const path of paths) {
    const ext = extensionOf(path);
    if (ext === null) continue;
    if (CODE_EXTENSIONS.has(ext)) partition.code.push(path);
    else if (PROSE_EXTENSIONS.has(ext)) partition.prose.push(path);
  }
  return partition;
}

// ── Tool resolution ───────────────────────────────────────────────────────────

/**
 * Resolve the argv for a slop-scoring tool, or null when unavailable.
 *
 * Lookup ladder (first hit wins):
 * 1. Unsupported bin (not aislop/zero-slop) → null.
 * 2. zero-slop requires python3: `which python3` non-zero → null, checked
 *    before everything else so an unusable tool is never handed out.
 * 3. `<cwd>/node_modules/.bin/<bin>` exists → `[localPath]`.
 * 4. `which <bin>` exits 0 → `[bin]`.
 * 5. `fetchFallback` → `["npx", "--yes", "<pkg>@latest"]` (pkg = bin name).
 * 6. Otherwise → null.
 *
 * @param pi           - ExtensionAPI reference (for exec access).
 * @param cwd          - Project root to probe for a local install.
 * @param bin          - Tool executable: "aislop" or "zero-slop".
 * @param fetchFallback - Allow the npx network fallback when not installed.
 * @returns The argv to run the tool, or null when it cannot be resolved.
 */
export async function resolveSlopTool(
  pi: ExtensionAPI,
  cwd: string,
  bin: string,
  fetchFallback: boolean,
): Promise<string[] | null> {
  const spec = SLOP_TOOLS[bin];
  if (!spec) return null;

  if (spec.requiresPython && !(await onPath(pi, cwd, "python3"))) return null;

  const localBin = join(cwd, "node_modules", ".bin", bin);
  if (existsSync(localBin)) return [localBin];

  if (await onPath(pi, cwd, bin)) return [bin];

  if (fetchFallback) return ["npx", "--yes", `${spec.pkg}@latest`];
  return null;
}
