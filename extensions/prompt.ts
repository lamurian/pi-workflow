import { loadContent } from "./utils.ts";

/**
 * Build the phase-specific system prompt.
 *
 * The discussing and finalized phases have a protocol prompt. Every other
 * phase returns an empty string — the TDD prompt for the implementing phase
 * is injected by runImplement via sendUserMessage.
 *
 * @param phase - Current workflow phase.
 * @returns The rendered system prompt string, or "" for ungated phases.
 */
export async function buildPhasePrompt(phase: string): Promise<string> {
  if (phase === "discussing") {
    return loadContent("phase-discussing.md");
  }
  if (phase === "finalized") {
    return loadContent("phase-finalized.md");
  }
  return "";
}
