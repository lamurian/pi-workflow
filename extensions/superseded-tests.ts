// T7: superseded-unnamed advisory warnings. Pure decision logic over a
// validated contract and the HEAD-tracked path set: a tests path that is
// tracked at HEAD, not declared for deletion, and owned by a task whose
// description never names the file's basename is a superseded test the
// contract forgot to describe — advisory only, never a rejection.

import type { ContractV2 } from "./contract-types.ts";

/**
 * Advisory warnings for tracked test files no owning task description names.
 *
 * Per tests entry: skipped when the entry has status "D" or the path is not
 * tracked at HEAD; otherwise each owning task that is not done and whose
 * description does not mention the file's basename (case-sensitive match on
 * the file name, e.g. `quarto-syntax.test.ts`) yields one
 * `superseded-unnamed` warning naming the path and the task id.
 *
 * @param contract       - The validated contract being saved.
 * @param trackedAtHead  - Repo-relative paths tracked at HEAD (git ls-tree).
 * @returns One warning string per matching (entry, owner) pair; [] otherwise.
 */
export function supersededTestWarnings(
  contract: ContractV2,
  trackedAtHead: ReadonlySet<string>,
): string[] {
  const warnings: string[] = [];
  for (const entry of contract.tests) {
    if (entry.status === "D") continue;
    if (!trackedAtHead.has(entry.path)) continue;
    const basename = entry.path.split("/").pop() ?? entry.path;
    for (const taskId of entry.tasks) {
      const task = contract.tasks.find((t) => t.id === taskId);
      if (!task || task.status === "done") continue;
      if (task.description.includes(basename)) continue;
      warnings.push(
        `superseded-unnamed: ${entry.path} is tracked at HEAD but task ${task.id} ` +
          `never names '${basename}' in its description — fold the superseded test ` +
          `update into that description, or declare the path with status "D"`,
      );
    }
  }
  return warnings;
}
