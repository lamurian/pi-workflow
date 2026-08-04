import { loadContent } from "./utils.ts";

/**
 * Build the phase-specific system prompt.
 *
 * Only the "discussing" phase has a protocol prompt (phase-discussing.md).
 * Every other phase returns an empty string — the TDD prompt for the
 * implementing phase is injected by startTdd via sendUserMessage.
 *
 * @param phase - Current workflow phase.
 * @param _skipQuestionnaire - Ignored; retained for API compatibility.
 * @returns The rendered system prompt string, or "" for non-discussing phases.
 */
export async function buildPhasePrompt(
  phase: string,
  _skipQuestionnaire = false,
): Promise<string> {
  if (phase !== "discussing") return "";
  const template = await loadContent("phase-discussing.md");
  return template;
}
