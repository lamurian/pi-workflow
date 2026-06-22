import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { readdir, readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join, relative } from "node:path";
import { type WorkflowState, loadState, transitionTo, updateUi } from "./state.ts";
import { loadDirectoriesConfig } from "./paths.ts";
import { listAdrs, updateAdrField } from "./adr.ts";
import { updateSpecField } from "./spec.ts";

/**
 * Valid workflow phases that can be transitioned to via this tool.
 */
const VALID_PHASES = [
  "requirements",
  "specifying",
  "planning",
  "implementing",
] as const;

/**
 * Maximum age for a validation token (5 minutes).
 */
const TOKEN_MAX_AGE_MS = 5 * 60 * 1000;

// ── Auto-heal remaining counts ─────────────────────────────────

/**
 * Auto-compute remaining counts for all non-implemented specs and ADRs.
 *
 * Called when transitioning to the "implementing" phase. Scans active
 * (non-archived) plans for each spec and active specs for each ADR,
 * updating only those whose status is NOT "implemented".
 *
 * @param cwd - Project working directory.
 */
export async function autoUpdateRemaining(cwd: string): Promise<void> {
  const config = await loadDirectoriesConfig(cwd);
  const specsDir = join(cwd, config.specs.path);
  const plansDir = join(cwd, config.plans.path);

  // ── Update non-implemented specs ──
  if (existsSync(specsDir)) {
    const specFiles = await readdir(specsDir);
    for (const file of specFiles) {
      if (!file.endsWith(".md") || !/^\d{3}-/.test(file)) continue;

      const specPath = join(specsDir, file);
      const content = await readFile(specPath, "utf-8");

      const status = content.match(/^status:\s*(\S+)/m)?.[1] ?? "";
      if (status === "implemented") continue;

      const specNum = file.slice(0, 3);
      const refPattern = `@docs/specs/${specNum}`;
      let count = 0;

      if (existsSync(plansDir)) {
        const planFiles = await readdir(plansDir);
        for (const pf of planFiles) {
          if (pf === ".archive" || !pf.endsWith(".md")) continue;
          const planContent = await readFile(join(plansDir, pf), "utf-8");
          if (planContent.includes(refPattern)) count++;
        }
      }

      await updateSpecField(specPath, "remaining", count);
    }
  }

  // ── Update non-implemented ADRs ──
  const adrFiles = await listAdrs(cwd);
  for (const adrPath of adrFiles) {
    const content = await readFile(adrPath, "utf-8");

    const status = content.match(/^status:\s*(\S+)/m)?.[1] ?? "";
    if (status === "implemented") continue;

    const baseName = adrPath.split("/").pop() ?? "";
    const adrNum = baseName.slice(0, 3);
    const refPattern = `@docs/ADR/${adrNum}`;
    let count = 0;

    if (existsSync(specsDir)) {
      const specFiles = await readdir(specsDir);
      for (const sf of specFiles) {
        if (sf === ".archive" || !sf.endsWith(".md")) continue;
        const specContent = await readFile(join(specsDir, sf), "utf-8");
        if (specContent.includes(refPattern)) count++;
      }
    }

    await updateAdrField(adrPath, "remaining", count);
  }
}

// ── Phase pre-condition checks ──────────────────────────────────

/**
 * Check phase transition pre-conditions before allowing a force transition.
 *
 * - specifying: at least one ADR with `status: proposed` must exist
 * - planning:   every non-implemented ADR must have `remaining === 0`
 * - implementing: every non-implemented spec must have `remaining === 0`
 *
 * @param phase - Target phase for the transition.
 * @param cwd   - Project working directory.
 * @returns An error message string if pre-conditions fail, or null if OK.
 */
async function checkPhasePreconditions(
  phase: string,
  cwd: string,
): Promise<string | null> {
  const config = await loadDirectoriesConfig(cwd);
  const adrDir = join(cwd, config.adr.path);

  if (!existsSync(adrDir)) {
    if (phase === "specifying") {
      return `Pre-condition failed: no ADRs found at ${config.adr.path}. ` +
        "Create at least one ADR with `adr_create` before transitioning to the specifying phase.";
    }
    return null;
  }

  const adrFiles = (await readdir(adrDir)).filter((f) => f.endsWith(".md"));

  if (phase === "specifying") {
    // Need at least one ADR with status: proposed
    for (const f of adrFiles) {
      const content = await readFile(join(adrDir, f), "utf-8");
      const status = content.match(/^status:\s*(\S+)/m)?.[1] ?? "";
      if (status === "proposed") return null; // Found one
    }
    return "Pre-condition failed: no ADRs with `status: proposed` found. " +
      "Create at least one new ADR with `adr_create` before transitioning to the specifying phase.";
  }

  if (phase === "planning") {
    // Recompute remaining counts from actual files — this auto-heals stale counters.
    await autoUpdateRemaining(cwd);
    // Check every non-implemented ADR has at least one spec (specifying is complete).
    const specsDir = join(cwd, config.specs.path);
    for (const f of adrFiles) {
      const content = await readFile(join(adrDir, f), "utf-8");
      const status = content.match(/^status:\s*(\S+)/m)?.[1] ?? "";
      if (status === "implemented") continue;
      if (!existsSync(specsDir)) {
        return `Pre-condition failed: ADR ${f.replace(/\.md$/, "")} has no specs. ` +
          "Create at least one spec for this ADR before transitioning to the planning phase.";
      }
      const adrNum = f.slice(0, 3);
      const specFiles = (await readdir(specsDir)).filter(
        (sf) => sf.endsWith(".md") && !sf.startsWith("."),
      );
      let found = false;
      for (const sf of specFiles) {
        const sc = await readFile(join(specsDir, sf), "utf-8");
        if (sc.includes(`@docs/ADR/${adrNum}`)) {
          found = true;
          break;
        }
      }
      if (!found) {
        return `Pre-condition failed: ADR ${f.replace(/\.md$/, "")} has no specs. ` +
          "Create at least one spec for this ADR before transitioning to the planning phase.";
      }
    }
    return null;
  }

  if (phase === "implementing") {
    // Every non-implemented ADR's specs must have remaining === 0
    const specsDir = join(cwd, config.specs.path);
    if (!existsSync(specsDir)) {
      return "Pre-condition failed: no specs found. " +
        "Create specs for all ADRs before transitioning to the implementing phase.";
    }

    for (const f of adrFiles) {
      const content = await readFile(join(adrDir, f), "utf-8");
      const status = content.match(/^status:\s*(\S+)/m)?.[1] ?? "";
      if (status === "implemented") continue;

      const adrNum = f.slice(0, 3);
      const specFiles = (await readdir(specsDir)).filter(
        (sf) => sf.endsWith(".md") && !sf.startsWith("."),
      );

      for (const sf of specFiles) {
        const specContent = await readFile(join(specsDir, sf), "utf-8");
        if (!specContent.includes(`@docs/ADR/${adrNum}`)) continue;
        const specRemaining = parseInt(specContent.match(/^remaining:\s*(\d+)/m)?.[1] ?? "0", 10);
        if (specRemaining > 0) {
          return `Pre-condition failed: Spec ${sf.replace(/\.md$/, "")} has remaining=${specRemaining}. ` +
            "Create plans for all specs before transitioning to the implementing phase.";
        }
      }
    }
    return null;
  }

  return null;
}

// ── Validation token checks ────────────────────────────────────

interface ValidationToken {
  phase: string;
  timestamp: number;
  phaseHash: string;
}

/**
 * Find the most recent validation token for a given phase.
 *
 * Scans session entries in reverse for entries with customType=validation_token
 * and matching phase.
 *
 * @param ctx   - Extension context.
 * @param phase - Target phase to check.
 * @returns The token if valid and current, or null if missing/expired.
 */
function findValidationToken(
  ctx: { sessionManager: { getBranch: () => Array<{ type: string; customType?: string; data?: unknown }> } },
  phase: string,
): ValidationToken | null {
  const entries = ctx.sessionManager.getBranch();
  for (let i = entries.length - 1; i >= 0; i--) {
    const entry = entries[i];
    if (
      entry.type === "custom" &&
      entry.customType === "validation_token"
    ) {
      const data = entry.data as ValidationToken;
      if (data && data.phase === phase) {
        // Check age
        if (Date.now() - data.timestamp < TOKEN_MAX_AGE_MS) {
          return data;
        }
        return null; // Expired
      }
    }
  }
  return null; // Not found
}

// ── Common issue detection for cancellation diagnostics ────────

/**
 * Scan for common issues when transitioning to a phase.
 *
 * Runs validateMappings + numbering collision check + remaining count check.
 *
 * @param cwd   - Project working directory.
 * @param phase - Target phase.
 * @returns Array of human-readable issue messages.
 */
async function detectCommonIssues(cwd: string, phase: string): Promise<string[]> {
  const issues: string[] = [];
  const config = await loadDirectoriesConfig(cwd);

  // Check for numbering collisions in target directory
  const dirMap: Record<string, string> = {
    specifying: config.adr.path,
    planning: config.specs.path,
    implementing: config.plans.path,
  };
  const targetDir = join(cwd, dirMap[phase] ?? "");
  if (existsSync(targetDir)) {
    const files = (await readdir(targetDir))
      .filter((f) => f.endsWith(".md") && /^\d{3}-/.test(f));
    const seen = new Set<string>();
    for (const f of files) {
      const num = f.slice(0, 3);
      if (seen.has(num)) {
        issues.push(`Numbering collision in ${dirMap[phase]}: multiple files with number ${num}`);
      }
      seen.add(num);
    }
  }

  // Check remaining counts
  const specsDir = join(cwd, config.specs.path);
  if (existsSync(specsDir)) {
    const specFiles = (await readdir(specsDir))
      .filter((f) => f.endsWith(".md") && /^\d{3}-/.test(f));
    for (const f of specFiles) {
      const content = await readFile(join(specsDir, f), "utf-8");
      const rem = parseInt(content.match(/^remaining:\s*(\d+)/m)?.[1] ?? "0", 10);
      if (rem > 0) {
        issues.push(`Spec ${f.slice(0, 3)} has remaining=${rem} (expected 0)`);
      }
    }
  }

  return issues;
}

/**
 * Register the `workflow_transition` AI tool.
 *
 * The tool no longer supports an outline-based atomicity check.
 * Instead, agents must run `validate_documents` first (which stores
 * a validation token), then call `workflow_transition` with `force: true`.
 *
 * If no valid validation_token is found, the tool returns an error
 * telling the agent to run validate_documents first.
 *
 * @param pi - ExtensionAPI reference.
 */
export function registerWorkflowTransitionTool(pi: ExtensionAPI): void {
  pi.registerTool({
    name: "workflow_transition",
    label: "Transition Phase",
    description:
      "Progress the workflow to the next phase. " +
      "Before calling this tool, run validate_documents first " +
      "to validate all documents and get a validation token. " +
      "Then call with force: true to confirm the transition. " +
      "Valid transitions: requirements → specifying → planning → implementing.",

    parameters: Type.Object({
      phase: Type.String({
        description:
          "Target phase. Valid values: " + VALID_PHASES.join(", ") + ". " +
          "requirements → after all ADRs drafted. " +
          "specifying → after all specs created. " +
          "planning → after all plans created. " +
          "implementing → ready to start implementing.",
      }),
      force: Type.Optional(Type.Boolean({
        description:
          "Confirm the transition. Requires a valid validation_token " +
          "from a prior validate_documents call.",
      })),
    }),

    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const { phase, force } = params;

      // Validate phase first
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

      if (!force) {
        return {
          content: [
            {
              type: "text",
              text:
                "Error: Pass `force: true` to proceed. " +
                "Run `validate_documents` first to validate all documents " +
                "and obtain a validation token, then call " +
                `\`workflow_transition({ phase: "${phase}", force: true })\`.`,
            },
          ],
          isError: true,
        };
      }

      // ── Check for valid validation token ──
      const token = findValidationToken(ctx, phase);
      if (!token) {
        // Check if there's a token for a different phase
        const allEntries = ctx.sessionManager.getBranch();
        const anyToken = allEntries
          .filter((e) => e.type === "custom" && e.customType === "validation_token")
          .pop();

        const hint = anyToken
          ? ` Found a validation token for phase "${(anyToken.data as ValidationToken).phase}" ` +
            "— you may need to re-run validate_documents for the target phase."
          : " No validation token found. Run `validate_documents` first, then retry.";

        return {
          content: [
            {
              type: "text",
              text:
                `Error: No valid validation token found for phase "${phase}".` +
                hint +
                `\n\nRun: validate_documents({ phase: "${phase}" })`,
            },
          ],
          isError: true,
        };
      }

      // ── Prompt user for confirmation ──
      const ok = await ctx.ui.confirm(
        "Phase Transition",
        `Transition to "${phase}" phase?`,
      );
      if (!ok) {
        const issues = await detectCommonIssues(ctx.cwd, phase);
        const diagMsg = issues.length > 0
          ? `\n\nPotential issues detected:\n${issues.map((i) => `  \u26A0\uFE0F ${i}`).join("\n")}`
          : "";

        return {
          content: [
            {
              type: "text",
              text: `Transition to "${phase}" was cancelled.${diagMsg}\n\n` +
                `Fix the issues above, then retry.`,
            },
          ],
        };
      }

      ctx.ui.notify(`Checking pre-conditions for ${phase}...`, "info");

      // ── Phase pre-condition check ──
      {
        const preCondError = await checkPhasePreconditions(phase, ctx.cwd);
        if (preCondError) {
          return {
            content: [{ type: "text", text: preCondError }],
            isError: true,
          };
        }
      }

      // Auto-compute remaining counts for non-implemented specs/ADRs
      if (phase === "implementing") {
        ctx.ui.notify("Recomputing cross-reference counts...", "info");
        await autoUpdateRemaining(ctx.cwd);
        ctx.ui.notify("Cross-reference counts synced", "info");
      }

      // Read current state from session
      const currentState = loadState(ctx);

      if (!currentState) {
        const newState: WorkflowState = {
          phase: phase as WorkflowState["phase"],
          specText: "",
          adrFiles: [],
          specFiles: [],
          planFiles: [],
        };
        transitionTo(pi, newState, phase as WorkflowState["phase"]);
        updateUi(newState, ctx);
      } else {
        transitionTo(pi, currentState, phase as WorkflowState["phase"]);
        updateUi(currentState, ctx);
      }

      // Phase-appropriate guidance messages
      const guidance: Record<string, string> = {
        specifying:
          "Now draft the outlined specs using spec_create.",
        planning:
          "Now draft the outlined plans using plan_create in execution order.",
        implementing:
          "Now draft the outlined plans using plan_create in execution order, then run /implement to execute them.",
      };

      return {
        content: [
          {
            type: "text",
            text:
              `Phase transitioned to "${phase}". ` +
              `The system will load the ${phase} phase prompt on the next turn. ` +
              (guidance[phase] ?? ""),
          },
        ],
      };
    },
  });
}
