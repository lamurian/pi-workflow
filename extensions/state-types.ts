// Type-only: the persisted WorkflowState shape and its field types.

import type { WorkflowPhase } from "./state.ts";
import type { AttemptRecord } from "./halt-report.ts";
import type { Finding } from "./findings-ledger.ts";
import type { TestSuite, TestSuiteSource } from "./test-tool-detect.ts";
import type { ContractV2, TaskContract } from "./contract-types.ts";

/** A sandbox-blocked command the user must run before a unit can proceed. */
export interface PendingCommand {
  /** The exact command to run outside the sandbox. */
  command: string;
  /** Why the unit needs it (optional). */
  reason?: string;
}

/** Persisted handoff for a halted or crashed orchestration attempt. */
export interface LastHalt {
  /** The behavior that failed. */
  behaviorId: string;
  /** Failure detail (unit error, hook investigation, timeout note). */
  error: string;
  /** `git status --short` snapshot at halt time. */
  treeState?: string;
  /** Commit subjects landed before the halt. */
  landedCommits?: string[];
  /**
   * Per-attempt history of the halted behavior (T8): attempt number,
   * outcome kind, duration, progress and last text. Optional: absent on
   * sessions persisted before this field existed.
   */
  attempts?: AttemptRecord[];
  /** One-line diagnosis of why the behavior halted (T8). */
  diagnosis?: string;
  /** One-line recommended next action for the user (T8). */
  recommendation?: string;
  /** Sandbox-blocked command the user must run before resuming. */
  pendingCommand?: PendingCommand;
  /** ISO timestamp of the halt. */
  at: string;
}

/** A manual behavior deferred for post-run human confirmation (T5). */
export interface PendingManualCheck {
  /** Behavior id, e.g. "T2". */
  behaviorId: string;
  /** The behavior's contract description. */
  description: string;
}

/** Serializable workflow state persisted via pi.appendEntry(). */
export interface WorkflowState {
  /** Current workflow phase. */
  phase: WorkflowPhase;
  /** The topic under discussion. */
  specText: string;
  /** The task contract (present from finalizing onward). */
  task?: TaskContract;
  /** Results from the latest test run, if any. */
  lastTestResults?: TestResults;
  /**
   * Details of the most recent orchestration halt or crash. Persisted to the
   * session log so failures are diagnosable after the fact.
   */
  lastHalt?: LastHalt;
  /**
   * Manual behaviors whose verification pause timed out: committed through
   * the gate but requiring human confirmation in the app after the run.
   * Optional: absent on sessions persisted before this field existed.
   */
  pendingManualChecks?: PendingManualCheck[];
  /**
   * HEAD hash recorded when /implement started. Optional: absent on
   * sessions persisted before this field existed, and when git is
   * unavailable (not a repo).
   */
  baselineHead?: string;
  /**
   * HEAD hash after the most recent mark_task_done. Compared against the
   * current HEAD to soft-warn when no commit landed between behaviors.
   */
  lastMarkedHead?: string;
  /**
   * Engineer's note passed to /implement. Persisted so it survives a
   * halt/resume: a re-run without args reuses it, a new note replaces it,
   * and the orchestrated loop clears it on completion (phase -> idle).
   */
  engineerNote?: string;
  /**
   * Shared findings ledger: reusable facts reported by unit attempts,
   * across ALL behaviors of the task. Appended by the orchestrator loop
   * (exact-text dedup, capped at the 40 most recent), rendered into every
   * unit task text, cleared on completion (phase -> idle), and kept
   * across halts, resumes and re-finalize. Optional: absent on sessions
   * persisted before this field existed.
   */
  findings?: Finding[];
  /**
   * Test-tool wiring recorded by save_task's ensure step: the effective
   * source (config | existing | detected | none) and the suites the generated
   * `test` tool runs. Rendered into every unit task text as the Verification
   * line. Optional: absent when no test tool was configured/detected, and on
   * sessions persisted before this field existed.
   */
  testTool?: TestToolInfo;
  /**
   * Normalized v2 contract migrated from `task` by the resume path (T2):
   * `loadState` attaches it whenever a persisted v1 contract normalizes
   * cleanly to a valid ContractV2. Optional: absent when the session has no
   * contract and when migration fails v2 validation (the session then keeps
   * resuming on the still-supported v1 path).
   */
  contractV2?: ContractV2;
  /**
   * Orchestrator-run test-gate results per task (T8), keyed by task id:
   * written by the per-task scope gate after each landed commit (scope,
   * pass/fail, per-suite tails) and read by mark_task_done so gate-backed
   * evidence replaces the unit's self-report. Optional: absent when no gate
   * has run and on sessions persisted before this field existed.
   */
  gateResults?: Record<string, GateResult>;
  /**
   * Result of the unbounded final gate run by complete_implementation (T6):
   * written on every final-gate run (red or green) so the verdict, the
   * per-suite tails and the timestamp survive in the session log. Optional:
   * absent until the final gate has run.
   */
  finalGate?: FinalGateResult;
  /**
   * Consecutive red final-gate attempts in solo mode (T6): incremented on
   * each red complete_implementation refusal, reset on a green gate. The
   * second consecutive red refuses with an instruction to stop and report
   * to the user. Optional: absent until the first red refusal.
   */
  finalGateAttempts?: number;
}

/** One orchestrator test-gate suite verdict (T8). */
export interface GateSuiteResult {
  /** Suite label, e.g. "javascript (npm run test)". */
  label: string;
  /** True when the suite exited 0 without being killed. */
  passed: boolean;
  /** Capped output tail carried into gate reports and evidence lines. */
  tail: string;
  /**
   * Repo-relative working directory the suite ran in (T7), captured by the
   * final gate so triage can map reported test paths to repo-relative paths.
   * Optional: absent for suites run at the repo root and on scope-gate verdicts.
   */
  cwd?: string;
}

/** One orchestrator test-gate result recorded per task (T8). */
export interface GateResult {
  /** The task the gate ran for. */
  behaviorId: string;
  /** The derived packages scope the filterable suites ran with. */
  scope: string[];
  /** True when every executed suite passed. */
  passed: boolean;
  /** Per-suite verdicts with output tails. */
  suites: GateSuiteResult[];
  /** ISO timestamp of the gate run. */
  at: string;
}

/** The unbounded final-gate result persisted on WorkflowState (T6). */
export interface FinalGateResult {
  /** True when every executed suite exited 0 without being killed. */
  passed: boolean;
  /** Per-suite verdicts with capped output tails. */
  suites: GateSuiteResult[];
  /** ISO timestamp of the final-gate run. */
  at: string;
}

/** Test-tool wiring recorded by save_task's ensure step (T3). */
export interface TestToolInfo {
  /** Where the suites came from: config | existing | detected | none. */
  source: TestSuiteSource;
  /** Suites the test tool runs (empty for none / external-tool sources). */
  suites: TestSuite[];
  /** Suites the full gate runs (absent on older sessions). */
  fullSuites?: TestSuite[];
}

/** Test run results. */
export interface TestResults {
  passed: number;
  failed: number;
  coveragePercent?: number;
}
