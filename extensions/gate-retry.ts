// Scope-gate retry and ownership routing: re-run a red suite once and
// classify the outcome as flaky, foreign or owned.

import type { GateSuiteResult } from "./state-types.ts";
import { extractFailingPaths } from "./full-gate-triage.ts";

/** Outcome of retrying one red scope-gate suite. */
export interface RetryOutcome {
  /** flaky = green on re-run; foreign = red twice outside owned tests; owned = otherwise. */
  kind: "flaky" | "foreign" | "owned";
  /** The verdict to record (passed=true for flaky/foreign). */
  result: GateSuiteResult;
  /** Note to record on the gate result, when any. */
  note?: string;
}

/**
 * Re-run a red suite once and classify the outcome.
 *
 * @param first     - The first (red) suite verdict.
 * @param rerun     - Re-executes the suite and returns the new verdict.
 * @param ownedTests - Repo-relative test paths the task owns.
 * @returns The classified outcome.
 */
export async function retryRedSuite(
  first: GateSuiteResult,
  rerun: () => Promise<GateSuiteResult>,
  ownedTests: readonly string[],
): Promise<RetryOutcome> {
  const firstPaths = extractFailingPaths(first);
  const second = await rerun();
  if (second.passed) {
    const names = firstPaths.length > 0 ? firstPaths.join(", ") : "(unparsed)";
    return {
      kind: "flaky",
      result: second,
      note: `flaky: ${first.label} failed then passed on re-run: ${names}`,
    };
  }
  const paths = extractFailingPaths(second);
  const owned = new Set(ownedTests);
  if (paths.length > 0 && paths.every((p) => !owned.has(p))) {
    return {
      kind: "foreign",
      result: { ...second, passed: true },
      note: `foreign: ${first.label} failures outside task tests deferred to final gate: ${paths.join(", ")}`,
    };
  }
  return { kind: "owned", result: second };
}
