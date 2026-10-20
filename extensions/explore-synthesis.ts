import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { complete } from "@earendil-works/pi-ai";
import { loadContent } from "./utils.ts";
import type { ScoutResult } from "./scout-runner.ts";

// ─── Synthesis ─────────────────────────────────────────────────────────────────

/**
 * Synthesize multiple scout results into a structured summary.
 *
 * Calls the current model with the `explore-synthesis.md` system prompt,
 * passing all scout outputs as context.
 *
 * @param instruction - The original exploration instruction.
 * @param results     - Array of scout results.
 * @param ctx         - Extension context (provides model and auth).
 * @param signal      - Optional abort signal.
 * @returns A formatted summary string.
 */
export async function synthesizeResults(
  instruction: string,
  results: ScoutResult[],
  ctx: ExtensionContext,
  signal?: AbortSignal,
): Promise<string> {
  const systemPrompt = await loadContent("explore-synthesis.md");

  // If no scout produced usable output, skip the LLM call entirely — an
  // unconstrained synthesizer tends to fabricate plausible file paths from
  // the instruction alone (observed: cited .ts files that are really .tsx).
  const hasAnyOutput = results.some(
    (r) => r.exitCode === 0 && r.output.trim().length > 0,
  );
  if (!hasAnyOutput) {
    return formatNoOutputSummary(instruction, results);
  }

  if (!ctx.model) {
    return formatFallbackSummary(instruction, results);
  }

  const auth = await ctx.modelRegistry.getApiKeyAndHeaders(ctx.model);
  if (!auth.ok || !auth.apiKey) {
    return formatFallbackSummary(instruction, results);
  }

  const scoutOutputs = results
    .map(
      (r) =>
        `### Task: ${r.task}\nStatus: ${r.exitCode === 0 ? "success" : "failed"}${r.errorMessage ? ` (${r.errorMessage})` : ""}\n\n${r.output || "(no output)"}`,
    )
    .join("\n\n---\n\n");

  const userMessage = {
    role: "user" as const,
    content: [
      {
        type: "text" as const,
        text: `## Exploration Instruction\n${instruction}\n\n## Scout Results\n\n${scoutOutputs}`,
      },
    ],
    timestamp: Date.now(),
  };

  const response = await complete(
    ctx.model,
    { systemPrompt, messages: [userMessage] },
    { apiKey: auth.apiKey, headers: auth.headers, signal },
  );

  if (response.stopReason === "aborted" || response.stopReason === "error") {
    return formatFallbackSummary(instruction, results);
  }

  const text = response.content
    .filter((c): c is { type: "text"; text: string } => c.type === "text")
    .map((c) => c.text)
    .join("\n")
    .trim();

  return text || formatFallbackSummary(instruction, results);
}

/**
 * Summary returned when every scout returned empty or failed results.
 *
 * States the gap explicitly instead of letting the synthesis model
 * fabricate plausible findings from the instruction alone.
 */
function formatNoOutputSummary(instruction: string, results: ScoutResult[]): string {
  const lines: string[] = [
    `## Summary`,
    `No scout produced output for: ${instruction}.`,
    "Every parallel task returned empty or failed, so no file paths, code, or findings were gathered.",
    ``,
    `## Key Files`,
    `- **None** — no scout produced usable output.`,
  ];
  for (const r of results) {
    if (r.exitCode !== 0) {
      lines.push(
        `\n*Task "${r.task}" failed: ${r.errorMessage || `exit code ${r.exitCode}`}*`,
      );
    }
  }
  return lines.join("\n");
}

/** Fallback summary when LLM is unavailable. */
function formatFallbackSummary(instruction: string, results: ScoutResult[]): string {
  const lines: string[] = [
    `## Summary`,
    `Exploration results for: ${instruction}`,
    ``,
    `## Key Files`,
  ];
  for (const r of results) {
    if (r.output) {
      const fileMatches = r.output.match(/`[^`]+`/g);
      if (fileMatches) {
        for (const f of fileMatches) {
          lines.push(`- ${f}`);
        }
      }
    }
    if (r.exitCode !== 0) {
      lines.push(
        `\n*Task "${r.task}" failed: ${r.errorMessage || `exit code ${r.exitCode}`}*`,
      );
    }
  }
  return lines.join("\n");
}
