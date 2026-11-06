// T7 FULL-GATE fix round: the orchestrator's final-gate phase (finishRun: run
// the gate → triage red output → exactly one fix unit → re-run), plus the fix
// unit's task text, blocked-path halt rendering and the ownsAll marker.

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
  saveState,
  updateUi,
  type Behavior,
  type PendingCommand,
  type TaskContract,
  type WorkflowState,
} from "./state.ts";
import type { UnitRunner, OrchestratorResult } from "./implement-loop.ts";
import type { FinalGateResult, GateSuiteResult } from "./state-types.ts";
import type { FailingTestEntry, FullGateTriage } from "./full-gate-triage.ts";
import { formatFailingTest, renderFullGateHalt, triageFullGate } from "./full-gate-triage.ts";
import { renderGateReport } from "./test-gate-report.ts";
import { runAndPersistFinalGate } from "./full-gate.ts";
import { deriveAllowlist } from "./contract-derive.ts";
import { commitAndGate, pickCommitSubject } from "./git-commit-gate.ts";
import { readGitHead } from "./git-ops.ts";
import { cleanupOrchestration } from "./hitl-pause.ts";
import { shutdownWarmChild } from "./warm-unit.ts";

/** Behavior id of the single FULL-GATE fix unit (well-known marker). */
export const FULL_GATE_UNIT_ID = "FULL-GATE";

/** Shared driver state handed to finishRun for the final-gate phase (T7). */
export interface FinalGateDeps {
  /** ExtensionAPI (final-gate exec, state persistence, git plumbing). */
  pi: ExtensionAPI;
  /** Extension context (cwd, UI). */
  ctx: ExtensionContext;
  /** Current workflow state (mutated: finalGate, phase on completion). */
  state: WorkflowState;
  /** The task contract (declared files, the fix unit's commit). */
  task: TaskContract;
  /** Injectable unit runner used for the single FULL-GATE fix unit. */
  runUnit: UnitRunner;
  /** The shared halt closure (persists lastHalt, fills the result). */
  halt: (behaviorId: string, error: string, pendingCommand?: PendingCommand) => Promise<OrchestratorResult>;
  /** Commits landed so far (carried into the fix task text and commit). */
  landedCommits: string[];
  /** The shared result object this phase fills. */
  result: OrchestratorResult;
}

/** Findings prefix a fix unit uses to report a guard-blocked undeclared path. */
export const BLOCKED_PATH_PREFIX = "BLOCKED PATH: ";

/**
 * Build the fix unit's task text for the one allowed fix round (T7).
 *
 * Carries the red full-gate report (suite tails), the landed commit subjects
 * and the failing tests mapped to their owning tasks, plus the instruction
 * to report guard-blocked undeclared paths with BLOCKED_PATH_PREFIX.
 *
 * @param gate          - The red final-gate result.
 * @param triage        - Triage marking every failing test declared/undeclared.
 * @param landedCommits - Commit subjects landed before the fix round.
 * @returns The FULL-GATE unit task text.
 */
export function buildFullGateFixTask(
  gate: FinalGateResult,
  triage: FullGateTriage,
  landedCommits: readonly string[],
): string {
  const asGate = {
    behaviorId: FULL_GATE_UNIT_ID,
    scope: [] as string[],
    passed: gate.passed,
    suites: gate.suites as GateSuiteResult[],
    at: gate.at,
  };
  const lines = [
    "Implement ONE behavior: FULL-GATE.",
    "",
    "You are the orchestrator's single fix round for a red final gate. Fix the",
    "failing tests listed below with real code changes. Do NOT delete, skip or",
    "weaken a test to turn the gate green.",
    "",
    "## Failing tests (with owning tasks)",
    ...triage.failing.map((f: FailingTestEntry) => `- ${formatFailingTest(f)}`),
    "",
    "## Landed commits",
    ...(landedCommits.length > 0 ? landedCommits.map((c) => `- ${c}`) : ["- (none)"]),
    "",
    renderGateReport(asGate, "full gate"),
    "",
    "## Declared-path rule",
    "You may write/edit only paths declared in the contract's allowlist. If a",
    `tool call is blocked because the path is undeclared, do not work around it:`,
    `report it in your JSON report findings as exactly \`${BLOCKED_PATH_PREFIX}<repo-relative-path>\``,
    "so the orchestrator can halt with a /discuss -> /finalize -> /implement steer.",
    "",
    "Return the mandatory JSON report block when done.",
  ];
  return lines.join("\n");
}

/**
 * Extract guard-blocked undeclared paths from a fix unit's report findings.
 *
 * @param findings - The report's findings strings (may be undefined).
 * @returns Deduplicated paths reported with BLOCKED_PATH_PREFIX, in order.
 */
export function extractBlockedPaths(findings: readonly string[] | undefined): string[] {
  const paths: string[] = [];
  for (const finding of findings ?? []) {
    const idx = finding.indexOf(BLOCKED_PATH_PREFIX);
    if (idx < 0) continue;
    const path = finding.slice(idx + BLOCKED_PATH_PREFIX.length).trim();
    if (path && !paths.includes(path)) paths.push(path);
  }
  return paths;
}

/**
 * Render the halt for a fix unit blocked on undeclared paths (T7).
 *
 * @param paths - The requested (blocked) repo-relative paths.
 * @returns Halt text listing the paths and steering /discuss -> /finalize -> /implement.
 */
export function renderBlockedPathsHalt(paths: readonly string[]): string {
  return (
    "## FULL-GATE fix round blocked on undeclared paths\n\n" +
    "The fix unit was blocked by the contract guard on paths not declared in " +
    "the contract's allowlist. No further fix round runs.\n\n" +
    "Requested paths:\n" +
    paths.map((p) => `- ${p} — undeclared`).join("\n") +
    "\n\nEvery path the fix round needs must be declared in the contract's " +
    "files with its owning task ids. Steer the user to /discuss -> /finalize " +
    "-> /implement: declare these paths there (each with an A/M/D status and " +
    "its owning tasks), then /implement resumes."
  );
}

/** The synthetic behavior the fix unit's commit is classified against (T7). */
function fixBehavior(): Behavior {
  return {
    id: FULL_GATE_UNIT_ID,
    description: "fix the failing tests reported by the red final gate",
    expectedOutput: "the final gate passes",
    kind: "test",
    status: "active",
  };
}

/**
 * Complete a green run: tear down orchestration, return the workflow to
 * idle and mark the shared result complete.
 *
 * @param deps - Shared driver state (mutated: phase, engineerNote,
 *               findings, result.complete).
 * @returns The completed orchestrator result.
 */
async function completeRun(deps: FinalGateDeps): Promise<OrchestratorResult> {
  const { pi, ctx, state, result } = deps;
  await cleanupOrchestration();
  state.phase = "idle";
  state.engineerNote = undefined;
  state.findings = undefined;
  saveState(pi, state);
  updateUi(null, ctx);
  ctx.ui.setStatus("implement", undefined);
  result.complete = true;
  return result;
}

/**
 * Run the one allowed fix round for a red-but-routable final gate (T7).
 *
 * Spawns exactly one FULL-GATE unit carrying the red gate report (suite
 * tails), the landed commit subjects and the failing tests mapped to their
 * owning tasks. A guard-blocked undeclared path or a unit failure halts
 * with its own text — no second fix round ever runs. The fix commit goes
 * through the normal commit gate (v1 stage-all path: the synthetic
 * FULL-GATE id owns no v2 refs), then the final gate re-runs once — green
 * completes the run, red halts with the full-gate report.
 *
 * @param deps   - Shared driver state, the halt closure and the unit runner.
 * @param gate   - The red final-gate result that opened the fix round.
 * @param triage - Triage marking every failing test declared with owners.
 * @returns The completed or halted orchestrator result.
 */
async function runFixRound(
  deps: FinalGateDeps,
  gate: FinalGateResult,
  triage: FullGateTriage,
): Promise<OrchestratorResult> {
  const { pi, ctx, state, task, runUnit, halt, landedCommits, result } = deps;
  const cwd = ctx.cwd;
  result.unitsRun++;
  const attempt = await runUnit(
    {
      behaviorId: FULL_GATE_UNIT_ID,
      taskText: buildFullGateFixTask(gate, triage, landedCommits),
      kind: "test",
    },
    cwd,
  );
  await shutdownWarmChild(attempt.client);
  const blocked = extractBlockedPaths(attempt.findings);
  if (blocked.length > 0) return halt(FULL_GATE_UNIT_ID, renderBlockedPathsHalt(blocked));
  if (attempt.error || attempt.missingReport) {
    return halt(
      FULL_GATE_UNIT_ID,
      `The FULL-GATE fix unit failed: ${
        attempt.error ?? "exited 0 without the mandatory JSON report block"
      }`,
    );
  }
  const behavior = fixBehavior();
  const subject = pickCommitSubject(attempt, behavior);
  const commit = await commitAndGate(pi, cwd, subject, behavior, task, 1, state.baselineHead);
  if (commit.outcome !== null) {
    return halt(
      FULL_GATE_UNIT_ID,
      `The FULL-GATE fix unit's work did not land through the commit gate ` +
        `(${commit.outcome.kind}).\n\n${commit.outcome.investigation}`,
    );
  }
  landedCommits.push(subject);
  state.lastMarkedHead = (await readGitHead(pi, cwd)) ?? state.lastMarkedHead;
  const rerun = await runAndPersistFinalGate(pi, cwd, state);
  if (!rerun.passed) {
    return halt(
      FULL_GATE_UNIT_ID,
      `Final gate stayed red after the single FULL-GATE fix round.\n\n` +
        renderGateReport(
          {
            behaviorId: FULL_GATE_UNIT_ID,
            scope: [],
            passed: rerun.passed,
            suites: rerun.suites,
            at: rerun.at,
          },
          "full gate",
        ),
    );
  }
  return completeRun(deps);
}

/**
 * Run the T7 final-gate phase after the completion gate passes: the
 * unbounded final gate, failure triage on red, and exactly one FULL-GATE
 * fix round when every failing test is declared.
 *
 * Green → the run completes (phase idle, result.complete). Red → triage;
 * any undeclared failing test or unparseable red suite halts WITHOUT a fix
 * round, listing every failing test with its declared/undeclared marking
 * and owners and steering to /discuss -> /finalize -> /implement. Otherwise
 * the single fix round runs and the gate re-runs once (see runFixRound).
 *
 * @param deps - Shared driver state, the halt closure and the unit runner.
 * @returns The completed or halted orchestrator result.
 */
export async function finishRun(deps: FinalGateDeps): Promise<OrchestratorResult> {
  const { pi, ctx, state, task, halt } = deps;
  const gate = await runAndPersistFinalGate(pi, ctx.cwd, state);
  if (gate.passed) return completeRun(deps);
  const declared = state.contractV2 ? deriveAllowlist(state.contractV2) : task.files;
  const triage = triageFullGate(gate.suites, declared);
  if (triage.failing.some((f) => !f.declared) || triage.unparseableSuites.length > 0) {
    return halt(
      FULL_GATE_UNIT_ID,
      "Final gate red with undeclared failing tests or unparseable output — " +
        "no fix round runs.\n\n" +
        renderFullGateHalt(triage),
    );
  }
  return runFixRound(deps, gate, triage);
}
