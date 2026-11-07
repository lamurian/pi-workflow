// Effort sizing at save_task: assertion count, owned-bytes and bulk-wording
// checks for every non-done task.

import fs from "node:fs";
import path from "node:path";
import type { ContractV2 } from "./state.ts";
import type { WorkflowConfig } from "./workflow-config-schema.ts";

export const DEFAULT_MAX_ASSERTIONS_PER_TASK = 3;
export const DEFAULT_MAX_MANUAL_ASSERTIONS = 2;
export const DEFAULT_MAX_TASK_BYTES = 98304;

const BULK_WORDING = /\b(every|each|all)\s+(rows?|files?|literals?|entry|entries|lines?)\b/i;

/** Resolved sizing limits. */
export interface SizingLimits {
  maxAssertionsPerTask: number;
  maxManualAssertions: number;
  maxTaskBytes: number;
}

function positive(v: unknown, fallback: number): number {
  return typeof v === "number" && Number.isInteger(v) && v > 0 ? v : fallback;
}

/**
 * Resolve sizing limits from workflow.json finalize settings.
 *
 * @param config - Loaded workflow config (or null).
 * @returns Limits with defaults applied.
 */
export function resolveSizingLimits(config: WorkflowConfig | null | undefined): SizingLimits {
  const f = config?.finalize;
  return {
    maxAssertionsPerTask: positive(f?.maxAssertionsPerTask, DEFAULT_MAX_ASSERTIONS_PER_TASK),
    maxManualAssertions: positive(f?.maxManualAssertions, DEFAULT_MAX_MANUAL_ASSERTIONS),
    maxTaskBytes: positive(f?.maxTaskBytes, DEFAULT_MAX_TASK_BYTES),
  };
}

function fileSize(cwd: string, rel: string): number {
  try {
    const st = fs.statSync(path.join(cwd, rel));
    return st.isFile() ? st.size : 0;
  } catch {
    return 0;
  }
}

/**
 * Check effort sizing for each non-done task.
 *
 * @param contract - Done-preserved contract.
 * @param cwd      - Project root used to stat owned files.
 * @param limits   - Resolved sizing limits.
 * @returns null when all tasks fit; otherwise a rejection reason.
 */
export function checkTaskSizing(
  contract: ContractV2,
  cwd: string,
  limits: SizingLimits,
): string | null {
  const problems: string[] = [];
  for (const t of contract.tasks) {
    if (t.status === "done") continue;
    const manual = !contract.tests.some((e) => e.tasks.includes(t.id));
    const limit = manual ? limits.maxManualAssertions : limits.maxAssertionsPerTask;
    if (manual) {
      const bad = t.expectedOutput.find((e) => !e.startsWith("inspect:"));
      if (bad !== undefined) {
        problems.push(
          `manual assertion: ${t.id} expectedOutput "${bad}" must start with 'inspect:' and say how it is verified`,
        );
      }
    }
    const count = t.expectedOutput.length;
    if (count > limit) {
      problems.push(
        `task too large: ${t.id} has ${count} ${manual ? "manual " : ""}assertions (limit ${limit})`,
      );
    }
    const owned = new Set(
      [...contract.sources, ...contract.tests].filter((e) => e.tasks.includes(t.id)).map((e) => e.path),
    );
    let bytes = 0;
    for (const p of owned) bytes += fileSize(cwd, p);
    if (bytes > limits.maxTaskBytes) {
      problems.push(`task too large: ${t.id} owns ${bytes} bytes of files (limit ${limits.maxTaskBytes})`);
    }
    const bulk = t.expectedOutput.find((e) => BULK_WORDING.test(e));
    if (bulk !== undefined && (t.commands ?? []).length === 0) {
      problems.push(
        `bulk wording: ${t.id} expectedOutput "${bulk}" uses every/each/all wording — ` +
          `list a command that checks it or split the task`,
      );
    }
  }
  return problems.length === 0 ? null : problems.join("; ");
}
