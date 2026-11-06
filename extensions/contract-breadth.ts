// Per-task path breadth check (T1): the finalize-time cap on how many
// declared paths a single task may own. Pure — no I/O, no state mutation.

import type { ContractV2 } from "./state.ts";

/**
 * Count distinct paths per non-done task across `sources` and `tests` and
 * reject tasks over the cap.
 *
 * For every task whose status is not "done", counts the distinct paths
 * across both lists whose `tasks` include the task id (`D` entries count; a
 * shared path counts for each owning task). Tasks whose count exceeds
 * `maxPathsPerTask` are violations; done tasks are exempt.
 *
 * @param contract        - The done-preserved contract to check.
 * @param maxPathsPerTask - The positive per-task path limit (from workflow.json).
 * @returns `null` when every non-done task owns at most the limit;
 *          otherwise a rejection reason starting with "task too broad:"
 *          naming each over-limit task, its count and the limit.
 */
export function checkTaskBreadth(
  contract: ContractV2,
  maxPathsPerTask: number,
): string | null {
  const owned = new Map<string, Set<string>>();
  for (const entry of [...contract.sources, ...contract.tests]) {
    for (const taskId of entry.tasks) {
      const paths = owned.get(taskId);
      if (paths) paths.add(entry.path);
      else owned.set(taskId, new Set([entry.path]));
    }
  }
  const over = contract.tasks.filter(
    (t) => t.status !== "done" && (owned.get(t.id)?.size ?? 0) > maxPathsPerTask,
  );
  if (over.length === 0) return null;
  const parts = over.map(
    (t) => `${t.id} owns ${owned.get(t.id)?.size ?? 0} paths (limit ${maxPathsPerTask})`,
  );
  return `task too broad: ${parts.join("; ")}`;
}
