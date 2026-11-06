// Runs the per-task SCOPE GATE and the FULL GATE via the orchestrator's own
// exec (never a unit's tool call). Report text lives in test-gate-report.ts.

import { join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { TestSuite } from "./test-tool-detect.ts";
import { saveState } from "./state.ts";
import { routeSuites } from "./suite-scope.ts";
import { SKIPPED_TAIL } from "./test-gate-report.ts";
import type { ContractV2, GateResult, GateSuiteResult, WorkflowState } from "./state.ts";
import { deriveUnitScope } from "./contract-derive.ts";
import { DEFAULT_SUITE_TIMEOUT_MS, OUTPUT_TAIL_CHARS } from "./test-extension-constants.ts";
import { isFilterableSuite } from "./test-extension-template.ts";

/** Result of one orchestrator-run gate: per-suite verdicts plus overall pass. */
export interface TestGateRun {
  /** True when every executed suite exited 0 without being killed. */
  passed: boolean;
  /** Per-suite verdicts with capped output tails. */
  suites: GateSuiteResult[];
}

/**
 * Resolve the per-suite wall-clock budget for gate runs.
 *
 * @param env - Environment map (defaults to process.env); injectable for tests.
 * @returns The timeout in ms (> 0).
 */
export function gateTimeoutMs(
  env: Record<string, string | undefined> = process.env,
): number {
  const raw = Number(env.PI_TEST_TIMEOUT_MS);
  return Number.isFinite(raw) && raw > 0 ? raw : DEFAULT_SUITE_TIMEOUT_MS;
}

/**
 * Cap combined suite output to the gate tail budget.
 *
 * @param text - Raw combined stdout+stderr of one suite.
 * @returns The capped tail (marked with an ellipsis when truncated).
 */
function gateTail(text: string): string {
  return text.length > OUTPUT_TAIL_CHARS ? `\u2026${text.slice(-OUTPUT_TAIL_CHARS)}` : text;
}

/**
 * The argv one suite runs with inside a gate run (T8).
 *
 * Filterable (Go) suites get the scope packages mapped to `./<path>/...`
 * (`./...` when no scope is given); non-filterable suites always run their
 * plain argv unfiltered — a gate never passes a filter to them.
 *
 * @param suite - The detected suite (label + argv).
 * @param scope - Optional repo-relative package dirs (the scope gate).
 * @returns The argv the suite runs with.
 */
export function gateSuiteArgv(suite: TestSuite, scope?: readonly string[]): string[] {
  if (!isFilterableSuite(suite)) return suite.argv;
  const extra = suite.argv.slice(2).filter((arg) => arg !== "./...");
  const patterns =
    scope && scope.length > 0
      ? [...scope].map((p) => (p === "." ? "./..." : `./${p}/...`))
      : ["./..."];
  return ["go", "test"].concat(patterns).concat(extra);
}

/**
 * Run an orchestrator test gate over the given suites (T8).
 *
 * Runs every suite sequentially via pi.exec (argv arrays, never shell strings)
 * with the PI_TEST_TIMEOUT_MS budget — orchestrator-run, outside any unit's
 * tool call. With a `scope`, every filterable suite runs with the scoped
 * package patterns while every non-filterable suite runs unfiltered (the
 * per-task SCOPE GATE after each task commit); without a scope every suite
 * runs unfiltered (the FULL GATE before complete_implementation).
 *
 * @param pi     - ExtensionAPI used for exec.
 * @param cwd    - Repository working directory.
 * @param suites - state.testTool.suites to run.
 * @param scope  - Optional derived packages scope (scope gate); omitted = full gate.
 * @returns The per-suite verdicts and the overall pass flag.
 */
export async function runTestGate(
  pi: ExtensionAPI,
  cwd: string,
  suites: readonly TestSuite[],
  scope?: readonly string[],
): Promise<TestGateRun> {
  const timeout = gateTimeoutMs();
  const results: GateSuiteResult[] = [];
  for (const suite of suites) {
    results.push(await execGateSuite(pi, cwd, suite, gateSuiteArgv(suite, scope), timeout));
  }
  return { passed: results.every((r) => r.passed), suites: results };
}

/**
 * Execute one suite inside a gate run and capture its verdict.
 *
 * @param pi     - ExtensionAPI used for exec.
 * @param cwd    - Working directory for this suite's exec call.
 * @param suite  - The detected suite (supplies the label).
 * @param argv   - The argv this suite runs with.
 * @param timeout - Per-suite wall-clock budget in ms.
 * @returns The suite verdict with a capped output tail.
 */
async function execGateSuite(
  pi: ExtensionAPI,
  cwd: string,
  suite: TestSuite,
  argv: string[],
  timeout: number,
): Promise<GateSuiteResult> {
  const [cmd = "", ...rest] = argv;
  try {
    const r = await pi.exec(cmd, rest, { cwd, timeout });
    const passed = r.code === 0 && !r.killed;
    return {
      label: suite.label,
      passed,
      tail: gateTail([r.stdout ?? "", r.stderr ?? ""].filter(Boolean).join("\n")) || "(no output)",
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
 * Run the per-task SCOPE GATE for one committed task (T8).
 *
 * Routes the task's owned test paths (`deriveUnitScope().testFiles`) over
 * `state.testTool.suites` via `routeSuites`: each scoped suite runs the
 * routed argv in its own cwd (repo root when none is declared), scoped
 * suites that received no paths are not executed and are recorded with
 * the skip marker, and full-scope suites run unfiltered at every scope
 * gate. `GateResult.scope` records the routed test paths. Sessions without
 * suites and tasks owning no (non-D) test paths get no gate (manual-ness
 * is derived, not declared). The orchestrator's own exec, never the unit's
 * tool call.
 *
 * @param pi         - ExtensionAPI used for exec.
 * @param cwd        - Repository working directory.
 * @param contract   - The v2 contract the task scope derives from.
 * @param suites     - state.testTool.suites.
 * @param behaviorId - The committed task's id.
 * @returns The recorded gate result, or null when no gate applies.
 */
export async function runTaskScopeGate(
  pi: ExtensionAPI,
  cwd: string,
  contract: ContractV2,
  suites: readonly TestSuite[],
  behaviorId: string,
): Promise<GateResult | null> {
  if (suites.length === 0) return null;
  const scope = deriveUnitScope(contract, behaviorId);
  if (scope.testFiles.length === 0) return null;
  const runs = routeSuites([...suites], scope.testFiles.map((path) => ({ path })));
  const timeout = gateTimeoutMs();
  const results: GateSuiteResult[] = [];
  for (const run of runs) {
    if (run.skipped) {
      results.push({ label: run.suite.label, passed: true, tail: SKIPPED_TAIL });
      continue;
    }
    const suiteCwd = run.suite.cwd ? join(cwd, run.suite.cwd) : cwd;
    results.push(await execGateSuite(pi, suiteCwd, run.suite, run.argv, timeout));
  }
  return {
    behaviorId,
    scope: [...scope.testFiles],
    passed: results.every((r) => r.passed),
    suites: results,
    at: new Date().toISOString(),
  };
}

/**
 * Run and record the per-task scope gate after one landed commit (T8).
 *
 * Orchestrator-run, outside the unit's tool call: delegates to
 * {@link runTaskScopeGate} when the session carries a v2 contract, then
 * records the verdict on `state.gateResults` and persists it — the red
 * result is persisted while the behavior is still active, so a red gate
 * keeps the task open and the behavior loop steers fix-forward. Returns
 * null when no gate applies (v1 session, no suites, task with no tests
 * refs).
 *
 * @param pi         - ExtensionAPI used for exec and state persistence.
 * @param cwd        - Repository working directory.
 * @param state      - Current workflow state (mutated: gateResults).
 * @param behaviorId - The committed task's id.
 * @returns The recorded gate result, or null when no gate applies.
 */
export async function commitScopeGate(
  pi: ExtensionAPI,
  cwd: string,
  state: WorkflowState,
  behaviorId: string,
): Promise<GateResult | null> {
  if (!state.contractV2) return null;
  const result = await runTaskScopeGate(
    pi,
    cwd,
    state.contractV2,
    state.testTool?.suites ?? [],
    behaviorId,
  );
  if (result) {
    state.gateResults = { ...state.gateResults, [behaviorId]: result };
    saveState(pi, state);
  }
  return result;
}
