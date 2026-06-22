import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { createSpec, listSpecs, computeAndUpdateSpecRemaining } from "./spec.ts";
import { relative } from "node:path";

/** Maximum words allowed in a spec title for atomicity. */
const MAX_TITLE_WORDS = 5;

/**
 * Register the `spec_create` AI tool so the agent can write complete spec files.
 *
 * Unlike the `/spec` slash command, this tool accepts full spec content
 * and writes a complete, filled-in specification document.
 *
 * @param pi - ExtensionAPI reference.
 */
export function registerSpecTool(pi: ExtensionAPI): void {
  pi.registerTool({
    name: "spec_create",
    label: "Create Spec",
    description:
      "Create a complete specification file linked to an ADR. " +
      "Each spec must be atomic — one architectural concern from one ADR. " +
      "Use this to write finished specs with full requirements, design, and references. " +
      "Create ALL specs for an ADR before moving to planning. " +
      "Returns the created file path.",

    parameters: Type.Object({
      adrNumber: Type.Number({
        description: "ADR number this spec implements (e.g. 1 for ADR 001)",
      }),
      title: Type.String({
        description: "Short descriptive title (<5 words), e.g. 'User Authentication API'",
      }),
      content: Type.String({
        description:
          "Full spec body in markdown. Must include:\n" +
          "- # Requirements Specification: functional and non-functional requirements as bullet points\n" +
          "- # Design Principles: architecture, data models, API/interface definitions as bullet points\n" +
          "- # References: will auto-link to the ADR, but add any additional references",
      }),
      description: Type.Optional(
        Type.String({
          description: "One-sentence summary (defaults to title if omitted)",
        }),
      ),
    }),

    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const { adrNumber, title, content, description } = params;

      if (!adrNumber || !title || !content) {
        return {
          content: [
            {
              type: "text",
              text: "Error: adrNumber, title, and content are required.",
            },
          ],
          isError: true,
        };
      }

      // ── Atomicity guardrails ─────────────────────────────────

      // Title word count check
      const wordCount = title.trim().split(/\s+/).length;
      if (wordCount > MAX_TITLE_WORDS) {
        return {
          content: [
            {
              type: "text",
              text:
                `Error: Spec title "${title}" has ${wordCount} words, exceeding the ` +
                `${MAX_TITLE_WORDS}-word atomicity limit. ` +
                `Keep titles focused on one architectural concern (≤${MAX_TITLE_WORDS} words).`,
            },
          ],
          isError: true,
        };
      }

      // Single ADR reference check
      const adrRefs = content.match(/@docs\/ADR\/(\d{3})/gi);
      if (adrRefs) {
        const uniqueAdrs = new Set(adrRefs.map((r: string) => r.toLowerCase()));
        if (uniqueAdrs.size > 1) {
          return {
            content: [
              {
                type: "text",
                text:
                  `Error: Spec references ${uniqueAdrs.size} different ADRs ` +
                  `([${[...uniqueAdrs].join(", ")}]). ` +
                  `Each spec must be atomic and implement only one ADR. ` +
                  `Create separate specs for each ADR.`,
            },
          ],
          isError: true,
        };
      }
      }

      try {
        const specPath = await createSpec(adrNumber, title, content, ctx.cwd, description);

        // Auto-update ADR remaining count
        const { computeAndUpdateAdrRemaining } = await import("./adr.ts");
        const { remaining } = await computeAndUpdateAdrRemaining(adrNumber, ctx.cwd);

        const relPath = relative(ctx.cwd, specPath);
        return {
          content: [
            {
              type: "text",
              text: `Spec created: ${relPath}\nTitle: ${title}\nLinked to ADR ${String(adrNumber).padStart(3, "0")} (remaining: ${remaining})`,
            },
          ],
        };
      } catch (err) {
        return {
          content: [
            {
              type: "text",
              text: `Failed to create spec: ${(err as Error).message}`,
            },
          ],
          isError: true,
        };
      }
    },
  });

  pi.registerTool({
    name: "spec_list",
    label: "List Specs",
    description: "List all spec files in the project. Use to check what specs have been created.",

    parameters: Type.Object({
      adrNumber: Type.Optional(
        Type.Number({
          description: "Filter by ADR number (optional). If omitted, lists all specs.",
        }),
      ),
    }),

    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      try {
        const files = await listSpecs(params.adrNumber ?? 0, ctx.cwd);
        if (files.length === 0) {
          return {
            content: [
              {
                type: "text",
                text: params.adrNumber
                  ? `No specs found for ADR ${params.adrNumber}.`
                  : "No specs found in the project.",
              },
            ],
          };
        }
        const relPaths = files.map((f) => relative(ctx.cwd, f));
        return {
          content: [
            {
              type: "text",
              text: `Found ${files.length} spec(s):\n${relPaths.map((p, i) => `${i + 1}. ${p}`).join("\n")}`,
            },
          ],
        };
      } catch (err) {
        return {
          content: [
            { type: "text", text: `Failed to list specs: ${(err as Error).message}` },
          ],
          isError: true,
        };
      }
    },
  });

  pi.registerTool({
    name: "spec_update",
    label: "Update Spec",
    description:
      "Compute and update the remaining cross-reference count for a spec. " +
      "Scans all plans referencing this spec and sets the `remaining` field in the spec frontmatter. " +
      "Use after creating all plans for a spec.",

    parameters: Type.Object({
      specNumber: Type.String({
        description: "Spec number in 3-digit format (e.g. '001' for spec 001)",
      }),
    }),

    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const { specNumber } = params;

      if (!specNumber) {
        return {
          content: [{ type: "text", text: "Error: specNumber is required." }],
          isError: true,
        };
      }

      try {
        const { remaining, status } = await computeAndUpdateSpecRemaining(
          specNumber,
          ctx.cwd,
        );
        return {
          content: [
            {
              type: "text",
              text:
                `Spec ${String(parseInt(specNumber, 10)).padStart(3, "0")} updated: ` +
                `remaining=${remaining}, status=${status}`,
            },
          ],
        };
      } catch (err) {
        return {
          content: [
            {
              type: "text",
              text: `Failed to update spec: ${(err as Error).message}`,
            },
          ],
          isError: true,
        };
      }
    },
  });
}
