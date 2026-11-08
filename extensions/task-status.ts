import type { WorkflowState } from "./state-types.ts";
import type { TaskStatus } from "./contract-types.ts";

/**
 * Write a task status to both the v2 contract (state.contractV2.tasks) and
 * the derived v1 view (state.task.behaviors) by id. A missing contractV2 or
 * task is tolerated: only the parts present are updated.
 *
 * @param state  - Workflow state to mutate.
 * @param id     - Task / behavior id, e.g. "T1".
 * @param status - Status to set.
 */
export function setTaskStatus(state: WorkflowState, id: string, status: TaskStatus): void {
  const unit = state.contractV2?.tasks.find((t) => t.id === id);
  if (unit) unit.status = status;
  const behavior = state.task?.behaviors.find((b) => b.id === id);
  if (behavior) behavior.status = status;
}
