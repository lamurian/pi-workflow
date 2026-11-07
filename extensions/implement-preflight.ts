// /implement preflight: refuses to start when the pinned run plan no longer
// matches the project config or cannot serve the contract's test tasks.

import type { WorkflowState } from "./state-types.ts";
import { hashProjectConfig } from "./run-plan.ts";

/**
 * Check whether /implement may start from the saved state.
 *
 * Legacy states without a runPlan always pass.
 *
 * @param state - Saved workflow state.
 * @param cwd   - Project root.
 * @returns A one-line refusal naming the fix, or null when clear to start.
 */
export async function preflightImplement(state: WorkflowState, cwd: string): Promise<string | null> {
  // Legacy refusal: plain-string files predate the D/M/A allowlist.
  if (state.task?.files.some((f) => typeof f === "string")) {
    return (
      "This task contract predates the authoritative D/M/A file allowlist: its " +
      "files are plain strings. Re-run /discuss, then /finalize to re-save the " +
      "contract with { path, status } entries, then run /implement again."
    );
  }
  const plan = state.runPlan;
  if (!plan) return null;
  const hash = await hashProjectConfig(cwd);
  if (hash !== plan.configHash) {
    return ".pi/workflow.json changed since the run plan was approved; re-run /discuss -> /finalize to re-pin it.";
  }
  const c = state.contractV2;
  if (c && plan.scoped.length === 0) {
    const active = new Set(c.tasks.filter((t) => t.status === "active").map((t) => t.id));
    const owner = c.tests.find((p) => p.tasks.some((id) => active.has(id)));
    if (owner) {
      return `Active task owns test path ${owner.path} but the run plan has no scoped suites; configure implement.tests.scoped, then /discuss -> /finalize.`;
    }
  }
  return null;
}
