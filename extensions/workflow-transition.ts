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
 * Regex patterns used by the atomicity check.
 */
const DECISION_LINE_RE = /^ {2}Decision:\s*/;
const DOD_LINE_RE = /^ {2}DoD:\s*/;
const PARENT_RE = /^(ADR|Spec|Plan) (\d{3}) — (.+)$/;
const CONJUNCTION_RE = /\b(and|&|\+|,)\b/i;

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

// ── Outline parsing ────────────────────────────────────────────

interface OutlineItem {
  kind: "adr" | "spec";
  number: string;
  title: string;
  children: OutlineChild[];
}

interface OutlineChild {
  type: "decision" | "dod";
  text: string;
}

/**
 * Parse a structured outline text into items.
 *
 * Expected format:
 * ```
 * ADR NNN — Title
 *   Decision: ...
 * Spec NNN — Title
 *   DoD: ...
 * ```
 *
 * @param outline - Indented outline text.
 * @returns Parsed outline items.
 */
function parseOutline(outline: string): OutlineItem[] {
  const items: OutlineItem[] = [];
  const lines = outline.split("\n");
  let currentItem: OutlineItem | null = null;

  for (const rawLine of lines) {
    const trimmed = rawLine.trimEnd();
    if (!trimmed) continue;

    // Check for parent line (ADR/Spec/Plan NNN — Title)
    const parentMatch = trimmed.match(PARENT_RE);
    if (parentMatch) {
      currentItem = {
        kind: parentMatch[1].toLowerCase() === "adr" ? "adr" : "spec",
        number: parentMatch[2],
        title: parentMatch[3],
        children: [],
      };
      items.push(currentItem);
      continue;
    }

    if (!currentItem) continue;

    // Check for child line (indented Decision: or DoD:)
    const isDecision = trimmed.match(DECISION_LINE_RE);
    const isDod = trimmed.match(DOD_LINE_RE);

    if (isDecision) {
      currentItem.children.push({
        type: "decision",
        text: trimmed.replace(DECISION_LINE_RE, "").trim(),
      });
    } else if (isDod) {
      currentItem.children.push({
        type: "dod",
        text: trimmed.replace(DOD_LINE_RE, "").trim(),
      });
    }
  }

  return items;
}

/**
 * Check if a title contains conjunctions suggesting multiple concerns.
 */
function hasTitleConjunction(title: string): boolean {
  return CONJUNCTION_RE.test(title);
}

interface AtomicityReport {
  items: Array<{
    kind: string;
    number: string;
    title: string;
    childCount: number;
    childType: string;
    isAtomic: boolean;
    conjunctionWarning: boolean;
  }>;
  violations: number;
  warnings: number;
}

/**
 * Run atomicity check on an outline.
 *
 * Determines the expected child type based on phase:
 * - specifying → expect "Decision" children per ADR
 * - planning   → expect "DoD" children per spec
 *
 * @param outline - Structured outline text.
 * @param phase   - Target phase to determine child type.
 * @returns Atomicity report.
 */
function checkAtomicity(outline: string, phase: string): AtomicityReport {
  const items = parseOutline(outline);
  const childType = phase === "specifying" ? "decision" : "dod";
  const childLabel = childType === "decision" ? "Decision" : "DoD";

  const results: AtomicityReport["items"] = [];
  let violations = 0;
  let warnings = 0;

  for (const item of items) {
    const relevantChildren = item.children.filter((c) => c.type === childType);
    const count = relevantChildren.length;
    const isAtomic = count === 1;
    const conjWarning = hasTitleConjunction(item.title);

    if (!isAtomic) violations++;
    if (conjWarning) warnings++;

    results.push({
      kind: item.kind === "adr" ? "ADR" : "Spec",
      number: item.number,
      title: item.title,
      childCount: count,
      childType: childLabel,
      isAtomic,
      conjunctionWarning: conjWarning,
    });
  }

  return { items: results, violations, warnings };
}

/**
 * Build a human-readable atomicity report string.
 *
 * @param report - Atomicity check results.
 * @param phase  - Target phase for context.
 * @returns Formatted markdown report.
 */
function formatAtomicityReport(report: AtomicityReport, phase: string): string {
  const lines: string[] = [];
  lines.push("╔══════════════════════════════════════════════════════════════╗");
  lines.push("║  Atomicity Check Required                                   ║");
  lines.push("╚══════════════════════════════════════════════════════════════╝");
  lines.push("");
  lines.push(`Review the ${phase} outline and verify each item is atomic.`);
  lines.push("");

  for (const item of report.items) {
    const icon = item.isAtomic ? "✓" : "✗";
    const conjIcon = item.conjunctionWarning ? " ⚠️" : "";
    lines.push(
      `${icon}${conjIcon} ${item.kind} ${item.number} — ${item.title}`,
    );

    if (item.isAtomic) {
      lines.push(`   1 ${item.childType} — atomic`);
    } else if (item.childCount === 0) {
      lines.push(`   No ${item.childType} declared — add exactly one`);
    } else {
      lines.push(`   ${item.childCount} ${item.childType}s declared — split into separate items, one per ${item.childType}`);
    }

    if (item.conjunctionWarning) {
      lines.push(`   ⚠️ Title may cover multiple concerns (contains "and"/"&"/"+"/",")`);
    }
    lines.push("");
  }

  lines.push("## Summary");
  lines.push(`  ${report.items.length} item(s) checked`);
  lines.push(`  ${report.violations} violation(s) — items with != 1 ${report.items[0]?.childType ?? "child"}`);
  lines.push(`  ${report.warnings} warning(s) — title conjunctions`);
  lines.push("");

  if (report.violations > 0) {
    lines.push("Fix the violations above, then call this tool again with the corrected outline.");
  } else {
    lines.push(`All items are atomic. Call workflow_transition with force: true to confirm and proceed.`);
  }

  return lines.join("\n");
}

/**
 * Register the `workflow_transition` AI tool.
 *
 * The tool now supports an atomicity check gate:
 * - `outline` param: runs atomicity check, returns report, does NOT transition
 * - `force: true` param: shows confirmation popup, transitions on confirm
 * - Neither: error — agent must provide one or the other
 * - Both: error — contradictory
 *
 * @param pi - ExtensionAPI reference.
 */
export function registerWorkflowTransitionTool(pi: ExtensionAPI): void {
  pi.registerTool({
    name: "workflow_transition",
    label: "Transition Phase",
    description:
      "Progress the workflow to the next phase. " +
      "Provide an `outline` to run the atomicity check (no transition). " +
      "Use `force: true` to skip the check and show the confirmation popup. " +
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
      outline: Type.Optional(Type.String({
        description:
          "Structured outline of items for the next phase. " +
          "Each ADR must have exactly one `Decision:` line. " +
          "Each spec must have exactly one `DoD:` line. " +
          "Provide this to run the atomicity check. " +
          "The check runs but does NOT transition.",
      })),
      force: Type.Optional(Type.Boolean({
        description:
          "Skip atomicity check and show confirmation popup. " +
          "Use this after the outline has been verified by a prior call.",
      })),
    }),

    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const { phase, outline, force } = params;

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

      // Validate outline/force mutual exclusivity
      if (outline && force) {
        return {
          content: [
            {
              type: "text",
              text:
                "Error: Cannot provide both `outline` and `force: true`. " +
                "Provide `outline` to run the atomicity check, or `force: true` " +
                "to skip the check and show the confirmation popup.",
            },
          ],
          isError: true,
        };
      }

      if (!outline && !force) {
        return {
          content: [
            {
              type: "text",
              text:
                "Error: Provide either `outline` (to run atomicity check) " +
                "or `force: true` (to skip check and show confirmation). " +
                "Call with `outline` first to verify atomicity, then with `force: true` to proceed.",
            },
          ],
          isError: true,
        };
      }

      // ── Atomicity check path (outline provided) ──
      if (outline) {
        // Determine the expected child type based on target phase
        const expectedChildType = phase === "specifying" ? "decision" : "dod";

        const report = checkAtomicity(outline, phase);

        // Reject outlines that cannot be parsed into valid items
        if (report.items.length === 0) {
          return {
            content: [
              {
                type: "text",
                text:
                  "## Atomicity Check Failed\n\n" +
                  "0 items could be parsed from the outline — found no ADR, Spec, or Plan entries. " +
                  "Provide a structured outline with each item on its own line:\n\n" +
                  "```\n" +
                  "ADR NNN — Title\n" +
                  "  Decision: ...\n" +
                  "```\n\n" +
                  "Or for spec→plan check:\n\n" +
                  "```\n" +
                  "Spec NNN — Title\n" +
                  "  DoD: ...\n" +
                  "```",
              },
            ],
            isError: true,
          };
        }

        const formatted = formatAtomicityReport(report, phase);

        if (report.violations > 0) {
          return {
            content: [{ type: "text", text: formatted }],
            isError: true,
          };
        }

        return {
          content: [{ type: "text", text: formatted }],
        };
      }

      // ── Force confirmation path ──
      // Prompt user for confirmation via UI dialog (non-bypassable)
      const ok = await ctx.ui.confirm(
        "Phase Transition",
        `Transition to "${phase}" phase?`,
      );
      if (!ok) {
        return {
          content: [
            {
              type: "text",
              text: `Transition to "${phase}" was cancelled. No changes were made. ` +
                `Use /status to check the current phase, or call workflow_transition ` +
                `with force: true when ready.`,
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
