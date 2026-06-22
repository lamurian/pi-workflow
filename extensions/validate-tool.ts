import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { validateMappings } from "./validate.ts";
import { relative } from "node:path";

/**
 * Register the `adr_validate_mappings` AI tool.
 *
 * Cross-references all ADRs → specs → plans and reports orphaned
 * documents, gaps, and cross-reference errors.
 *
 * @param pi - ExtensionAPI reference.
 */
export function registerValidateTool(pi: ExtensionAPI): void {
  pi.registerTool({
    name: "adr_validate_mappings",
    label: "Validate Mappings",
    description:
      "Validate the ADR → Spec → Plan cross-reference chain. " +
      "Scans all documents and reports orphans (specs referencing missing ADRs, " +
      "plans referencing missing specs), gaps (ADRs with no specs, specs with no plans), " +
      "and provides a summary of all tracked items.",

    parameters: Type.Object({}),

    async execute(_toolCallId, _params, _signal, _onUpdate, ctx) {
      try {
        const report = await validateMappings(ctx.cwd);

        const lines: string[] = [];
        lines.push("# ADR → Spec → Plan Chain Validation");
        lines.push("");

        // Info summary
        for (const msg of report.info) {
          lines.push(`- ${msg}`);
        }
        lines.push("");

        // Errors
        if (report.errors.length > 0) {
          lines.push("## Errors");
          lines.push("");
          for (const err of report.errors) {
            lines.push(`- ❌ ${err}`);
          }
          lines.push("");
        }

        // Warnings
        if (report.warnings.length > 0) {
          lines.push("## Warnings");
          lines.push("");
          for (const warn of report.warnings) {
            lines.push(`- ⚠️ ${warn}`);
          }
          lines.push("");
        }

        if (report.errors.length === 0 && report.warnings.length === 0) {
          lines.push("✅ All chains are complete — no orphans or gaps found.");
        }

        const isError = report.errors.length > 0;

        return {
          content: [{ type: "text", text: lines.join("\n") }],
          isError,
        };
      } catch (err) {
        return {
          content: [
            {
              type: "text",
              text: `Validation failed: ${(err as Error).message}`,
            },
          ],
          isError: true,
        };
      }
    },
  });
}
