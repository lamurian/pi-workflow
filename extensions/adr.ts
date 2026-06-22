import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { existsSync } from "node:fs";
import { loadContent, renderTemplate, formatDate, shortSlug } from "./utils.ts";
import { findExistingAdrDirs, detectAdrDir } from "./adr-detect.ts";
import { loadDirectoriesConfig } from "./paths.ts";
import { normalizeReferences } from "./cross-ref.ts";

/** Architecture Decision Record matching the unified template. */
export interface Adr {
  /** Short descriptive title (<5 words). */
  title: string;
  /** One sentence summarizing the decision. */
  description: string;
  /** Decision status. */
  status: "proposed" | "progressed" | "implemented" | "accepted" | "deprecated" | "superseded";
  /** Remaining cross-references (specs) to implement. */
  remaining: number;
  /** Date in YYYY-MM-DD format (defaults to today). */
  date?: string;
  /** Problem statement or user story. */
  context: string;
  /** Chosen approach and rationale. */
  decision: string;
  /** Trade-offs, costs, benefits. */
  impact: string;
}

// ── Overlap detection ──────────────────────────────────────

/**
 * Check whether an ADR with a similar title already exists.
 *
 * Compares the proposed title against all existing ADR frontmatter titles
 * using a case-insensitive substring match.
 *
 * @param title  - Proposed ADR title.
 * @param adrDir - Absolute path to the ADR directory.
 * @returns The filename of a similar ADR, or `null` if no overlap.
 */
async function findOverlappingAdr(
  title: string,
  adrDir: string,
): Promise<string | null> {
  if (!existsSync(adrDir)) return null;

  const lowerTitle = title.toLowerCase();
  const files = await readdir(adrDir);
  const mdFiles = files.filter((f) => f.endsWith(".md")).sort();

  for (const file of mdFiles) {
    try {
      const content = await readFile(join(adrDir, file), "utf-8");
      const frontmatterTitle = content.match(/^title:\s*(.+)/m)?.[1];
      if (frontmatterTitle) {
        const lowerExisting = frontmatterTitle.toLowerCase();
        if (
          lowerExisting.includes(lowerTitle) ||
          lowerTitle.includes(lowerExisting)
        ) {
          return file;
        }
      }
    } catch {
      // Ignore unreadable files
    }
  }
  return null;
}

// ── Numbering ──────────────────────────────────────────────

/**
 * Compute the next ADR number by scanning existing files across
 * all detected directories.
 *
 * @param cwd - Project working directory.
 * @returns The next sequential number.
 */
async function nextAdrNumber(cwd: string): Promise<number> {
  const adrDirs = await findExistingAdrDirs(cwd);
  let max = 0;

  for (const adrDir of adrDirs) {
    try {
      const files = await readdir(adrDir);
      for (const f of files) {
        const match = f.match(/^(\d{3})-/);
        if (match) {
          const num = parseInt(match[1], 10);
          if (num > max) max = num;
        }
      }
    } catch {
      // Ignore
    }
  }

  return max + 1;
}

// ── CRUD operations ─────────────────────────────────────────

/**
 * Create a new ADR file in the project.
 *
 * Detects the active ADR directory (or creates `docs/ADR` as default),
 * reads existing ADRs to check for title overlap, and renders from
 * the unified ADR template.
 *
 * @param adr - The ADR data.
 * @param cwd - Project working directory.
 * @returns The absolute path to the created file.
 */
export async function createAdr(adr: Adr, cwd: string): Promise<string> {
  const adrDir = await detectAdrDir(cwd);
  await mkdir(adrDir, { recursive: true });

  const overlap = await findOverlappingAdr(adr.title, adrDir);
  if (overlap) {
    throw new Error(
      `Overlapping ADR detected: "${overlap}" already covers a similar topic. ` +
        "Review and either update the existing record or choose a different title.",
    );
  }

  const number = await nextAdrNumber(cwd);
  const slug = shortSlug(adr.title, 60);
  const filename = `${String(number).padStart(3, "0")}-${slug}.md`;
  const filePath = join(adrDir, filename);

  const template = await loadContent("adr-template.md");
  const content = renderTemplate(template, {
    title: adr.title,
    description: adr.description,
    status: adr.status,
    remaining: String(adr.remaining ?? 0),
    date: adr.date ?? formatDate(),
    context: adr.context || "TBD",
    decision: adr.decision || "TBD",
    impact: adr.impact || "TBD",
  });

  await writeFile(filePath, content, "utf-8");

  // Normalize cross-references in the written file
  const writtenContent = await readFile(filePath, "utf-8");
  const normalized = await normalizeReferences(writtenContent, cwd);
  await writeFile(filePath, normalized, "utf-8");

  return filePath;
}

/**
 * Read the most recent ADR from the detected ADR directory.
 *
 * @param cwd - Project working directory.
 * @returns Parsed ADR or null if none exists.
 */
export async function readLatestAdr(cwd: string): Promise<Adr | null> {
  const adrDirs = await findExistingAdrDirs(cwd);
  if (adrDirs.length === 0) return null;

  const allFiles: { path: string; name: string }[] = [];
  for (const dir of adrDirs) {
    try {
      const files = await readdir(dir);
      for (const f of files.filter((f) => f.endsWith(".md"))) {
        allFiles.push({ path: join(dir, f), name: f });
      }
    } catch {
      // Ignore
    }
  }

  if (allFiles.length === 0) return null;

  allFiles.sort((a, b) => a.name.localeCompare(b.name));
  const latest = allFiles[allFiles.length - 1];
  const content = await readFile(latest.path, "utf-8");
  return parseAdr(content, latest.name);
}

/**
 * List all ADR file paths across all detected directories.
 *
 * @param cwd - Project working directory.
 * @returns Sorted array of absolute ADR file paths.
 */
export async function listAdrs(cwd: string): Promise<string[]> {
  const adrDirs = await findExistingAdrDirs(cwd);
  if (adrDirs.length === 0) return [];

  const allFiles: string[] = [];
  for (const dir of adrDirs) {
    try {
      const files = await readdir(dir);
      for (const f of files.filter((f) => f.endsWith(".md")).sort()) {
        allFiles.push(join(dir, f));
      }
    } catch {
      // Ignore
    }
  }

  return allFiles.sort();
}

/**
 * Update an existing ADR file's status in frontmatter.
 *
 * Replaces the `status:` line in the ADR frontmatter.
 *
 * @param filePath - Absolute path to the ADR file.
 * @param status   - New status value.
 */
export async function updateAdrStatus(
  filePath: string,
  status: Adr["status"],
): Promise<void> {
  const content = await readFile(filePath, "utf-8");
  const updated = content.replace(/^status:\s*.+/m, `status: ${status}`);
  await writeFile(filePath, updated, "utf-8");
}

/**
 * Update a field in the ADR file's YAML frontmatter.
 *
 * Replaces or inserts a key: value line in the frontmatter.
 *
 * @param filePath - Absolute path to the ADR file.
 * @param key      - Frontmatter field name.
 * @param value    - New value (converted to string).
 */
export async function updateAdrField(
  filePath: string,
  key: string,
  value: string | number,
): Promise<void> {
  const content = await readFile(filePath, "utf-8");
  const regex = new RegExp(`^${key}:\\s*.+`, "m");
  const updated = content.replace(regex, `${key}: ${value}`);
  await writeFile(filePath, updated, "utf-8");
}

/**
 * Compute and update the `remaining` field for an ADR.
 *
 * Scans all active (non-archived) spec files in the project and counts
 * how many reference this ADR via `@docs/ADR/XXX-*`. Updates the ADR's
 * frontmatter `remaining` field and sets `status` to `proposed` if not set.
 *
 * @param adrNumber - ADR number (e.g. 1 for ADR 001).
 * @param cwd       - Project working directory.
 * @returns The new remaining count and status.
 */
export async function computeAndUpdateAdrRemaining(
  adrNumber: number,
  cwd: string,
): Promise<{ remaining: number; status: string }> {
  const config = await loadDirectoriesConfig(cwd);
  const specsDir = join(cwd, config.specs.path);
  const paddedNum = String(adrNumber).padStart(3, "0");
  const refPattern = `@docs/ADR/${paddedNum}`;

  let count = 0;
  if (existsSync(specsDir)) {
    const files = await readdir(specsDir);
    for (const file of files) {
      // Skip archived files
      if (file === ".archive") continue;
      if (!file.endsWith(".md")) continue;

      const filePath = join(specsDir, file);
      const content = await readFile(filePath, "utf-8");
      if (content.includes(refPattern)) {
        count++;
      }
    }
  }

  // Update ADR file
  const adrFiles = await listAdrs(cwd);
  for (const adrPath of adrFiles) {
    const baseName = adrPath.split("/").pop() ?? "";
    if (baseName.startsWith(paddedNum)) {
      await updateAdrField(adrPath, "remaining", count);
      // Set status to proposed if not already progressed/implemented
      const content = await readFile(adrPath, "utf-8");
      const currentStatus = content.match(/^status:\s*(\S+)/m)?.[1] ?? "";
      if (!["progressed", "implemented"].includes(currentStatus)) {
        const updated = content.replace(/^status:\s*.+/m, "status: proposed");
        await writeFile(adrPath, updated, "utf-8");
      }
      break;
    }
  }

  return { remaining: count, status: "proposed" };
}

// ── Parsing ────────────────────────────────────────────────

/**
 * Minimal ADR parser — extracts key fields from frontmatter + markdown.
 *
 * @param content  - Raw markdown content.
 * @param filename - Filename for fallback title.
 * @returns Parsed Adr object.
 */
export function parseAdr(content: string, filename: string): Adr {
  const frontmatter = (key: string): string => {
    const regex = new RegExp(`^${key}:\\s*(.+)`, "m");
    const match = content.match(regex);
    return match ? match[1].trim() : "";
  };

  const section = (heading: string): string => {
    const regex = new RegExp(`^# ${heading}\\n+([^#]+)`, "m");
    const match = content.match(regex);
    return match ? match[1].trim() : "";
  };

  return {
    title: frontmatter("title") || filename.replace(/\.md$/, ""),
    description: frontmatter("description") || "",
    status: (frontmatter("status").toLowerCase() as Adr["status"]) || "proposed",
    remaining: parseInt(frontmatter("remaining"), 10) || 0,
    date: frontmatter("date"),
    context: section("Context"),
    decision: section("Decision"),
    impact: section("Impact"),
  };
}
