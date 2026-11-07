// Scan report: full uncapped evidence file plus re-save diffing.

import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

/** Repo-relative path of the full scan evidence file. */
export const SCAN_EVIDENCE_PATH = ".pi/workflow/scan-evidence.md";

/** Result of diffing two scan digests. */
export interface ScanDiff {
  added: string[];
  removed: string[];
  unchanged: number;
}

/**
 * Build the digest lines (one per evidence/warning line) used for diffing.
 *
 * @param evidence - Raw evidence lines.
 * @param warnings - Warning lines.
 * @returns Prefixed digest lines.
 */
export function scanDigest(evidence: readonly string[], warnings: readonly string[]): string[] {
  return [...evidence.map((e) => `evidence: ${e}`), ...warnings.map((w) => `warning: ${w}`)];
}

/**
 * Diff a previous digest against the current one (multiset semantics).
 *
 * @param prev - Previous digest lines.
 * @param next - Current digest lines.
 * @returns Added, removed lines and the unchanged count.
 */
export function diffScanDigest(prev: readonly string[], next: readonly string[]): ScanDiff {
  const counts = new Map<string, number>();
  for (const l of prev) counts.set(l, (counts.get(l) ?? 0) + 1);
  const added: string[] = [];
  let unchanged = 0;
  for (const l of next) {
    const c = counts.get(l) ?? 0;
    if (c > 0) {
      counts.set(l, c - 1);
      unchanged++;
    } else added.push(l);
  }
  const removed: string[] = [];
  for (const [l, c] of counts) for (let i = 0; i < c; i++) removed.push(l);
  return { added, removed, unchanged };
}

/**
 * Render the full uncapped scan report markdown.
 *
 * @param evidence - Raw evidence lines.
 * @param warnings - Warning lines.
 * @returns Markdown content.
 */
export function renderScanReport(evidence: readonly string[], warnings: readonly string[]): string {
  const ev = evidence.length > 0 ? evidence.map((l) => `- ${l}`).join("\n") : "(none)";
  const wa = warnings.length > 0 ? warnings.map((w) => `- warning: ${w}`).join("\n") : "(none)";
  return `# Scan evidence\n\n## Evidence\n${ev}\n\n## Warnings\n${wa}\n`;
}

/**
 * Write the full scan report to SCAN_EVIDENCE_PATH under cwd.
 *
 * @param cwd      - Project root.
 * @param evidence - Raw evidence lines.
 * @param warnings - Warning lines.
 * @returns The repo-relative path written, or null on failure.
 */
export async function writeScanReport(
  cwd: string,
  evidence: readonly string[],
  warnings: readonly string[],
): Promise<string | null> {
  try {
    const abs = join(cwd, SCAN_EVIDENCE_PATH);
    await mkdir(join(cwd, ".pi/workflow"), { recursive: true });
    await writeFile(abs, renderScanReport(evidence, warnings), "utf8");
    return SCAN_EVIDENCE_PATH;
  } catch {
    return null;
  }
}

/**
 * Render the re-save delta text.
 *
 * @param diff - Diff result.
 * @returns Tool-facing delta text.
 */
export function renderScanDiff(diff: ScanDiff): string {
  const lines = ["## Scan changes since last save"];
  for (const l of diff.added) lines.push(`+ ${l}`);
  for (const l of diff.removed) lines.push(`- ${l}`);
  lines.push(`${diff.unchanged} unchanged lines`);
  return lines.join("\n");
}
