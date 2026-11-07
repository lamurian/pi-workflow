import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import type { FileEntry } from "./state.ts";
import { isTestPath } from "./test-scan-profiles.ts";
import { deriveMatches, type DeriveResult } from "./test-scan-derive.ts";
import { crossCheck } from "./test-scan-check.ts";

/** Scan exec budget: enumerate + read is local I/O, 5s covers cold caches. */
const SCAN_BUDGET_MS = 5000;
/** Per-file size cap for JS-side reads; larger files are skipped, not fatal. */
const MAX_SCAN_FILE_BYTES = 256 * 1024;
/** git listing args: tracked plus untracked, honoring .gitignore. */
export const SCAN_LS_FILES_ARGS = ["ls-files", "--cached", "--others", "--exclude-standard"];

/** Read a file JS-side with size cap and binary sniffing; null when skipped. */
function readCapped(full: string): string | null {
  try {
    const stat = statSync(full);
    if (!stat.isFile() || stat.size > MAX_SCAN_FILE_BYTES) return null;
    const buf = readFileSync(full);
    if (buf.subarray(0, 1024).includes(0)) return null;
    return buf.toString("utf8");
  } catch {
    return null;
  }
}

/**
 * Run the deterministic contract scan for a drafted contract.
 *
 * Enumerates files via `git ls-files --cached --others --exclude-standard`
 * (so gitignored paths never appear), reads matched test files and contract
 * entries JS-side, derives per-entry findings and cross-checks them.
 *
 * @param pi    - ExtensionAPI reference (for exec access).
 * @param cwd   - Working directory to scan.
 * @param files - The contract's declared file entries ({ path, status }).
 * @returns Evidence + warnings, or null when the scan is unavailable
 *          (exec failure, non-zero exit, empty listing).
 */
export async function runContractScan(
  pi: ExtensionAPI,
  cwd: string,
  files: readonly FileEntry[],
): Promise<{ evidence: string[]; warnings: string[] } | null> {
  try {
    const res = await pi.exec("git", [...SCAN_LS_FILES_ARGS], { cwd, timeout: SCAN_BUDGET_MS });
    if (res.code !== 0) return null;
    const listing = (res.stdout ?? "")
      .split("\n")
      .map((l) => l.trim().replace(/^\.\//, ""))
      .filter(Boolean);
    if (listing.length === 0) return null;
    const onDisk = new Set(listing);
    const paths = files.map((f) => f.path);
    const contents = new Map<string, string>();
    for (const p of listing) {
      if (!isTestPath(p) && !paths.includes(p)) continue;
      const text = readCapped(join(cwd, p));
      if (text !== null) contents.set(p, text);
    }
    const findings = new Map<string, DeriveResult>();
    for (const f of files) findings.set(f.path, deriveMatches(f.path, contents));
    const result = crossCheck(files, findings, onDisk);
    return { evidence: result.evidence, warnings: result.warnings };
  } catch {
    return null;
  }
}
