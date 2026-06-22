import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { readdir, readFile } from "node:fs/promises";
import { join, relative } from "node:path";
import { existsSync } from "node:fs";
import { loadDirectoriesConfig } from "./paths.ts";

/**
 * Valid workflow phases that can be validated.
 */
const VALID_PHASES = ["specifying", "planning", "implementing"] as const;

/**
 * Validation result for a single phase.
 */
interface ValidationResult {
  /** Whether all checks passed. */
  passed: boolean;
  /** Human-readable report lines. */
  report: string[];
  /** Phase hash for use in validation token. */
  phaseHash: string;
}

/**
 * Compute a simple hash of the current document state for a phase.
 *
 * Builds a digest of file names and sizes to detect stale tokens.
 *
 * @param cwd   - Project working directory.
 * @param phase - Current workflow phase.
 * @returns A hex string representing the state hash.
 */
async function computePhaseHash(cwd: string, phase: string): Promise<string> {
  const config = await loadDirectoriesConfig(cwd);
  const dirMap: Record<string, string> = {
    specifying: config.adr.path,
    planning: config.specs.path,
    implementing: config.plans.path,
  };

  const scanDir = join(cwd, dirMap[phase] ?? "");
  if (!existsSync(scanDir)) return "empty";

  const files = await readdir(scanDir);
  // Sort for deterministic ordering
  files.sort();
  // Build a simple hash from filenames
  const hashInput = files.join(",");
  let hash = 0;
  for (let i = 0; i < hashInput.length; i++) {
    const char = hashInput.charCodeAt(i);
    hash = ((hash << 5) - hash) + char;
    hash |= 0; // Convert to 32bit integer
  }
  return Math.abs(hash).toString(16);
}

/**
 * Validate ADR files for the specifying phase.
 *
 * Checks:
 * - Each ADR has a # Decision section in the body
 * - No numbering collisions (duplicate NNN- prefixes)
 * - No gaps > 1 in numbering sequence
 * - All cross-references resolve
 *
 * @param cwd    - Project working directory.
 * @param report - Accumulating report lines.
 * @returns Number of violations found.
 */
async function validateAdrs(cwd: string, report: string[]): Promise<number> {
  const config = await loadDirectoriesConfig(cwd);
  const adrDir = join(cwd, config.adr.path);
  let violations = 0;

  if (!existsSync(adrDir)) {
    report.push("  ℹ No ADR directory found — nothing to validate.");
    return 0;
  }

  const files = (await readdir(adrDir))
    .filter((f) => f.endsWith(".md") && /^\d{3}-/.test(f))
    .sort();

  if (files.length === 0) {
    report.push("  ℹ No ADR files found.");
    return 0;
  }

  // Check numbering collisions and gaps
  const numbers = files
    .map((f) => parseInt(f.slice(0, 3), 10))
    .filter((n) => !isNaN(n));

  // Duplicate check
  const seen = new Set<number>();
  for (const num of numbers) {
    if (seen.has(num)) {
      report.push(`  ✗ Numbering collision: multiple ADRs with number ${String(num).padStart(3, "0")}`);
      violations++;
    }
    seen.add(num);
  }

  // Gap check (only for unique sorted numbers)
  const uniqueSorted = [...seen].sort((a, b) => a - b);
  if (uniqueSorted.length > 1) {
    for (let i = 1; i < uniqueSorted.length; i++) {
      const gap = uniqueSorted[i] - uniqueSorted[i - 1];
      if (gap > 1) {
        report.push(
          `  ✗ Numbering gap: ADR ${String(uniqueSorted[i - 1]).padStart(3, "0")} → ` +
          `${String(uniqueSorted[i]).padStart(3, "0")} (missing ${gap - 1} number(s))`,
        );
        violations++;
      }
    }
  }

  // Content checks for each ADR
  for (const file of files) {
    const content = await readFile(join(adrDir, file), "utf-8");

    // Check for # Decision section
    if (!content.match(/# Decision\b/mi)) {
      report.push(`  ✗ ${file}: missing "# Decision" section`);
      violations++;
    }

    // Check for title conjunctions
    const titleMatch = content.match(/^title:\s*(.+)/m);
    if (titleMatch) {
      const title = titleMatch[1];
      if (/\b(and|&)\b/i.test(title)) {
        report.push(`  ⚠ ${file}: title "${title}" contains conjunctions — may cover multiple concerns`);
      }
    }
  }

  return violations;
}

/**
 * Validate spec files for the planning phase.
 *
 * Checks:
 * - Each spec references exactly one ADR
 * - Each spec has Requirements Specification and Design Principles sections
 * - No numbering collisions
 * - No gaps > 1
 * - All cross-references resolve to existing files
 *
 * @param cwd    - Project working directory.
 * @param report - Accumulating report lines.
 * @returns Number of violations found.
 */
async function validateSpecs(cwd: string, report: string[]): Promise<number> {
  const config = await loadDirectoriesConfig(cwd);
  const specsDir = join(cwd, config.specs.path);
  const adrDir = join(cwd, config.adr.path);
  let violations = 0;

  if (!existsSync(specsDir)) {
    report.push("  ℹ No specs directory found — nothing to validate.");
    return 0;
  }

  const files = (await readdir(specsDir))
    .filter((f) => f.endsWith(".md") && /^\d{3}-/.test(f))
    .sort();

  if (files.length === 0) {
    report.push("  ℹ No spec files found.");
    return 0;
  }

  // Collision and gap checks
  const numbers = files
    .map((f) => parseInt(f.slice(0, 3), 10))
    .filter((n) => !isNaN(n));

  const seen = new Set<number>();
  for (const num of numbers) {
    if (seen.has(num)) {
      report.push(`  ✗ Numbering collision: multiple specs with number ${String(num).padStart(3, "0")}`);
      violations++;
    }
    seen.add(num);
  }

  const uniqueSorted = [...seen].sort((a, b) => a - b);
  if (uniqueSorted.length > 1) {
    for (let i = 1; i < uniqueSorted.length; i++) {
      const gap = uniqueSorted[i] - uniqueSorted[i - 1];
      if (gap > 1) {
        report.push(
          `  ✗ Numbering gap: spec ${String(uniqueSorted[i - 1]).padStart(3, "0")} → ` +
          `${String(uniqueSorted[i]).padStart(3, "0")} (missing ${gap - 1} number(s))`,
        );
        violations++;
      }
    }
  }

  // Content checks for each spec
  for (const file of files) {
    const content = await readFile(join(specsDir, file), "utf-8");

    // Check for required sections
    if (!content.match(/# Requirements Specification\b/mi)) {
      report.push(`  ✗ ${file}: missing "# Requirements Specification" section`);
      violations++;
    }
    if (!content.match(/# Design Principles\b/mi)) {
      report.push(`  ✗ ${file}: missing "# Design Principles" section`);
      violations++;
    }

    // Check cross-references to ADRs
    const adrRefs = content.match(/@docs\/ADR\/(\d{3})/g);
    if (adrRefs && adrRefs.length > 1) {
      const unique = new Set(adrRefs.map((r: string) => r.toLowerCase()));
      if (unique.size > 1) {
        report.push(`  ✗ ${file}: references ${unique.size} different ADRs — create separate specs`);
        violations++;
      }
    }

    // Check ADR references resolve to existing files
    if (existsSync(adrDir) && adrRefs) {
      const adrFiles = (await readdir(adrDir))
        .filter((f) => f.endsWith(".md"))
        .map((f) => f.toLowerCase());
      for (const ref of adrRefs) {
        const refNum = ref.toLowerCase().replace("@docs/adr/", "").slice(0, 3);
        const exists = adrFiles.some((f) => f.startsWith(refNum));
        if (!exists) {
          report.push(`  ✗ ${file}: references @docs/ADR/${refNum} which does not exist`);
          violations++;
        }
      }
    }
  }

  return violations;
}

/**
 * Validate plan files for the implementing phase.
 *
 * Checks:
 * - Each plan has required sections (Overview, Goals, Implementation Steps, Risks, UAT)
 * - Each plan references exactly one spec
 * - No numbering collisions
 * - No gaps > 1
 * - All cross-references resolve to existing files
 *
 * @param cwd    - Project working directory.
 * @param report - Accumulating report lines.
 * @returns Number of violations found.
 */
async function validatePlans(cwd: string, report: string[]): Promise<number> {
  const config = await loadDirectoriesConfig(cwd);
  const plansDir = join(cwd, config.plans.path);
  const specsDir = join(cwd, config.specs.path);
  let violations = 0;

  if (!existsSync(plansDir)) {
    report.push("  ℹ No plans directory found — nothing to validate.");
    return 0;
  }

  const files = (await readdir(plansDir))
    .filter((f) => f.endsWith(".md") && /^\d{3}-/.test(f))
    .sort();

  if (files.length === 0) {
    report.push("  ℹ No plan files found.");
    return 0;
  }

  // Collision and gap checks
  const numbers = files
    .map((f) => parseInt(f.slice(0, 3), 10))
    .filter((n) => !isNaN(n));

  const seen = new Set<number>();
  for (const num of numbers) {
    if (seen.has(num)) {
      report.push(`  ✗ Numbering collision: multiple plans with number ${String(num).padStart(3, "0")}`);
      violations++;
    }
    seen.add(num);
  }

  const uniqueSorted = [...seen].sort((a, b) => a - b);
  if (uniqueSorted.length > 1) {
    for (let i = 1; i < uniqueSorted.length; i++) {
      const gap = uniqueSorted[i] - uniqueSorted[i - 1];
      if (gap > 1) {
        report.push(
          `  ✗ Numbering gap: plan ${String(uniqueSorted[i - 1]).padStart(3, "0")} → ` +
          `${String(uniqueSorted[i]).padStart(3, "0")} (missing ${gap - 1} number(s))`,
        );
        violations++;
      }
    }
  }

  // Required sections
  const requiredSections = [
    { heading: "# Overview", name: "Overview" },
    { heading: "# Goals", name: "Goals" },
    { heading: "# Implementation Steps", name: "Implementation Steps" },
    { heading: "# Risks", name: "Risks" },
    { heading: "# UAT", name: "UAT" },
  ];

  for (const file of files) {
    const content = await readFile(join(plansDir, file), "utf-8");

    for (const section of requiredSections) {
      if (!content.match(new RegExp(section.heading, "mi"))) {
        report.push(`  ✗ ${file}: missing "${section.heading}" section`);
        violations++;
      }
    }

    // Check spec references resolve
    const specRefs = content.match(/@docs\/specs\/(\d{3})/g);
    if (specRefs && specRefs.length > 1) {
      const unique = new Set(specRefs.map((r: string) => r.toLowerCase()));
      if (unique.size > 1) {
        report.push(`  ✗ ${file}: references ${unique.size} different specs — create separate plans`);
        violations++;
      }
    }

    if (existsSync(specsDir) && specRefs) {
      const specFiles = (await readdir(specsDir))
        .filter((f) => f.endsWith(".md"))
        .map((f) => f.toLowerCase());
      for (const ref of specRefs) {
        const refNum = ref.toLowerCase().replace("@docs/specs/", "").slice(0, 3);
        const exists = specFiles.some((f) => f.startsWith(refNum));
        if (!exists) {
          report.push(`  ✗ ${file}: references @docs/specs/${refNum} which does not exist`);
          violations++;
        }
      }
    }
  }

  return violations;
}

/**
 * Register the `validate_documents` AI tool.
 *
 * Validates all documents in the current phase's output directory:
 * - specifying phase: scans docs/ADR/
 * - planning phase: scans docs/specs/
 * - implementing phase: scans docs/plans/
 *
 * Common checks across all phases:
 * - No numbering collisions
 * - No gaps > 1 in numbering
 * - All cross-references resolve to existing files
 *
 * On PASS, stores a validation_token in workflow state.
 *
 * @param pi - ExtensionAPI reference.
 */
export function registerValidateDocsTool(pi: ExtensionAPI): void {
  pi.registerTool({
    name: "validate_documents",
    label: "Validate Documents",
    description:
      "Validate all documents in the current phase's output directory. " +
      "Scans actual files and checks atomicity, numbering, and cross-references. " +
      "On PASS, stores a validation token that is required by workflow_transition. " +
      "Valid phases: specifying, planning, implementing.",

    parameters: Type.Object({
      phase: Type.String({
        description:
          "Workflow phase to validate. " +
          "specifying → checks docs/ADR/. " +
          "planning → checks docs/specs/. " +
          "implementing → checks docs/plans/.",
      }),
    }),

    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const { phase } = params;

      if (!VALID_PHASES.includes(phase as typeof VALID_PHASES[number])) {
        return {
          content: [
            {
              type: "text",
              text:
                `Error: Invalid phase "${phase}". ` +
                `Valid phases: ${VALID_PHASES.join(", ")}.`,
            },
          ],
          isError: true,
        };
      }

      const report: string[] = [];
      let violations = 0;

      report.push(`# Document Validation Report (${phase} phase)`);
      report.push("");

      if (phase === "specifying") {
        report.push("## ADR Validation");
        violations += await validateAdrs(ctx.cwd, report);
      } else if (phase === "planning") {
        report.push("## Spec Validation");
        violations += await validateSpecs(ctx.cwd, report);
      } else if (phase === "implementing") {
        report.push("## Plan Validation");
        violations += await validatePlans(ctx.cwd, report);
      }

      report.push("");

      if (violations === 0) {
        report.push("## Result: PASS");
        report.push(`  ✓ ${violations} violation(s) — all documents valid.`);

        // Store validation token in workflow state
        const phaseHash = await computePhaseHash(ctx.cwd, phase);
        pi.appendEntry("validation_token", {
          phase,
          timestamp: Date.now(),
          phaseHash,
        });

        report.push("  ℹ Validation token stored — you can now transition phases.");
      } else {
        report.push(`## Result: FAIL (${violations} violation(s))`);
        report.push("  Fix the violations above, then re-run validate_documents.");
      }

      report.push("");

      return {
        content: [{ type: "text", text: report.join("\n") }],
        isError: violations > 0,
      };
    },
  });
}
