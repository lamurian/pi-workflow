import { readdir } from "node:fs/promises";
import { resolve, relative } from "node:path";
import { existsSync } from "node:fs";
import { loadDirectoriesConfig } from "./paths.ts";

/**
 * Find all existing ADR directories in the project.
 *
 * Checks all configured ADR directories (primary + fallbacks) and
 * returns those that exist and contain at least one `.md` file.
 *
 * @param cwd - Project working directory.
 * @returns Absolute paths to existing ADR directories.
 */
export async function findExistingAdrDirs(cwd: string): Promise<string[]> {
  const config = await loadDirectoriesConfig(cwd);
  const allDirs = [config.adr.path, ...config.adr.fallbacks];
  const existing: string[] = [];
  for (const dir of allDirs) {
    const absDir = resolve(cwd, dir);
    if (existsSync(absDir)) {
      try {
        const files = await readdir(absDir);
        if (files.some((f) => f.endsWith(".md"))) {
          existing.push(absDir);
        }
      } catch {
        // Ignore permission errors
      }
    }
  }
  return existing;
}

/**
 * Detect the primary ADR directory for the project.
 *
 * Returns the first existing ADR directory in priority order.
 * If none exist, returns the configured primary ADR directory so
 * callers can create it as needed.
 *
 * @param cwd - Project working directory.
 * @returns Absolute path to the detected (or default) ADR directory.
 */
export async function detectAdrDir(cwd: string): Promise<string> {
  const config = await loadDirectoriesConfig(cwd);
  const existing = await findExistingAdrDirs(cwd);
  if (existing.length > 0) {
    return existing[0];
  }
  return resolve(cwd, config.adr.path);
}

/**
 * Detect an ARCHITECTURE.md file in the project.
 *
 * Checks the configured primary path, then fallbacks.
 *
 * @param cwd - Project working directory.
 * @returns The absolute path to ARCHITECTURE.md, or `null` if not found.
 */
export async function detectArchitectureMd(cwd: string): Promise<string | null> {
  const config = await loadDirectoriesConfig(cwd);
  const candidates = [
    config.architecture.path,
    ...config.architecture.fallbacks,
  ];
  for (const candidate of candidates) {
    const absPath = resolve(cwd, candidate);
    if (existsSync(absPath)) {
      return absPath;
    }
  }
  return null;
}

/**
 * List files in a directory (excluding .archive).
 */
async function listFiles(dir: string): Promise<string[]> {
  if (!existsSync(dir)) return [];
  try {
    const files = await readdir(dir);
    return files
      .filter((f) => f.endsWith(".md") && f !== ".archive")
      .sort();
  } catch {
    return [];
  }
}

/**
 * Get a human-readable summary of ADR/spec/plan context for injection.
 *
 * Lists files in all detected ADR directories, specs, plans, and the
 * ARCHITECTURE.md location. Callers can inject this into the agent's
 * system prompt to keep workflow state visible.
 *
 * @param cwd - Project working directory.
 * @returns A formatted context string, or empty string if nothing found.
 */
export async function getAdrContext(cwd: string): Promise<string> {
  const config = await loadDirectoriesConfig(cwd);
  const lines: string[] = [];

  // ADR directories
  const adrDirs = await findExistingAdrDirs(cwd);
  for (const dir of adrDirs) {
    const rel = relative(cwd, dir);
    const mdFiles = await listFiles(dir);
    if (mdFiles.length > 0) {
      lines.push(`ADR directory: ${rel}/`);
      for (const f of mdFiles) {
        lines.push(`  - ${f}`);
      }
    }
  }

  // Specs
  const specsAbs = resolve(cwd, config.specs.path);
  const specFiles = await listFiles(specsAbs);
  if (specFiles.length > 0) {
    lines.push(`Specs: ${config.specs.path}/`);
    for (const f of specFiles) {
      lines.push(`  - ${f}`);
    }
  }

  // Plans
  const plansAbs = resolve(cwd, config.plans.path);
  const planFiles = await listFiles(plansAbs);
  if (planFiles.length > 0) {
    lines.push(`Plans: ${config.plans.path}/`);
    for (const f of planFiles) {
      lines.push(`  - ${f}`);
    }
  }

  const archMd = await detectArchitectureMd(cwd);
  if (archMd) {
    const rel = relative(cwd, archMd);
    lines.push(`Architecture document: ${rel}`);
  }

  return lines.join("\n");
}
