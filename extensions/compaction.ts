import type {
  ExtensionContext,
  SessionBeforeCompactEvent,
  SessionCompactEvent,
} from "@earendil-works/pi-coding-agent";
import { loadState } from "./state.ts";

/**
 * Intercept session_before_compact to preserve the agreed specification
 * in the compaction summary.
 *
 * When a workflow is active (brainstorming, spec_finalized, implementing),
 * this handler injects the spec text into the compaction summary under
 * "Key Decisions" and "Next Steps" so the LLM retains the specification
 * after compaction.
 *
 * @param event - The before-compact event with preparation data.
 * @param ctx   - Extension context for state access.
 * @returns A custom compaction payload, cancellation, or undefined to let default run.
 */
export async function handlePreCompact(
  event: SessionBeforeCompactEvent,
  ctx: ExtensionContext,
): Promise<
  | { compaction: { summary: string; firstKeptEntryId: string; tokensBefore: number; details?: Record<string, unknown> } }
  | { cancel: true }
  | undefined
> {
  const state = loadState(ctx);

  // No active workflow — let default compaction handle it
  if (!state || state.phase === "idle") {
    return undefined;
  }

  const { preparation } = event;

  // Build a spec-preserving summary injection
  const specSection = state.specText
    ? `\n\n## Specification\n${state.specText}`
    : "";

  const adrSection =
    state.adrFiles.length > 0
      ? `\n\n## Key Decisions\nReferenced in ADR: ${state.adrFiles.join(", ")}`
      : "";

  const nextSteps = `\n\n## Next Steps\nContinue ${state.phase.replace(/_/g, " ")} phase.`;

  const customSummary =
    `Workflow phase: ${state.phase}.${specSection}${adrSection}${nextSteps}`;

  return {
    compaction: {
      summary: customSummary,
      firstKeptEntryId: preparation.firstKeptEntryId,
      tokensBefore: preparation.tokensBefore,
      details: {
        workflowPhase: state.phase,
        adrFiles: state.adrFiles,
        readFiles: [
          ...(preparation.fileOps?.readFiles ?? []),
          ...state.adrFiles,
        ],
        modifiedFiles: preparation.fileOps?.modifiedFiles ?? [],
      },
    },
  };
}

/**
 * After compaction, re-inject spec context and update UI indicators.
 *
 * Called from the session_compact event. Restores the footer
 * status and widget to reflect the current workflow phase.
 *
 * @param _event - The post-compact event (unused, for future extensibility).
 * @param ctx    - Extension context for UI access.
 */
export async function handlePostCompact(
  _event: SessionCompactEvent,
  ctx: ExtensionContext,
): Promise<void> {
  // Import dynamically to avoid circular dependency at module level
  const { updateUi } = await import("./state.ts");
  const state = loadState(ctx);
  if (state) {
    updateUi(state, ctx);
  }
}
