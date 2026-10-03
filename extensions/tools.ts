/**
 * Tools that write to the filesystem, PARA knowledge base, or git history.
 *
 * These are gated by the `tool_call` handler while the workflow is in the
 * "discussing" or "finalizing" phase. The tools stay visible in the active
 * set — the gate blocks attempts with a phase-aware message instead of
 * hiding the tools, so the model gets an explanation rather than a
 * confusing "tool not found".
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
