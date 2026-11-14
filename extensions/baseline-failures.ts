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
import { isOrchestrationCancelled } from "./orchestration-cancel.ts";

/** Default shared wall-clock budget for baseline capture, in milliseconds. */
const DEFAULT_BASELINE_BUDGET_MS = 600_000;

/** Heartbeat interval while a capture is running, in milliseconds (T3). */
const HEARTBEAT_INTERVAL_MS = 300_000;

/** Timer handle that works whether setInterval yields a Node Timeout or a DOM number. */
type HeartbeatHandle = ReturnType<typeof setInterval> & { unref?: () => void };

/**
 * Progress notifier for baseline capture (T2). `level` defaults to `info`.
 * Callers that omit it stay silent.
 */
export type BaselineNotify = (message: string, level?: "info" | "warning") => void;

/**
 * Emit a progress notification best-effort: a throwing notifier must never
 * fail the capture.
 *
 * @param notify - Optional notifier; nothing happens when omitted.
 * @param message - Notification text.
 * @param level - Notification level (info or warning).
 */
function safeNotify(
  notify: BaselineNotify | undefined,
  message: string,
  level: "info" | "warning",
): void {
  try {
    notify?.(message, level);
  } catch {
    // Best-effort: notification failures are ignored.
  }
}

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
 * Runs nothing when state.baselineFailures is already set, when the
 * state.baselineAttempted marker is already set (an interrupted previous
 * attempt whose result was never written), or when no non-empty fullSuites
 * list is recorded. After the guards pass, the marker is set and persisted
 * BEFORE the first suite runs, so a /reload mid-capture never repeats the
 * baseline check; because the guards return first, the marker save can never
 * overwrite an existing baselineFailures value. The budget is resolved once
 * and a deadline is computed before the suite loop: every exec receives the
 * remaining time as its `timeout` so a hanging suite is SIGTERM'd instead of
 * parking the chain; a `killed` result marks the suite unknown (its partial
 * output is never triaged, so it contributes no failing paths); and a suite
 * that would start after the deadline is skipped entirely (no exec).
 * Persistence is two saveState calls: the attempt marker first, the result
 * last with the accumulated paths of the suites that ran. Best-effort: never
 * throws.
 *
 * Cancellation checkpoints (T9(c)): the orchestration-cancel flag is checked
 * before starting each remaining suite and again before the final result
 * save, so a cancelled capture returns with baselineFailures never persisted
 * (the baselineAttempted marker saved at the start stays). Tradeoff: a suite
 * already inside exec cannot be interrupted by the checkpoint — it runs to
 * its remaining-budget timeout — but it never spawns units and its result is
 * never written to state.
 *
 * Progress notifications (T2), all best-effort through `notify`:
 * - start, before the first suite: number of full suites + total budget in
 *   minutes (level `info`);
 * - a warning per suite killed by timeout and per suite skipped by budget
 *   exhaustion, naming that suite as unknown (level `warning`);
 * - completion after persisting: elapsed time, recorded failing-path count
 *   and unknown-suite count (level `info`);
 * - a heartbeat every five minutes while the capture is still running,
 *   reporting elapsed minutes (level `info`), so a long suite can be noticed
 *   and the session /reloaded (T3). The heartbeat timer is unref'd so it can
 *   never hold the process open, and it is cleared in a `finally` block so it
 *   never outlives the capture — on completion, skip, and exception alike.
 *
 * @param pi     - ExtensionAPI used for exec and state persistence.
 * @param cwd    - Repository working directory.
 * @param state  - Workflow state; baselineAttempted and baselineFailures
 *                 are set and persisted.
 * @param notify - Optional progress notifier; omitting it keeps capture silent.
 * @returns Resolves when capture is done (or skipped).
 */
export async function captureBaselineFailures(
  pi: ExtensionAPI,
  cwd: string,
  state: WorkflowState,
  notify?: BaselineNotify,
): Promise<void> {
  let heartbeat: HeartbeatHandle | undefined;
  try {
    if (state.baselineFailures !== undefined) return;
    if (state.baselineAttempted) return;
    const suites = state.testTool?.fullSuites;
    if (!suites || suites.length === 0) return;
    // Persist the attempt marker before the first suite runs so an
    // interrupted capture is never repeated. The guards above guarantee
    // baselineFailures is unset here, so this save cannot overwrite it.
    state.baselineAttempted = true;
    try {
      saveState(pi, state);
    } catch {
      // Best-effort: a failing marker save must not abort the capture.
    }
    const budgetMs = baselineBudgetMs();
    const startedAt = Date.now();
    const deadline = startedAt + budgetMs;
    const budgetMinutes = Math.max(1, Math.round(budgetMs / 60_000));
    safeNotify(
      notify,
      `Baseline capture: running ${suites.length} full suite(s), ` +
        `total budget ${budgetMinutes} minute(s).`,
      "info",
    );
    heartbeat = setInterval(() => {
      const elapsedMinutes = Math.floor((Date.now() - startedAt) / 60_000);
      safeNotify(
        notify,
        `Baseline capture: heartbeat after ${elapsedMinutes} minute(s), ` +
          "still running — consider /reload if a suite is stuck.",
        "info",
      );
    }, HEARTBEAT_INTERVAL_MS) as HeartbeatHandle;
    heartbeat.unref?.();
    const failing = new Set<string>();
    let unknown = 0;
    for (const suite of suites) {
      // T9(c): checkpoint before starting each remaining suite — a
      // cancelled capture starts no further suite and never reaches the
      // final save below (the marker save above stays).
      if (isOrchestrationCancelled()) return;
      const remainingMs = deadline - Date.now();
      if (remainingMs <= 0) {
        // Budget exhausted: skip without exec, suite stays unknown.
        unknown++;
        safeNotify(
          notify,
          `Baseline capture: suite "${suite.label}" skipped (budget exhausted) ` +
            "and counts as unknown.",
          "warning",
        );
        continue;
      }
      const [cmd = "", ...rest] = suite.argv;
      const suiteCwd = suite.cwd ? join(cwd, suite.cwd) : cwd;
      try {
        const r = await pi.exec(cmd, rest, { cwd: suiteCwd, timeout: remainingMs });
        if (r.killed) {
          // Killed by the budget: unknown, no paths.
          unknown++;
          safeNotify(
            notify,
            `Baseline capture: suite "${suite.label}" killed by timeout ` +
              "and counts as unknown.",
            "warning",
          );
          continue;
        }
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
    // T9(c): checkpoint before the final save — a cancelled capture must
    // not persist baselineFailures; the baselineAttempted marker stays.
    if (isOrchestrationCancelled()) return;
    state.baselineFailures = [...failing].sort();
    saveState(pi, state);
    const elapsedSeconds = Math.round((Date.now() - startedAt) / 1000);
    safeNotify(
      notify,
      `Baseline capture complete in ${elapsedSeconds}s: ` +
        `${state.baselineFailures.length} failing path(s) recorded, ` +
        `${unknown} suite(s) unknown.`,
      "info",
    );
  } catch {
    // Best-effort: never throw.
  } finally {
    if (heartbeat !== undefined) clearInterval(heartbeat);
  }
}
