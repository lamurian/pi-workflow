import { statSync } from "node:fs";
import { join } from "node:path";
import type { AttemptRecord } from "./halt-report.ts";
import type { ContractV2 } from "./contract-types.ts";
import { buildSlowTasks, type SlowTask } from "./implement-report.ts";

/** Result shape carrying an optional slow-task list. */
export interface SlowTaskCarrier {
  slowTasks?: SlowTask[];
}

/** Per-behavior duration tracker (T22). */
export interface DurationTracker {
  durations: Record<string, number>;
  record: (behaviorId: string, attempts: AttemptRecord[]) => void;
  attach: <R extends SlowTaskCarrier>(r: R) => R;
}

/**
 * Create a tracker that accumulates attempt seconds per behavior and attaches slow tasks.
 * @param cwd      - Repo root used to stat owned paths.
 * @param contract - Getter for the current v2 contract (may be undefined).
 * @param result   - Main orchestrator result that also receives slow tasks.
 * @returns The tracker.
 */
export function createDurationTracker(
  cwd: string,
  contract: () => ContractV2 | undefined,
  result: SlowTaskCarrier,
): DurationTracker {
  const durations: Record<string, number> = {};
  const sizeOf = (p: string): number => {
    try { return statSync(join(cwd, p)).size; } catch { return 0; }
  };
  return {
    durations,
    record(behaviorId, attempts) {
      durations[behaviorId] = (durations[behaviorId] ?? 0) + attempts.reduce((s, a) => s + a.durationSec, 0);
    },
    attach(r) {
      const slow = buildSlowTasks(durations, contract(), sizeOf);
      if (slow.length) { r.slowTasks = slow; result.slowTasks = slow; }
      return r;
    },
  };
}
