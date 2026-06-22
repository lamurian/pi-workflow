import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { validateMappings } from "./validate.ts";

/**
 * Register the `cross_ref_chain` AI tool.
 *
 * Builds a visualisation of the ADR → Spec → Plan cross-reference chain
 * using the existing `validateMappings()` function, but presenting
 * results as a chain diagram instead of warnings.
 *
 * @param pi - ExtensionAPI reference.
 */
export function registerChainTool(pi: ExtensionAPI): void {
  pi.registerTool({
    name: "cross_ref_chain",
    label: "Cross-Reference Chain",
    description:
      "Display the ADR → Spec → Plan cross-reference chain. " +
      "Scans all ADRs, specs, plans and shows the chain mapping, " +
      "gaps, and orphans in a visual format.",

    parameters: Type.Object({}),

    async execute(_toolCallId, _params, _signal, _onUpdate, ctx) {
      const report = await validateMappings(ctx.cwd);

      const lines: string[] = [];
      lines.push("# Cross-Reference Chain");
      lines.push("");

      // Summary counts
      const adrCount = report.info[0]?.match(/^Found (\d+) ADR/)?.[1] ?? "?";
      const specCount = report.info[0]?.match(/(\d+) spec/)?.[1] ?? "?";
      const planCount = report.info[0]?.match(/(\d+) plan/)?.[1] ?? "?";
      lines.push(`**${adrCount} ADR(s) → ${specCount} Spec(s) → ${planCount} Plan(s)**`);
      lines.push("");

      // Build chain mapping from warnings
      // Warnings come as: "ADR NNN has no specs" or "Spec NNN has no plans"
      const adrWithNoSpecs = new Set<string>();
      const specWithNoPlans = new Set<string>();
      const orphans: string[] = [];

      for (const warn of report.warnings) {
        const adrMatch = warn.match(/ADR (\d{3}) has no specs/);
        if (adrMatch) adrWithNoSpecs.add(adrMatch[1]);

        const specMatch = warn.match(/Spec (\d{3}) has no plans/);
        if (specMatch) specWithNoPlans.add(specMatch[1]);
      }

      for (const err of report.errors) {
        const orphanSpecMatch = err.match(/Orphan spec (\d{3})/);
        if (orphanSpecMatch) orphans.push(`Spec ${orphanSpecMatch[1]} (references non-existent ADR)`);

        const orphanPlanMatch = err.match(/Orphan plan (\d{3})/);
        if (orphanPlanMatch) orphans.push(`Plan ${orphanPlanMatch[1]} (references non-existent spec)`);
      }

      // Determine which ADRs and specs exist from the chain
      // We show only items that have chains or are missing links
      lines.push("## Chain");
      lines.push("");

      // Read all directory files to discover what exists
      const { readdir, readFile } = await import("node:fs/promises");
      const { join } = await import("node:path");
      const { loadDirectoriesConfig } = await import("./paths.ts");
      const config = await loadDirectoriesConfig(ctx.cwd);

      const adrDir = join(ctx.cwd, config.adr.path);
      const specsDir = join(ctx.cwd, config.specs.path);
      const plansDir = join(ctx.cwd, config.plans.path);

      // Build ADR → specs mapping
      const adrSpecs = new Map<string, string[]>();
      const specPlans = new Map<string, string[]>();

      // Parse specs directory
      try {
        const { existsSync } = await import("node:fs");
        if (existsSync(specsDir)) {
          const specFiles = (await readdir(specsDir))
            .filter((f) => f.endsWith(".md") && /^\d{3}-/.test(f))
            .sort();
          for (const sf of specFiles) {
            const specNum = sf.slice(0, 3);
            const content = await readFile(join(specsDir, sf), "utf-8");
            const adrRef = content.match(/@docs\/ADR\/(\d{3})/);
            if (adrRef) {
              const adrNum = adrRef[1];
              const existing = adrSpecs.get(adrNum) ?? [];
              existing.push(specNum);
              adrSpecs.set(adrNum, existing);
            }
          }
        }
      } catch {
        // Ignore directory errors
      }

      // Parse plans directory
      try {
        const { existsSync } = await import("node:fs");
        if (existsSync(plansDir)) {
          const planFiles = (await readdir(plansDir))
            .filter((f) => f.endsWith(".md") && !f.startsWith("."))
            .sort();
          for (const pf of planFiles) {
            const planNum = pf.slice(0, 3);
            const content = await readFile(join(plansDir, pf), "utf-8");
            const specRef = content.match(/@docs\/specs\/(\d{3})/);
            if (specRef) {
              const specNum = specRef[1];
              const existing = specPlans.get(specNum) ?? [];
              existing.push(planNum);
              specPlans.set(specNum, existing);
            }
          }
        }
      } catch {
        // Ignore
      }

      // Display chain
      try {
        const { existsSync } = await import("node:fs");
        if (existsSync(adrDir)) {
          const adrFiles = (await readdir(adrDir))
            .filter((f) => f.endsWith(".md"))
            .sort();
          for (const af of adrFiles) {
            const adrNum = af.slice(0, 3);
            const specs = adrSpecs.get(adrNum) ?? [];
            const specChains = specs.map((sn) => {
              const plans = specPlans.get(sn) ?? [];
              const planStr = plans.length > 0
                ? plans.map((pn) => `Plan ${pn}`).join(", ")
                : "⚠️ no plans";
              return `  Spec ${sn} → ${planStr}`;
            }).join("\n") || "  ⚠️ no specs";

            lines.push(`**ADR ${adrNum}** →`);
            lines.push(specChains);
            lines.push("");
          }
        }
      } catch {
        lines.push("  (error reading ADR directory)");
      }

      // Orphans
      if (orphans.length > 0) {
        lines.push("## Orphans");
        lines.push("");
        for (const o of orphans) {
          lines.push(`  ❌ ${o}`);
        }
        lines.push("");
      }

      // Gaps
      const gaps: string[] = [];
      if (adrWithNoSpecs.size > 0) {
        for (const an of adrWithNoSpecs) gaps.push(`ADR ${an} has no specs`);
      }
      if (specWithNoPlans.size > 0) {
        for (const sn of specWithNoPlans) gaps.push(`Spec ${sn} has no plans`);
      }

      if (gaps.length > 0) {
        lines.push("## Gaps");
        lines.push("");
        for (const g of gaps) {
          lines.push(`  ⚠️ ${g}`);
        }
        lines.push("");
      }

      if (orphans.length === 0 && gaps.length === 0) {
        lines.push("✅ All chains complete — no orphans or gaps.");
      }

      return {
        content: [{ type: "text", text: lines.join("\n") }],
        isError: report.errors.length > 0,
      };
    },
  });
}
