import { mkdir, readdir, readFile, writeFile, rm } from "node:fs/promises";
import { join, basename } from "node:path";
import { existsSync } from "node:fs";
import { loadContent, renderTemplate, formatDate, shortSlug } from "./utils.ts";
import { loadDirectoriesConfig, ARCHIVE_SUBDIR } from "./paths.ts";
import { normalizeReferences } from "./cross-ref.ts";

/**
 * Get the absolute path to the specs directory.
 *
 * @param cwd - Project working directory.
 */
async function specsDirPath(cwd: string): Promise<string> {
  const config = await loadDirectoriesConfig(cwd);
  return join(cwd, config.specs.path);
}

/**
 * Get the absolute path to the archive directory inside specs.
 *
 * @param cwd - Project working directory.
 */
async function archiveDirPath(cwd: string): Promise<string> {
  const config = await loadDirectoriesConfig(cwd);
  return join(cwd, config.specs.path, ARCHIVE_SUBDIR);
}

/**
 * Ensure the specs directory and archive exist.
 *
 * @param cwd - Project working directory.
 */
export async function ensureSpecsDir(cwd: string): Promise<void> {
  await mkdir(await specsDirPath(cwd), { recursive: true });
  await mkdir(await archiveDirPath(cwd), { recursive: true });
}

/**
 * Compute the next spec number by scanning existing files.
 *
 * Scans existing spec files and returns the next sequential number
 * (3-digit padded).
 *
 * @param _adrNumber - Kept for backward compatibility (ignored).
 * @param cwd        - Project working directory.
 * @returns The next spec number (e.g. 1, 2, 3...).
 */
export async function nextSpecNumber(
  _adrNumber: number,
  cwd: string,
): Promise<number> {
  const dir = await specsDirPath(cwd);
  if (!existsSync(dir)) return 1;

  const files = await readdir(dir);
  let max = 0;

  for (const f of files) {
    const match = f.match(/^(\d{3})-/);
    if (match) {
      const num = parseInt(match[1], 10);
      if (num > max) max = num;
    }
  }

  return max + 1;
}

/**
 * Create a spec file for an ADR.
 *
 * Renders the unified spec template with frontmatter and content body.
 * Uses uniform naming: xxx-short-slug.md where xxx is a 3-digit
 * sequential number and slug is ≤20 characters.
 *
 * @param adrNumber  - ADR number.
 * @param title      - Spec title (<5 words).
 * @param content    - Spec markdown body (Requirements, Design, References).
 * @param cwd        - Project working directory.
 * @param description - One-sentence summary (defaults to title).
 * @returns Absolute path to the created spec file.
 */
export async function createSpec(
  adrNumber: number,
  title: string,
  content: string,
  cwd: string,
  description?: string,
): Promise<string> {
  await ensureSpecsDir(cwd);

  const specNum = await nextSpecNumber(adrNumber, cwd);
  const slug = shortSlug(title, 60);
  const filename = `${String(specNum).padStart(3, "0")}-${slug}.md`;
  const filePath = join(await specsDirPath(cwd), filename);

  // Auto-append @ cross-reference to the ADR if not present
  const hasRef = /@docs\/ADR\//i.test(content);
  const body = hasRef
    ? content
    : `${content}\n\nThis spec implements @docs/ADR/${String(adrNumber).padStart(3, "0")}-*.md`;

  const template = await loadContent("spec-template.md");
  const fullContent = renderTemplate(template, {
    title,
    description: description ?? title,
    status: "proposed",
    remaining: "0",
    date: formatDate(),
    content: body,
  });

  await writeFile(filePath, fullContent, "utf-8");

  // Normalize cross-references in the written file
  const writtenContent = await readFile(filePath, "utf-8");
  const normalized = await normalizeReferences(writtenContent, cwd);
  await writeFile(filePath, normalized, "utf-8");

  return filePath;
}

/**
 * List all active (non-archived) spec files.
 *
 * @param _adrNumber - Kept for backward compatibility (ignored).
 * @param cwd        - Project working directory.
 * @returns Array of absolute file paths, sorted.
 */
export async function listSpecs(
  _adrNumber: number,
  cwd: string,
): Promise<string[]> {
  const dir = await specsDirPath(cwd);
  if (!existsSync(dir)) return [];

  const files = await readdir(dir);
  return files
    .filter((f) => /^\d{3}-.+\.md$/.test(f))
    .sort((a, b) => a.localeCompare(b))
    .map((f) => join(dir, f));
}

/**
 * Move a spec file to the archive directory.
 *
 * @param specPath - Absolute path to the spec file.
 * @param cwd      - Project working directory.
 * @returns The new path in the archive.
 */
export async function archiveSpec(
  specPath: string,
  cwd: string,
): Promise<string> {
  await ensureSpecsDir(cwd);
  const archivePath = join(await archiveDirPath(cwd), basename(specPath));

  const content = await readFile(specPath, "utf-8");
  await writeFile(archivePath, content, "utf-8");
  await rm(specPath);

  return archivePath;
}

/**
 * Update a field in the spec file's YAML frontmatter.
 *
 * Replaces a key: value line in the frontmatter.
 *
 * @param filePath - Absolute path to the spec file.
 * @param key      - Frontmatter field name.
 * @param value    - New value (converted to string).
 */
export async function updateSpecField(
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
 * Compute and update the `remaining` field for a spec.
 *
 * Scans all active (non-archived) plan files in the project and counts
 * how many reference this spec via `@docs/specs/XXX-*`. Updates the spec's
 * frontmatter `remaining` field and sets `status` to `proposed` if not set.
 *
 * @param specNumber - Spec number in 3-digit format (e.g. "001").
 * @param cwd        - Project working directory.
 * @returns The new remaining count and status.
 */
export async function computeAndUpdateSpecRemaining(
  specNumber: string,
  cwd: string,
): Promise<{ remaining: number; status: string }> {
  const config = await loadDirectoriesConfig(cwd);
  const plansDir = join(cwd, config.plans.path);
  const paddedNum = String(parseInt(specNumber, 10)).padStart(3, "0");
  const refPattern = `@docs/specs/${paddedNum}`;

  let count = 0;
  if (existsSync(plansDir)) {
    const files = await readdir(plansDir);
    for (const file of files) {
      // Skip archived files
      if (file === ".archive") continue;
      if (!file.endsWith(".md")) continue;

      const filePath = join(plansDir, file);
      const content = await readFile(filePath, "utf-8");
      if (content.includes(refPattern)) {
        count++;
      }
    }
  }

  // Update spec file
  const specsDir = await specsDirPath(cwd);
  if (existsSync(specsDir)) {
    const files = await readdir(specsDir);
    for (const file of files) {
      if (!file.endsWith(".md")) continue;
      if (!file.startsWith(paddedNum)) continue;

      const specPath = join(specsDir, file);
      await updateSpecField(specPath, "remaining", count);

      // Set status to proposed if not already progressed/implemented
      const content = await readFile(specPath, "utf-8");
      const currentStatus = content.match(/^status:\s*(\S+)/m)?.[1] ?? "";
      if (!["progressed", "implemented"].includes(currentStatus)) {
        const updated = content.replace(/^status:\s*.+/m, "status: proposed");
        await writeFile(specPath, updated, "utf-8");
      }
      break;
    }
  }

  return { remaining: count, status: "proposed" };
}

/**
 * Extract the ADR number referenced by a spec file.
 *
 * Parses the spec file and looks for `@docs/ADR/XXX-*` to extract
 * the ADR number.
 *
 * @param specPath - Absolute path to the spec file.
 * @returns The ADR number, or null if not found.
 */
export async function extractAdrRefFromSpec(
  specPath: string,
): Promise<number | null> {
  const content = await readFile(specPath, "utf-8");
  const match = content.match(/@docs\/ADR\/(\d{3})/);
  return match ? parseInt(match[1], 10) : null;
}
