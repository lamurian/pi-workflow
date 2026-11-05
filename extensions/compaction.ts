import type {
  ExtensionContext,
  FileOperations,
  SessionBeforeCompactEvent,
  SessionCompactEvent,
} from "@earendil-works/pi-coding-agent";
// pi 1.5.0 does not re-export computeFileLists from the package root (the
// package exports map only exposes "." and "./rpc-entry"), so the helper is
// imported from the compaction utils module that exports it.
import {
  computeFileLists,
  createFileOps,
} from "../node_modules/@earendil-works/pi-coding-agent/dist/core/compaction/utils.js";
import { loadState } from "./state.ts";
import { formatTask } from "./task-contract.ts";

/**
 * Intercept session_before_compact to preserve the task contract and spec.
 *
 * When a workflow is active (discussing, finalizing, implementing), this
 * handler injects the spec text and the full task contract (behaviors and
 * statuses) into the compaction summary so the LLM retains the contract
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

  const specSection = state.specText
    ? `\n\n## Specification\n${state.specText}`
    : "";

  const taskSection = state.task
    ? `\n\n## Task Contract\n${formatTask(state.task)}`
    : "";

  const nextSteps = `\n\n## Next Steps\nContinue ${state.phase.replace(/_/g, " ")} phase.`;

  const customSummary =
    `Workflow phase: ${state.phase}.${specSection}${taskSection}${nextSteps}`;

  // fileOps is typed non-optional, but custom/prepared events may omit it —
  // fall back to empty operations (the tests build minimal events).
  const fileOps =
    (preparation as { fileOps?: FileOperations }).fileOps ?? createFileOps();
  const { readFiles, modifiedFiles } = computeFileLists(fileOps);

  return {
    compaction: {
      summary: customSummary,
      firstKeptEntryId: preparation.firstKeptEntryId,
      tokensBefore: preparation.tokensBefore,
      details: {
        workflowPhase: state.phase,
        readFiles,
        modifiedFiles,
      },
    },
  };
}

/**
 * After compaction, re-inject context and update UI indicators.
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
