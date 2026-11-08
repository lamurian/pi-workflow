// Baseline failure capture: record which full-suite tests are already red
// before any task runs, so the final gate can tolerate pre-existing failures.

import { join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { WorkflowState } from "./state-types.ts";
import { saveState } from "./state.ts";
import { gateTail } from "./test-gate-run.ts";
import { extractFailingPaths } from "./full-gate-triage.ts";

/**
 * Capture baseline failing test paths by running each recorded full suite once.
 *
 * Runs nothing when state.baselineFailures is already set or no non-empty
 * fullSuites list is recorded. Best-effort: never throws.
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
    const failing = new Set<string>();
    for (const suite of suites) {
      const [cmd = "", ...rest] = suite.argv;
      const suiteCwd = suite.cwd ? join(cwd, suite.cwd) : cwd;
      try {
        const r = await pi.exec(cmd, rest, { cwd: suiteCwd });
        if (r.code === 0 && !r.killed) continue;
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
