import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

/**
 * Tools that write to the filesystem, PARA knowledge base, or git history.
 *
 * These are removed from the active toolset while the workflow is in the
 * "discussing" phase so the model physically cannot call them to drop
 * ADR/spec/plan files into the repository. The existing `tool_call`
 * backstop remains as a second layer for tools added dynamically.
 */
export const DISCUSS_BLOCKED_TOOLS: readonly string[] = [
  "write",
  "edit",
  "create_para_doc",
  "update_para_doc",
  "batch_create_para_docs",
  "expand_bullet_points",
  "standardize_frontmatter",
  "commit_changes",
  "commit_amend",
];

/**
 * Snapshot of the active toolset taken when a discussion starts.
 *
 * Kept in module state (process lifetime) because `pi.setActiveTools()`
 * is itself process-scoped; a session resumed in the discussing phase
 * re-takes the snapshot via `session_start`.
 */
let _toolsBeforeDiscuss: string[] | undefined;

/**
 * Apply the read-only toolset for the discussing phase.
 *
 * Takes a snapshot of the current active tools on the first call, then
 * restricts the active set to the snapshot minus DISCUSS_BLOCKED_TOOLS.
 * Changes apply before the next model request, so calling this before
 * the discussion steer guarantees the filtered set for the discussion
 * turn.
 *
 * @param pi - ExtensionAPI reference for active tool management.
 */
export function applyDiscussTools(pi: ExtensionAPI): void {
  if (_toolsBeforeDiscuss === undefined) {
    _toolsBeforeDiscuss = pi.getActiveTools();
  }
  const snapshot = _toolsBeforeDiscuss;
  pi.setActiveTools(
    snapshot.filter((name) => !DISCUSS_BLOCKED_TOOLS.includes(name)),
  );
}

/**
 * Restore the toolset saved when the discussion started.
 *
 * No-op when no snapshot exists (fresh session, or tools already back to
 * the default set). Clears the snapshot after restoring so a later phase
 * transition starts from a clean slate.
 *
 * @param pi - ExtensionAPI reference for active tool management.
 */
export function restoreTools(pi: ExtensionAPI): void {
  if (_toolsBeforeDiscuss === undefined) return;
  pi.setActiveTools(_toolsBeforeDiscuss);
  _toolsBeforeDiscuss = undefined;
}

/**
 * Clear the saved tool snapshot without touching active tools.
 *
 * Primarily a test helper to isolate tool-gating tests from each other.
 */
export function resetToolsState(): void {
  _toolsBeforeDiscuss = undefined;
}