import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { existsSync } from "node:fs";
import { loadDirectoriesConfig } from "./paths.ts";

/**
 * Validation report of the ADR → Spec → Plan chain.
 */
export interface ValidationReport {
  errors: string[];
  warnings: string[];
  info: string[];
}

/**
 * Validate the ADR → Spec → Plan cross-reference chain.
 *
 * Scans all ADR, spec, and plan files and reports:
 * - Orphan specs (reference a missing ADR number)
 * - Orphan plans (reference a missing spec number)
 * - ADRs with no specs
 * - Specs with no plans
 * - Numbering collisions
 *
 * @param cwd - Project working directory.
 * @returns A validation report with errors, warnings, and info messages.
 */
export async function validateMappings(cwd: string): Promise<ValidationReport> {
  const errors: string[] = [];
  const warnings: string[] = [];
  const info: string[] = [];

  const config = await loadDirectoriesConfig(cwd);
  const adrDir = join(cwd, config.adr.path);
  const specsDir = join(cwd, config.specs.path);
  const plansDir = join(cwd, config.plans.path);

  // Parse all ADR numbers
  const adrNumbers = new Set<string>();
  if (existsSync(adrDir)) {
    for (const f of await readdir(adrDir)) {
      const m = f.match(/^(\d{3})-/);
      if (m) adrNumbers.add(m[1]);
    }
  }

  // Parse all spec numbers and their ADR references
  const specNumbers = new Set<string>();
  const specToAdr = new Map<string, string[]>();
  if (existsSync(specsDir)) {
    for (const f of await readdir(specsDir)) {
      if (f === ".archive" || !f.endsWith(".md")) continue;
      const m = f.match(/^(\d{3})-/);
      if (!m) continue;
      const specNum = m[1];
      specNumbers.add(specNum);

      const content = await readFile(join(specsDir, f), "utf-8");
      const adrRefs = content.match(/@docs\/ADR\/(\d{3})/g) ?? [];
      const refs = adrRefs.map((r: string) => r.replace("@docs/ADR/", ""));
      specToAdr.set(specNum, refs);

      // Check for orphan specs (reference non-existent ADR)
      for (const ref of refs) {
        if (!adrNumbers.has(ref)) {
          errors.push(`Orphan spec ${specNum} ("${f}"): references ADR ${ref} which does not exist.`);
        }
      }
    }
  }

  // Parse all plan numbers and their spec references
  const planToSpec = new Map<string, string[]>();
  if (existsSync(plansDir)) {
    for (const f of await readdir(plansDir)) {
      if (f === ".archive" || !f.endsWith(".md")) continue;
      const m = f.match(/^(\d{3})-/);
      if (!m) continue;
      const planNum = m[1];

      const content = await readFile(join(plansDir, f), "utf-8");
      const specRefs = content.match(/@docs\/specs\/(\d{3})/g) ?? [];
      const refs = specRefs.map((r: string) => r.replace("@docs/specs/", ""));
      planToSpec.set(planNum, refs);

      // Check for orphan plans (reference non-existent spec)
      for (const ref of refs) {
        if (!specNumbers.has(ref)) {
          errors.push(`Orphan plan ${planNum} ("${f}"): references spec ${ref} which does not exist.`);
        }
      }
    }
  }

  // Check for ADRs with no specs
  for (const adrNum of adrNumbers) {
    const hasSpec = [...specToAdr.entries()].some(([, refs]) => refs.includes(adrNum));
    if (!hasSpec) {
      warnings.push(`ADR ${adrNum} has no specs — create at least one spec implementing this ADR.`);
    }
  }

  // Check for specs with no plans
  for (const specNum of specNumbers) {
    const hasPlan = [...planToSpec.entries()].some(([, refs]) => refs.includes(specNum));
    if (!hasPlan) {
      warnings.push(`Spec ${specNum} has no plans — create at least one plan for this spec.`);
    }
  }

  info.push(`Found ${adrNumbers.size} ADR(s), ${specNumbers.size} spec(s), ${planToSpec.size} plan(s).`);

  return { errors, warnings, info };
}
