import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { createPlan, listPlans } from "./plan.ts";
import { relative } from "node:path";

/** Maximum words allowed in a plan title for atomicity. */
const MAX_TITLE_WORDS = 5;

/**
 * Register the `plan_create` AI tool so the agent can write complete plan files.
 *
 * Unlike the `/plan` slash command, this tool accepts full plan content
 * and writes a complete, filled-in plan document.
 *
 * @param pi - ExtensionAPI reference.
 */
export function registerPlanTool(pi: ExtensionAPI): void {
  pi.registerTool({
    name: "plan_create",
    label: "Create Plan",
    description:
      "Create a complete plan file linked to a spec. " +
      "Each plan must be atomic — one task with a clear Definition of Done for one spec. " +
      "Use this to write finished plans with implementation steps, risks, and UAT. " +
      "Returns the created file path.",

    parameters: Type.Object({
      specNumber: Type.String({
        description: "Spec number this plan implements (e.g. '001' for spec 001)",
      }),
      title: Type.String({
        description: "Short descriptive title (<5 words), e.g. 'Implement Auth Endpoints'",
      }),
      content: Type.String({
        description:
          "Full plan body in markdown. Must include:\n" +
          "- # Overview: context and motivation\n" +
          "- # Goals: measurable outcomes as bullet points\n" +
          "- # Implementation Steps: actionable tasks as checkboxes (- [ ])\n" +
          "- # Risks: table with Likelihood, Impact, Mitigation\n" +
          "- # UAT: numbered steps to guide user testing\n" +
          "- # References: will auto-link to the spec",
      }),
      description: Type.Optional(
        Type.String({
          description: "One-sentence summary (defaults to title if omitted)",
        }),
      ),
    }),

    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const { specNumber, title, content, description } = params;

      if (!specNumber || !title || !content) {
        return {
          content: [
            {
              type: "text",
              text: "Error: specNumber, title, and content are required.",
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
                `Error: Plan title "${title}" has ${wordCount} words, exceeding the ` +
                `${MAX_TITLE_WORDS}-word atomicity limit. ` +
                `Keep titles focused on one task (≤${MAX_TITLE_WORDS} words).`,
            },
          ],
          isError: true,
        };
      }

      // Single spec reference check
      const specRefs = content.match(/@docs\/specs\/(\d{3})/gi);
      if (specRefs) {
        const uniqueSpecs = new Set(specRefs.map((r: string) => r.toLowerCase()));
        if (uniqueSpecs.size > 1) {
          return {
            content: [
              {
                type: "text",
                text:
                  `Error: Plan references ${uniqueSpecs.size} different specs ` +
                  `([${[...uniqueSpecs].join(", ")}]). ` +
                  `Each plan must be atomic and implement only one spec. ` +
                  `Create separate plans for each spec.`,
            },
          ],
          isError: true,
        };
      }
      }

      try {
        const planPath = await createPlan(specNumber, title, content, ctx.cwd, description);

        // Auto-update spec remaining count
        const normalizedSpecNum = String(parseInt(specNumber, 10)).padStart(3, "0");
        const { computeAndUpdateSpecRemaining } = await import("./spec.ts");
        const { remaining } = await computeAndUpdateSpecRemaining(normalizedSpecNum, ctx.cwd);

        const relPath = relative(ctx.cwd, planPath);
        return {
          content: [
            {
              type: "text",
              text: `Plan created: ${relPath}\nTitle: ${title}\nLinked to spec ${specNumber} (remaining: ${remaining})`,
            },
          ],
        };
      } catch (err) {
        return {
          content: [
            {
              type: "text",
              text: `Failed to create plan: ${(err as Error).message}`,
            },
          ],
          isError: true,
        };
      }
    },
  });

  pi.registerTool({
    name: "plan_list",
    label: "List Plans",
    description: "List all plan files in the project.",

    parameters: Type.Object({
      specNumber: Type.Optional(
        Type.String({
          description: "Filter by spec number (optional). If omitted, lists all plans.",
        }),
      ),
    }),

    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      try {
        const files = await listPlans(params.specNumber ?? "", ctx.cwd);
        if (files.length === 0) {
          return {
            content: [
              {
                type: "text",
                text: params.specNumber
                  ? `No plans found for spec ${params.specNumber}.`
                  : "No plans found in the project.",
              },
            ],
          };
        }
        const relPaths = files.map((f) => relative(ctx.cwd, f));
        return {
          content: [
            {
              type: "text",
              text: `Found ${files.length} plan(s):\n${relPaths.map((p, i) => `${i + 1}. ${p}`).join("\n")}`,
            },
          ],
        };
      } catch (err) {
        return {
          content: [
            { type: "text", text: `Failed to list plans: ${(err as Error).message}` },
          ],
          isError: true,
        };
      }
    },
  });
}
