import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { createAdr, computeAndUpdateAdrRemaining } from "./adr.ts";
import { createSpec } from "./spec.ts";
import { relative } from "node:path";

/**
 * Register the batch ADR and spec creation tools.
 *
 * - `batch_create_adrs`: Create multiple ADRs in one call, auto-numbered.
 * - `batch_create_specs`: Create multiple specs for the same ADR in one call,
 *   with auto-numbering and auto-update of the ADR's remaining count.
 *
 * @param pi - ExtensionAPI reference.
 */
export function registerBatchTools(pi: ExtensionAPI): void {
  // ── batch_create_adrs ─────────────────────────────────────

  pi.registerTool({
    name: "batch_create_adrs",
    label: "Batch Create ADRs",
    description:
      "Create multiple ADR documents in one call. " +
      "Each ADR is auto-numbered sequentially. " +
      "Use this to batch-produce all ADRs for a project phase. " +
      "Returns the list of created file paths.",

    parameters: Type.Object({
      adrs: Type.Array(
        Type.Object({
          title: Type.String({ description: "ADR title (<5 words)" }),
          description: Type.String({ description: "One-sentence summary" }),
          context: Type.String({ description: "Problem statement and options" }),
          decision: Type.String({ description: "Chosen approach and rationale" }),
          impact: Type.String({ description: "Trade-offs and consequences" }),
          summary: Type.String({ description: "One-line summary for ARCHITECTURE.md" }),
          status: Type.Optional(
            Type.String({ description: "Status (default: proposed)" }),
          ),
        }),
        { description: "Array of ADR objects to create" },
      ),
    }),

    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const { adrs } = params;

      if (!adrs || adrs.length === 0) {
        return {
          content: [{ type: "text", text: "Error: Provide at least one ADR in the `adrs` array." }],
          isError: true,
        };
      }

      const created: string[] = [];
      const errors: string[] = [];

      for (const adr of adrs) {
        try {
          const path = await createAdr(
            {
              title: adr.title,
              description: adr.description,
              status: (adr.status as "proposed" | "accepted") || "proposed",
              context: adr.context,
              decision: adr.decision,
              impact: adr.impact,
            },
            ctx.cwd,
          );
          created.push(relative(ctx.cwd, path));
        } catch (err) {
          errors.push(`"${adr.title}": ${(err as Error).message}`);
        }
      }

      const lines: string[] = [];
      lines.push(`Created ${created.length} ADR(s):`);
      for (const p of created) lines.push(`- ${p}`);
      if (errors.length > 0) {
        lines.push("");
        lines.push(`Failed to create ${errors.length} ADR(s):`);
        for (const e of errors) lines.push(`- ${e}`);
      }

      return {
        content: [{ type: "text", text: lines.join("\n") }],
        isError: errors.length > 0,
      };
    },
  });

  // ── batch_create_specs ────────────────────────────────────

  pi.registerTool({
    name: "batch_create_specs",
    label: "Batch Create Specs",
    description:
      "Create multiple spec documents for the same ADR in one call. " +
      "Each spec is auto-numbered sequentially and auto-linked to the ADR. " +
      "After creation, the ADR's remaining count is auto-updated. " +
      "Use this to batch-produce all specs for an ADR. " +
      "Returns the list of created file paths.",

    parameters: Type.Object({
      adrNumber: Type.Number({
        description: "ADR number these specs implement (e.g. 1 for ADR 001)",
      }),
      specs: Type.Array(
        Type.Object({
          title: Type.String({ description: "Spec title (<5 words)" }),
          content: Type.String({ description: "Full spec body in markdown" }),
          description: Type.Optional(
            Type.String({ description: "One-sentence summary (defaults to title)" }),
          ),
        }),
        { description: "Array of spec objects to create" },
      ),
    }),

    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const { adrNumber, specs } = params;

      if (!specs || specs.length === 0) {
        return {
          content: [
            {
              type: "text",
              text: "Error: Provide at least one spec in the `specs` array.",
            },
          ],
          isError: true,
        };
      }

      const created: string[] = [];
      const errors: string[] = [];

      for (const spec of specs) {
        try {
          const path = await createSpec(adrNumber, spec.title, spec.content, ctx.cwd, spec.description);
          created.push(relative(ctx.cwd, path));
        } catch (err) {
          errors.push(`"${spec.title}": ${(err as Error).message}`);
        }
      }

      // Auto-update ADR remaining count after batch creation
      const { remaining } = await computeAndUpdateAdrRemaining(adrNumber, ctx.cwd);

      const lines: string[] = [];
      lines.push(`Created ${created.length} spec(s) for ADR ${String(adrNumber).padStart(3, "0")}:`);
      for (const p of created) lines.push(`- ${p}`);
      lines.push(`ADR remaining: ${remaining}`);
      if (errors.length > 0) {
        lines.push("");
        lines.push(`Failed to create ${errors.length} spec(s):`);
        for (const e of errors) lines.push(`- ${e}`);
      }

      return {
        content: [{ type: "text", text: lines.join("\n") }],
        isError: errors.length > 0,
      };
    },
  });
}
