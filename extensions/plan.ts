import { mkdir, readdir, readFile, writeFile, rm } from "node:fs/promises";
import { join, basename } from "node:path";
import { existsSync } from "node:fs";
import { loadContent, renderTemplate, formatDate, shortSlug } from "./utils.ts";
import { loadDirectoriesConfig, ARCHIVE_SUBDIR } from "./paths.ts";
import { normalizeReferences } from "./cross-ref.ts";
import { updateSpecField } from "./spec.ts";
import { listAdrs, updateAdrField } from "./adr.ts";

/**
 * Get absolute path to the plans directory.
 *
 * @param cwd - Project working directory.
 */
async function plansDirPath(cwd: string): Promise<string> {
  const config = await loadDirectoriesConfig(cwd);
  return join(cwd, config.plans.path);
}

/**
 * Get absolute path to the archive directory inside plans.
 *
 * @param cwd - Project working directory.
 */
async function archiveDirPath(cwd: string): Promise<string> {
  const config = await loadDirectoriesConfig(cwd);
  return join(cwd, config.plans.path, ARCHIVE_SUBDIR);
}

/**
 * Ensure the plans directory and archive exist.
 *
 * @param cwd - Project working directory.
 */
export async function ensurePlansDir(cwd: string): Promise<void> {
  await mkdir(await plansDirPath(cwd), { recursive: true });
  await mkdir(await archiveDirPath(cwd), { recursive: true });
}

/**
 * Compute the next plan number by scanning existing files.
 *
 * Scans existing plan files and returns the next sequential number
 * (3-digit padded).
 *
 * @param _specNumber - Kept for backward compatibility (ignored).
 * @param cwd         - Project working directory.
 * @returns The next plan number (e.g. 1, 2, 3...).
 */
export async function nextPlanNumber(
  _specNumber: string,
  cwd: string,
): Promise<number> {
  const dir = await plansDirPath(cwd);
  if (!existsSync(dir)) return 1;

  let max = 0;

  // Scan main plans directory
  for (const f of await readdir(dir)) {
    const match = f.match(/^(\d{3})-/);
    if (match) {
      const num = parseInt(match[1], 10);
      if (num > max) max = num;
    }
  }

  // Also scan archive directory for used numbers
  const archiveDir = join(dir, ARCHIVE_SUBDIR);
  if (existsSync(archiveDir)) {
    for (const f of await readdir(archiveDir)) {
      const match = f.match(/^(\d{3})-/);
      if (match) {
        const num = parseInt(match[1], 10);
        if (num > max) max = num;
      }
    }
  }

  return max + 1;
}

/**
 * Create a plan file for a spec.
 *
 * Renders the unified plan template with frontmatter and content body.
 * Uses uniform naming: xxx-short-slug.md where xxx is a 3-digit
 * sequential number and slug is ≤20 characters.
 *
 * @param specNumber  - Spec number in 3-digit format (e.g. "001" for spec 001).
 * @param title       - Plan title (<5 words).
 * @param content     - Plan markdown body (Overview, Goals, Steps, Risks, UAT, References).
 * @param cwd         - Project working directory.
 * @param description - One-sentence summary (defaults to title).
 * @returns Absolute path to the created plan file.
 */
export async function createPlan(
  specNumber: string,
  title: string,
  content: string,
  cwd: string,
  description?: string,
): Promise<string> {
  await ensurePlansDir(cwd);

  const planNum = await nextPlanNumber(specNumber, cwd);
  const slug = shortSlug(title, 60);
  const filename = `${String(planNum).padStart(3, "0")}-${slug}.md`;
  const filePath = join(await plansDirPath(cwd), filename);

  // Normalize specNumber to 3-digit format for cross-reference safety
  const normalizedSpecNum = String(parseInt(specNumber, 10)).padStart(3, "0");

  // Auto-append @ cross-reference to the spec if not present
  const hasRef = /@docs\/specs\//i.test(content);
  const body = hasRef
    ? content
    : `${content}\n\nThis plan implements @docs/specs/${normalizedSpecNum}-*.md`;

  const template = await loadContent("plan-template.md");
  const fullContent = renderTemplate(template, {
    title,
    description: description ?? title,
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
 * List all active (non-archived) plan files.
 *
 * @param _specNumber - Kept for backward compatibility (ignored).
 * @param cwd         - Project working directory.
 * @returns Array of absolute file paths, sorted.
 */
export async function listPlans(
  _specNumber: string,
  cwd: string,
): Promise<string[]> {
  const dir = await plansDirPath(cwd);
  if (!existsSync(dir)) return [];

  const files = await readdir(dir);
  return files
    .filter((f) => /^\d{3}-.+\.md$/.test(f))
    .sort((a, b) => a.localeCompare(b))
    .map((f) => join(dir, f));
}

/**
 * Move a plan file to the archive directory.
 *
 * @param planPath - Absolute path to the plan file.
 * @param cwd      - Project working directory.
 * @returns The new path in the archive.
 */
export async function archivePlan(
  planPath: string,
  cwd: string,
): Promise<string> {
  await ensurePlansDir(cwd);
  const archivePath = join(await archiveDirPath(cwd), basename(planPath));

  const content = await readFile(planPath, "utf-8");
  await writeFile(archivePath, content, "utf-8");
  await rm(planPath);

  return archivePath;
}

/**
 * Mark a task as completed in a plan file.
 *
 * Replaces `- [ ] task` with `- [x] task` by task index.
 * Matches task items under any heading in the plan.
 *
 * @param planPath  - Absolute path to the plan file.
 * @param taskIndex - Zero-based index of the task.
 */
export async function completeTask(
  planPath: string,
  taskIndex: number,
): Promise<void> {
  const content = await readFile(planPath, "utf-8");
  const lines = content.split("\n");
  let found = 0;

  for (let i = 0; i < lines.length; i++) {
    const match = lines[i].match(/^(\s*-\s+\[) (\]\s+)/);
    if (match) {
      if (found === taskIndex) {
        lines[i] = `${match[1]}x${match[2]}`;
        break;
      }
      found++;
    }
  }

  await writeFile(planPath, lines.join("\n"), "utf-8");
}

/**
 * Extract the spec number referenced by a plan file.
 *
 * Parses the plan file and looks for `@docs/specs/XXX-*` to extract
 * the 3-digit spec number.
 *
 * @param planPath - Absolute path to the plan file.
 * @returns The 3-digit spec number (e.g. "001"), or null if not found.
 */
export async function extractSpecRefFromPlan(
  planPath: string,
): Promise<string | null> {
  const content = await readFile(planPath, "utf-8");
  const match = content.match(/@docs\/specs\/(\d{3})/);
  return match ? match[1] : null;
}

/**
 * Handle the implementation of a plan — decrements the spec's remaining count
 * and cascades to the ADR when the spec is fully implemented.
 *
 * 1. Extracts the spec reference from the plan file.
 * 2. Finds the spec file and decrements its `remaining` field.
 * 3. If spec's remaining reaches 0, sets spec status to `implemented`
 *    and cascades to the ADR by decrementing the ADR's remaining.
 * 4. If ADR's remaining reaches 0, sets ADR status to `implemented`.
 *
 * @param planPath - Absolute path to the archived (or about-to-be-archived) plan.
 * @param cwd      - Project working directory.
 */
export async function onPlanImplemented(
  planPath: string,
  cwd: string,
): Promise<void> {
  const specNum = await extractSpecRefFromPlan(planPath);
  if (!specNum) return;

  const config = await loadDirectoriesConfig(cwd);
  const specsDir = join(cwd, config.specs.path);

  if (!existsSync(specsDir)) return;

  const files = await readdir(specsDir);
  for (const file of files) {
    if (!file.endsWith(".md")) continue;
    if (!file.startsWith(specNum)) continue;

    const specPath = join(specsDir, file);
    const specContent = await readFile(specPath, "utf-8");

    // Read current remaining
    const remainingMatch = specContent.match(/^remaining:\s*(\d+)/m);
    if (!remainingMatch) return;
    const currentRemaining = parseInt(remainingMatch[1], 10);
    if (currentRemaining <= 0) return;

    const newRemaining = currentRemaining - 1;
    await updateSpecField(specPath, "remaining", newRemaining);

    if (newRemaining === 0) {
      // Spec is fully implemented — always read fresh content
      await updateSpecField(specPath, "status", "implemented");

      // Cascade to ADR
      const adrRef = specContent.match(/@docs\/ADR\/(\d{3})/);
      if (adrRef) {
        const adrNum = parseInt(adrRef[1], 10);
        const adrFiles = await listAdrs(cwd);
        const paddedAdr = String(adrNum).padStart(3, "0");

        for (const adrPath of adrFiles) {
          const baseName = adrPath.split("/").pop() ?? "";
          if (baseName.startsWith(paddedAdr)) {
            const adrContent = await readFile(adrPath, "utf-8");
            const adrRemainingMatch = adrContent.match(/^remaining:\s*(\d+)/m);
            if (!adrRemainingMatch) break;

            const adrRemaining = parseInt(adrRemainingMatch[1], 10);
            if (adrRemaining <= 0) break;

            const newAdrRemaining = adrRemaining - 1;
            await updateAdrField(adrPath, "remaining", newAdrRemaining);

            if (newAdrRemaining === 0) {
              await updateAdrField(adrPath, "status", "implemented");
            } else {
              await updateAdrField(adrPath, "status", "progressed");
            }
            break;
          }
        }
      }
    } else {
      // Spec still has remaining plans — set status to progressed
      await updateSpecField(specPath, "status", "progressed");
    }
    break;
  }
}
