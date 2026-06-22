import type { WorkflowPhase } from "./state.ts";

/**
 * Tools that are subject to phase gating.
 * Only creation tools are gated — list/update tools are always allowed.
 */
const GATED_TOOLS = new Set(["adr_create", "spec_create", "plan_create"]);

/**
 * Brainstorm phases where gating is active.
 */
const BRAINSTORM_PHASES: WorkflowPhase[] = [
  "requirements",
  "specifying",
  "planning",
];

/**
 * Phase that each gated tool is allowed in.
 */
const TOOL_ALLOWED_PHASE: Record<string, WorkflowPhase> = {
  adr_create: "requirements",
  spec_create: "specifying",
  plan_create: "planning",
};

/**
 * Check whether a tool call should be blocked due to phase gating.
 *
 * During brainstorm phases (requirements, specifying, planning), document
 * creation tools are restricted to their matching phase:
 *   - adr_create  → requirements phase only
 *   - spec_create → specifying phase only
 *   - plan_create → planning phase only
 *
 * Outside brainstorm phases (idle, discussing, implementing), no gating applies.
 * List and update tools are never gated.
 *
 * @param toolName     - The name of the tool being called.
 * @param currentPhase - The current workflow phase.
 * @returns A block result if the tool should be blocked, or null if allowed.
 */
export function checkToolPhaseGate(
  toolName: string,
  currentPhase: WorkflowPhase,
): { block: boolean; reason: string } | null {
  // Only gate during brainstorm phases
  if (!BRAINSTORM_PHASES.includes(currentPhase)) return null;

  // Only gate creation tools
  if (!GATED_TOOLS.has(toolName)) return null;

  const allowedPhase = TOOL_ALLOWED_PHASE[toolName];
  if (currentPhase !== allowedPhase) {
    return {
      block: true,
      reason:
        `${toolName} is only available during the ${allowedPhase} phase. ` +
        `Current phase: "${currentPhase}". ` +
        `Use workflow_transition to move to the ${allowedPhase} phase first.`,
    };
  }

  return null;
}
