// The unbounded final gate (T6): runs the full suite list sequentially with
// no exec timeout, forwarding the caller's AbortSignal. Per-task scope gates
// stay in test-gate-run.ts; refusal text lives in implement-tools.ts.

import { join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { TestSuite } from "./test-tool-detect.ts";
import type {
  FinalGateResult,
  GateSuiteResult,
  TestToolInfo,
  WorkflowState,
} from "./state-types.ts";
import { saveState } from "./state.ts";
import { unfilteredArgv } from "./suite-scope.ts";
import { gateTail } from "./test-gate-run.ts";

/** Per-suite verdicts of one final-gate run (timestamp added on persist). */
export interface FinalGateRun {
  /** True when every executed suite exited 0 without being killed. */
  passed: boolean;
  /** Per-suite verdicts with capped output tails. */
  suites: GateSuiteResult[];
}

/**
 * Resolve the suites the final gate runs.
 *
 * Prefers the recorded full-suite list (state.testTool.fullSuites); when no
 * full list is recorded, falls back to the scoped suites with their argv
 * mapped to unfiltered form ({tests} dropped, {pkgs} mapped to ./...).
 *
 * @param testTool - The recorded test-tool wiring, if any.
 * @returns The suites to run, in order (empty when none are recorded).
 */
export function resolveFinalGateSuites(testTool: TestToolInfo | undefined): TestSuite[] {
  const full = testTool?.fullSuites;
  if (full && full.length > 0) return full.map((s) => ({ ...s }));
  return (testTool?.suites ?? []).map((s) => ({ ...s, argv: unfilteredArgv(s) }));
}

/**
 * Execute one suite inside the final gate and capture its verdict.
 *
 * @param pi     - ExtensionAPI used for exec.
 * @param cwd    - Repository working directory.
 * @param suite  - The suite to run (argv plus optional cwd).
 * @param signal - Optional AbortSignal forwarded to exec.
 * @returns The suite verdict with a capped output tail.
 */
async function execFinalSuite(
  pi: ExtensionAPI,
  cwd: string,
  suite: TestSuite,
  signal?: AbortSignal,
): Promise<GateSuiteResult> {
  const [cmd = "", ...rest] = suite.argv;
  const suiteCwd = suite.cwd ? join(cwd, suite.cwd) : cwd;
  // Unbounded by contract: no timeout key — only the caller's signal.
  const opts: { cwd: string; signal?: AbortSignal } = { cwd: suiteCwd };
  if (signal) opts.signal = signal;
  try {
    const r = await pi.exec(cmd, rest, opts);
    const passed = r.code === 0 && !r.killed && !signal?.aborted;
    return {
      label: suite.label,
      passed,
      tail: gateTail([r.stdout ?? "", r.stderr ?? ""].filter(Boolean).join("\n")) || "(no output)",
      // T7: capture the repo-relative suite cwd so triage can map reported
      // test paths into repo-relative paths (absent when the suite ran at root).
      ...(suite.cwd && suite.cwd !== "." ? { cwd: suite.cwd } : {}),
    };
  } catch (err) {
    return {
      label: suite.label,
      passed: false,
      tail: `spawn failed: ${String((err as Error)?.message ?? err)}`,
    };
  }
}

/**
 * Run the unbounded final gate (T6).
 *
 * Every resolved suite runs sequentially via pi.exec in its own cwd (repo
 * root when none is declared) with NO timeout — unbounded by contract — and
 * the supplied AbortSignal forwarded to each exec call. A killed or aborted
 * run counts as not passed.
 *
 * @param pi       - ExtensionAPI used for exec.
 * @param cwd      - Repository working directory.
 * @param testTool - The recorded test-tool wiring (fullSuites or suites).
 * @param signal   - Optional AbortSignal forwarded to every exec call.
 * @returns The per-suite verdicts and the overall pass flag.
 */
export async function runFinalGate(
  pi: ExtensionAPI,
  cwd: string,
  testTool: TestToolInfo | undefined,
  signal?: AbortSignal,
): Promise<FinalGateRun> {
  const results: GateSuiteResult[] = [];
  for (const suite of resolveFinalGateSuites(testTool)) {
    results.push(await execFinalSuite(pi, cwd, suite, signal));
  }
  return { passed: results.every((r) => r.passed), suites: results };
}

/**
 * Run the final gate and persist the result on state (T6).
 *
 * Delegates to {@link runFinalGate}, stamps the run with an ISO timestamp
 * and stores it on `state.finalGate` before persisting — a red result is
 * recorded on the session even though completion is refused.
 *
 * @param pi     - ExtensionAPI used for exec and state persistence.
 * @param cwd    - Repository working directory.
 * @param state  - Current workflow state (mutated: finalGate).
 * @param signal - Optional AbortSignal forwarded to every exec call.
 * @returns The recorded final-gate result.
 */
export async function runAndPersistFinalGate(
  pi: ExtensionAPI,
  cwd: string,
  state: WorkflowState,
  signal?: AbortSignal,
): Promise<FinalGateResult> {
  const run = await runFinalGate(pi, cwd, state.testTool, signal);
  const result: FinalGateResult = { ...run, at: new Date().toISOString() };
  state.finalGate = result;
  saveState(pi, state);
  return result;
}
