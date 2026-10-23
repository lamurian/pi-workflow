/**
 * Unit context preload (T7): embed the current on-disk contents of the
 * contract's declared M/D files into the unit task text so a bash-free unit
 * never has to read the whole file itself. Caps: 64 KB per file, 256 KB in
 * total; truncated files are marked. Declared A paths are listed as
 * "(new file)" without content.
 */

import { openSync, readSync, closeSync, statSync } from "node:fs";
import { join } from "node:path";
import type { FileEntry } from "./state.ts";

/** Per-file preload cap: 64 KB. */
export const PRELOAD_PER_FILE_CAP = 64 * 1024;
/** Total preload cap across all files: 256 KB. */
export const PRELOAD_TOTAL_CAP = 256 * 1024;

/**
 * Read at most `limit` bytes from the head of a file.
 *
 * @param path  - Absolute file path.
 * @param limit - Maximum bytes to read.
 * @returns The bytes read as a utf8 string.
 */
function readHead(path: string, limit: number): string {
  const fd = openSync(path, "r");
  try {
    const buf = Buffer.alloc(limit);
    const bytes = readSync(fd, buf, 0, limit, 0);
    return buf.subarray(0, bytes).toString("utf8");
  } finally {
    closeSync(fd);
  }
}

/**
 * Build the context-preload section for one unit task text.
 *
 * Declared M and D files that exist on disk contribute a fenced block with
 * their current contents (64 KB per file, 256 KB total; over-long content is
 * truncated and marked). Declared A paths are listed as "(new file)". The
 * section is empty when there is nothing to preload.
 *
 * @param files - The contract's declared allowlist entries.
 * @param cwd   - Repository working directory.
 * @returns The markdown section ("" when nothing preloads).
 */
export function buildContextPreload(
  files: readonly FileEntry[],
  cwd: string,
): string {
  const lines: string[] = [];
  let budget = PRELOAD_TOTAL_CAP;
  for (const f of files) {
    if (f.status === "A") {
      lines.push(`- ${f.path} (new file)`);
      continue;
    }
    let size: number;
    try {
      size = statSync(join(cwd, f.path)).size;
    } catch {
      continue; // not on disk — nothing to preload
    }
    const cap = Math.min(PRELOAD_PER_FILE_CAP, budget);
    const text = readHead(join(cwd, f.path), cap);
    budget -= Buffer.byteLength(text);
    const truncated = size > Buffer.byteLength(text);
    lines.push(`### ${f.path} (${f.status})`, "", "```", text, "```", "");
    if (truncated) {
      lines.push(`(truncated: showing first ${Buffer.byteLength(text)} of ${size} bytes)`, "");
    }
  }
  if (lines.length === 0) return "";
  return ["## Preloaded declared file contents", "", ...lines].join("\n");
}
