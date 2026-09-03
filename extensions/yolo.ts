import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { saveState, updateUi, type WorkflowState } from "./state.ts";
import { restoreTools } from "./tools.ts";

/**
 * Snap back to the default pi session from any workflow phase.
 *
 * Resets all phase state (discussing, brainstorming, implementing, etc.)
 * to idle, clears the UI footer and widget, and notifies the agent
 * via a steer message so it can acknowledge the reset.
 *
 * @param pi  - ExtensionAPI reference for state persistence.
 * @param ctx - Extension context for UI updates and notification.
 */
export async function runYolo(
  pi: ExtensionAPI,
  ctx: ExtensionContext,
): Promise<void> {
  const state: WorkflowState = {
    phase: "idle",
    specText: "",
  };
  saveState(pi, state);
  // Back to the default session: restore the full toolset.
  restoreTools(pi);
  updateUi(state, ctx);
  ctx.ui.notify("Workflow reset. Back to default session.", "info");
  pi.sendUserMessage("/yolo — session reset to default", { deliverAs: "steer" });
}
