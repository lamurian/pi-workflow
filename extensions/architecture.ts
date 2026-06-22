import { readFile, writeFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { existsSync } from "node:fs";
import { loadContent, renderTemplate, formatDate } from "./utils.ts";
import { loadDirectoriesConfig } from "./paths.ts";

/**
 * Status values for ADRs tracked in ARCHITECTURE.md.
 *
 * - `drafted` → [D] ADR drafted
 * - `specified` → [S] specs created
 * - `planned` → [P] plans created
 * - `progressed` → [R] plans in execution
 * - `implemented` → [I] fully implemented
 */
export type AdrStatus = "drafted" | "specified" | "planned" | "progressed" | "implemented";

/** Status-to-marker mapping. */
const STATUS_MARKER: Record<AdrStatus, string> = {
  drafted: "D",
  specified: "S",
  planned: "P",
  progressed: "R",
  implemented: "I",
};

/** Marker-to-status mapping. */
const MARKER_STATUS: Record<string, AdrStatus> = {
  D: "drafted",
  S: "specified",
  P: "planned",
  R: "progressed",
  I: "implemented",
};

/** One entry in ARCHITECTURE.md Implementation Status section. */
export interface ArchitectureEntry {
  /** Relative path from project root (e.g. "docs/ADR/001-slug.md"). */
  filePath: string;
  /** Short human-readable summary. */
  summary: string;
  /** Current status. */
  status: AdrStatus;
}

const STATUS_HEADING = "# Implementation Status";

/**
 * Resolve the absolute path to the architecture document.
 *
 * @param cwd - Project working directory.
 * @returns Absolute path.
 */
async function archPath(cwd: string): Promise<string> {
  const config = await loadDirectoriesConfig(cwd);
  return join(cwd, config.architecture.path);
}

/**
 * Build a single ADR entry line for the Implementation Status section.
 *
 * @param filePath - Relative path to the ADR file (e.g. "docs/ADR/001-slug.md").
 * @param summary  - Short description.
 * @param status   - Current status.
 * @returns Formatted markdown line.
 */
function formatAdrEntry(
  filePath: string,
  summary: string,
  status: AdrStatus,
): string {
  const marker = STATUS_MARKER[status];
  return `- [${marker}] @${filePath} ${summary}`;
}

/**
 * Ensure ARCHITECTURE.md exists with the full template. Creates it if missing.
 *
 * @param cwd - Project working directory.
 */
export async function ensureArchitectureMd(cwd: string): Promise<void> {
  const path = await archPath(cwd);
  if (existsSync(path)) return;

  const template = await loadContent("architecture-template.md");
  const content = renderTemplate(template, {
    date: formatDate(),
    adrEntries: "", // empty — no ADRs yet
  });

  await writeFile(path, content, "utf-8");
}

/**
 * Read all ADR entries from ARCHITECTURE.md Implementation Status section.
 *
 * @param cwd - Project working directory.
 * @returns Array of entries, or empty array if file doesn't exist.
 */
export async function readArchitecture(cwd: string): Promise<ArchitectureEntry[]> {
  const path = await archPath(cwd);
  if (!existsSync(path)) return [];

  const content = await readFile(path, "utf-8");
  const entries: ArchitectureEntry[] = [];

  for (const line of content.split("\n")) {
    // Match: - [I] @docs/ADR/001-slug.md Summary text
    const match = line.match(
      /^\s*-\s+\[([DS PRI])\]\s+@(\S+\.md)\s+(.+)/,
    );
    if (match) {
      const marker = match[1];
      const filePath = match[2];
      const summary = match[3].trim();
      const status = MARKER_STATUS[marker] ?? "drafted";
      entries.push({ filePath, summary, status });
    }
  }

  return entries;
}

/**
 * Add a new ADR entry to ARCHITECTURE.md Implementation Status section.
 *
 * @param cwd      - Project working directory.
 * @param filePath - Relative path to the ADR file (e.g. "docs/ADR/001-slug.md").
 * @param summary  - Short description.
 * @param status   - Initial status (default: "drafted").
 */
export async function addAdrToArchitecture(
  cwd: string,
  filePath: string,
  summary: string,
  status: AdrStatus = "drafted",
): Promise<void> {
  await ensureArchitectureMd(cwd);
  const path = await archPath(cwd);

  const newLine = formatAdrEntry(filePath, summary, status);

  const content = await readFile(path, "utf-8");
  const lines = content.split("\n");

  // Find the Implementation Status section and append
  const headingIndex = lines.findIndex((l) => l.startsWith(STATUS_HEADING));
  if (headingIndex === -1) {
    // Section doesn't exist — append before Data Flow
    const dataFlowIndex = lines.findIndex((l) => l.startsWith("# Data Flow"));
    if (dataFlowIndex !== -1) {
      lines.splice(dataFlowIndex, 0, "", STATUS_HEADING, "", newLine);
    } else {
      lines.push("", STATUS_HEADING, "", newLine);
    }
  } else {
    // Find the next heading (or end of file) after Implementation Status
    let insertAt = headingIndex + 1;
    while (insertAt < lines.length && !lines[insertAt].startsWith("# ")) {
      insertAt++;
    }

    // Check for existing ADR entries in the section
    const contentRange = lines.slice(headingIndex + 1, insertAt);
    const existingEntryIndices: number[] = [];
    for (let i = 0; i < contentRange.length; i++) {
      if (contentRange[i].includes("@docs/ADR/")) {
        existingEntryIndices.push(headingIndex + 1 + i);
      }
    }

    if (existingEntryIndices.length > 0) {
      // Insert after the last existing entry
      const lastEntryIdx = existingEntryIndices[existingEntryIndices.length - 1];
      // Skip past trailing blank lines after the last entry
      let afterLastEntry = lastEntryIdx + 1;
      while (afterLastEntry < insertAt && lines[afterLastEntry].trim() === "") {
        afterLastEntry++;
      }
      lines.splice(afterLastEntry, 0, newLine, "");
    } else {
      // First entry: strip extra blank lines from the template placeholder,
      // keeping exactly one blank line after the heading
      while (insertAt > headingIndex + 2 && lines[insertAt - 1].trim() === "") {
        lines.splice(insertAt - 1, 1);
        insertAt--;
      }
      // Insert entry before the next heading with a blank line buffer
      lines.splice(insertAt, 0, newLine, "");
    }
  }

  await writeFile(path, lines.join("\n"), "utf-8");
}

/**
 * Update the status of an ADR in ARCHITECTURE.md.
 *
 * Matches by file path in the @reference.
 *
 * @param cwd      - Project working directory.
 * @param filePath - Relative file path to match (e.g. "docs/ADR/001-slug.md").
 * @param status   - New status.
 * @returns `true` if updated, `false` if entry not found.
 */
export async function updateAdrStatusInArchitecture(
  cwd: string,
  filePath: string,
  status: AdrStatus,
): Promise<boolean> {
  const path = await archPath(cwd);
  if (!existsSync(path)) return false;

  const content = await readFile(path, "utf-8");
  const marker = STATUS_MARKER[status];
  const escapedPath = filePath.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

  // Match lines like: - [D] @docs/ADR/001-slug.md summary
  // Double-backslash \s to produce literal \s in the regex from a template literal
  const regex = new RegExp(
    `^(\\s*-)\\s+\\[[DS PRI]\\]\\s+(@${escapedPath})`,
    "m",
  );
  if (!regex.test(content)) return false;

  const updated = content.replace(regex, `$1 [${marker}] $2`);
  await writeFile(path, updated, "utf-8");
  return true;
}
