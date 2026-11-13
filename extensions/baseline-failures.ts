// Baseline failure capture: record which full-suite tests are already red
// before any task runs, so the final gate can tolerate pre-existing failures.
// The capture runs under one shared wall-clock budget so a hanging suite can
// never park the chain (T1).

import { join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { WorkflowState } from "./state-types.ts";
import { saveState } from "./state.ts";
import { gateTail } from "./test-gate-run.ts";
import { extractFailingPaths } from "./full-gate-triage.ts";

/** Default shared wall-clock budget for baseline capture, in milliseconds. */
const DEFAULT_BASELINE_BUDGET_MS = 600_000;

/**
 * Resolve the shared wall-clock budget for baseline capture, honoring the
 * `PI_BASELINE_TIMEOUT_MS` environment variable override (milliseconds).
 * Invalid or missing values fall back to {@link DEFAULT_BASELINE_BUDGET_MS}.
 *
 * @param env - Environment map (defaults to process.env); injectable for tests.
 * @returns The budget in milliseconds (&gt; 0).
 */
export function baselineBudgetMs(
  env: Record<string, string | undefined> = process.env,
): number {
  const raw = Number(env.PI_BASELINE_TIMEOUT_MS);
  return Number.isFinite(raw) && raw > 0 ? raw : DEFAULT_BASELINE_BUDGET_MS;
}

/**
 * Capture baseline failing test paths by running each recorded full suite once,
 * under a shared wall-clock budget (PI_BASELINE_TIMEOUT_MS, 600000 ms default).
 *
 * Runs nothing when state.baselineFailures is already set or no non-empty
 * fullSuites list is recorded. The budget is resolved once and a deadline is
 * computed before the suite loop: every exec receives the remaining time as
 * its `timeout` so a hanging suite is SIGTERM'd instead of parking the chain;
 * a `killed` result marks the suite unknown (its partial output is never
 * triaged, so it contributes no failing paths); and a suite that would start
 * after the deadline is skipped entirely (no exec). Persistence semantics are
 * unchanged: one saveState at the end with the accumulated paths of the
 * suites that ran. Best-effort: never throws.
 *
 * @param pi    - ExtensionAPI used for exec and state persistence.
 * @param cwd   - Repository working directory.
 * @param state - Workflow state; baselineFailures is set and persisted.
 * @returns Resolves when capture is done (or skipped).
 */
export async function captureBaselineFailures(
  pi: ExtensionAPI,
  cwd: string,
  state: WorkflowState,
): Promise<void> {
  try {
    if (state.baselineFailures !== undefined) return;
    const suites = state.testTool?.fullSuites;
    if (!suites || suites.length === 0) return;
    const deadline = Date.now() + baselineBudgetMs();
    const failing = new Set<string>();
    for (const suite of suites) {
      const remainingMs = deadline - Date.now();
      if (remainingMs <= 0) continue; // Budget exhausted: skip without exec.
      const [cmd = "", ...rest] = suite.argv;
      const suiteCwd = suite.cwd ? join(cwd, suite.cwd) : cwd;
      try {
        const r = await pi.exec(cmd, rest, { cwd: suiteCwd, timeout: remainingMs });
        if (r.killed) continue; // Killed by the budget: unknown, no paths.
        if (r.code === 0) continue;
        const tail = gateTail([r.stdout ?? "", r.stderr ?? ""].filter(Boolean).join("\n"));
        const result = {
          label: suite.label,
          passed: false,
          tail,
          ...(suite.cwd && suite.cwd !== "." ? { cwd: suite.cwd } : {}),
        };
        for (const p of extractFailingPaths(result)) failing.add(p);
      } catch {
        // Spawn failure: no paths to record for this suite.
      }
    }
    state.baselineFailures = [...failing].sort();
    saveState(pi, state);
  } catch {
    // Best-effort: never throw.
  }
}
