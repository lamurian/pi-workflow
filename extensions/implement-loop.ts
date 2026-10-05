import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import {
  saveState,
  updateUi,
  type WorkflowState,
  type TaskContract,
  type Behavior,
} from "./state.ts";
import { parseTestOutput, evaluateCompletionGate } from "./task-contract.ts";
import {
  runImplementerUnit,
  type UnitTask,
} from "./implementer-runner.ts";
import type { ImplementerReport } from "./subagent-runner.ts";

// ─── Types ─────────────────────────────────────────────────────────────────────

/** Injectable unit runner: execute one behavior, return its report. */
export type UnitRunner = (
  unit: UnitTask,
  cwd: string,
  signal?: AbortSignal,
) => Promise<ImplementerReport & { error?: string }>;

/** Result of the orchestrator loop. */
export interface OrchestratorResult {
  /** True when every unit completed and the workflow returned to idle. */
  complete: boolean;
  /** Number of units that ran (including retries). */
  unitsRun: number;
  /** Commit subjects landed so far, in order. */
  landedCommits: string[];
  /** Populated when the loop halted early. */
  haltedOn?: string;
  /** Failure detail when the loop halted. */
  error?: string;
  /** `git status --short` snapshot captured at halt time. */
  treeState?: string;
}

// ─── Helpers ───────────────────────────────────────────────────────────────────

/**
 * Detect the project's test command by checking for common config files.
 *
 * @param cwd - Project working directory.
 * @returns [command, args[]] tuple, or ["npm", ["test"]] as fallback.
 */
export function detectTestCommand(cwd: string): [string, string[]] {
  if (existsSync(resolve(cwd, "vitest.config.ts"))) return ["npx", ["vitest", "run"]];
  if (existsSync(resolve(cwd, "jest.config.ts"))) return ["npx", ["jest"]];
  if (existsSync(resolve(cwd, "jest.config.js"))) return ["npx", ["jest"]];
  if (existsSync(resolve(cwd, ".mocharc.yml"))) return ["npx", ["mocha"]];
  return ["npm", ["test"]];
}

/**
 * Read the current git HEAD hash for a working directory.
 *
 * Best-effort: returns null when git fails so callers can skip HEAD checks.
 *
 * @param pi  - ExtensionAPI reference (for exec access).
 * @param cwd - Working directory to resolve HEAD in.
 * @returns The HEAD hash, or null when unavailable.
 */
export async function readGitHead(
  pi: ExtensionAPI,
  cwd: string,
): Promise<string | null> {
  try {
    const result = await pi.exec("git", ["rev-parse", "HEAD"], { cwd });
    if ((result.exitCode ?? 1) !== 0) return null;
    const head = (result.stdout ?? "").trim();
    return head || null;
  } catch {
    return null;
  }
}

/**
 * Pick the conventional commit subject for a unit.
 *
 * Prefers the subagent's suggestion; falls back to a generic subject so a
 * missing suggestion never blocks the commit step.
 *
 * @param report   - The unit's parsed report.
 * @param behavior - The behavior the unit implemented.
 * @returns A conventional commit subject line (no behavior id).
 */
export function pickCommitSubject(
  report: ImplementerReport,
  behavior: Behavior,
): string {
  const suggested = report.suggestedCommit?.trim();
  if (suggested) return suggested;
  return `feat: implement ${behavior.description}`.slice(0, 75);
}

// ─── Orchestrator loop ─────────────────────────────────────────────────────────

/**
 * Run the orchestrator loop over a task contract.
 *
 * For each active behavior, in order: run the unit (subprocess), verify via
 * the test command, commit with the subagent-suggested subject, mark done.
 * On unit failure, retry once with the failure output appended; a second
 * failure halts the loop and reports the tree state plus commits landed.
 * Already-done behaviors are skipped, so re-running resumes cleanly.
 *
 * @param pi      - ExtensionAPI reference.
 * @param ctx     - Extension context (cwd, UI).
 * @param state   - Current workflow state (mutated in place).
 * @param task    - The task contract.
 * @param runUnit - Injectable unit runner (defaults to the real subprocess).
 * @returns Loop outcome including landed commits and halt details.
 */
export async function runOrchestratedImplement(
  pi: ExtensionAPI,
  ctx: ExtensionContext,
  state: WorkflowState,
  task: TaskContract,
  runUnit: UnitRunner = (unit, cwd, signal) =>
    runImplementerUnit(loadUnitPrompt(), unit.taskText, cwd, signal),
): Promise<OrchestratorResult> {
  const cwd = ctx.cwd;
  const landedCommits: string[] = [];
  const units = task.behaviors.filter((b) => b.status === "active");
  const result: OrchestratorResult = { complete: false, unitsRun: 0, landedCommits };

  // T4 contract: the handoff report names the unit id, the error, the tree
  // state, and the commits landed so far. Populate the report pieces here so
  // the halt path stays uniform across unit / verify / commit failures.
  const halt = (behaviorId: string, error: string) => {
    result.haltedOn = behaviorId;
    result.error = error;
    return readTreeState(pi, cwd).then((treeState) => {
      result.treeState = treeState;
      return result;
    });
  };

  if (units.length === 0) {
    result.complete = evaluateCompletionGate(state) === null;
    if (result.complete) {
      state.phase = "idle";
      saveState(pi, state);
      updateUi(null, ctx);
    }
    return result;
  }

  for (const behavior of units) {
    const unit: UnitTask = { behaviorId: behavior.id, taskText: buildUnitTask(behavior, task) };
    const first = await runUnit(unit, cwd);
    result.unitsRun++;
    let outcome = first;

    if (outcome.error) {
      const retryUnit: UnitTask = {
        behaviorId: behavior.id,
        taskText: buildRetryTask(behavior, task, outcome),
      };
      outcome = await runUnit(retryUnit, cwd);
      result.unitsRun++;
    }

    if (outcome.error) {
      return halt(behavior.id, outcome.error);
    }

    const verify = await verifyTests(pi, cwd);
    state.lastTestResults = verify.parsed;
    saveState(pi, state);
    updateUi(state, ctx);
    if (!verify.ok) {
      return halt(behavior.id, `Tests failed after unit ${behavior.id}: ${verify.detail}`);
    }

    const subject = pickCommitSubject(outcome, behavior);
    const commit = await commitAll(pi, cwd, subject);
    if (!commit.ok) {
      return halt(behavior.id, `Commit failed for ${behavior.id}: ${commit.detail}`);
    }
    landedCommits.push(subject);

    behavior.status = "done";
    state.lastMarkedHead = (await readGitHead(pi, cwd)) ?? state.lastMarkedHead;
    saveState(pi, state);
    updateUi(state, ctx);
  }

  const refusal = evaluateCompletionGate(state);
  if (refusal) {
    return halt(
      units[units.length - 1].id,
      `Completion gate refused: ${refusal}`,
    );
  }
  state.phase = "idle";
  saveState(pi, state);
  updateUi(null, ctx);
  result.complete = true;
  return result;
}

// ─── Task text builders ────────────────────────────────────────────────────────

let _unitPrompt: string | undefined;

/**
 * Load (and cache) the implementer unit prompt from content/unit-prompt.md.
 *
 * @returns The unit prompt text.
 */
export function loadUnitPrompt(): string {
  if (_unitPrompt === undefined) {
    _unitPrompt = "";
  }
  return _unitPrompt;
}

/**
 * Set the cached unit prompt (called at /implement time).
 *
 * @param text - The prompt text from content/unit-prompt.md.
 */
export function setUnitPrompt(text: string): void {
  _unitPrompt = text;
}

/**
 * Build the task text for one behavior unit.
 *
 * @param behavior - The behavior to implement.
 * @param task     - The full task contract (for context).
 * @returns Rendered task text for the subprocess.
 */
export function buildUnitTask(behavior: Behavior, task: TaskContract): string {
  return [
    `Implement ONE behavior: ${behavior.id}.`,
    `Description: ${behavior.description}`,
    `Expected output: ${behavior.expectedOutput}`,
    `Kind: ${behavior.kind}`,
    behavior.sourceFile ? `Source file: ${behavior.sourceFile}` : "",
    "",
    "## Contract context (do not implement beyond this behavior)",
    `Title: ${task.title}`,
    `Instruction: ${task.instruction}`,
    `Files: ${task.files.join(", ")}`,
    `Definition of done: ${task.done}`,
    "",
    "End with the JSON report block (summary, suggestedCommit) as instructed.",
  ]
    .filter(Boolean)
    .join("\n");
}

/**
 * Build the retry task text with the prior failure output appended.
 *
 * @param behavior - The behavior being retried.
 * @param task     - The full task contract.
 * @param prior    - The failed outcome from the first attempt.
 * @returns Rendered retry task text.
 */
export function buildRetryTask(
  behavior: Behavior,
  task: TaskContract,
  prior: ImplementerReport & { error?: string },
): string {
  const failure = prior.error ?? prior.summary ?? "unknown failure";
  return (
    buildUnitTask(behavior, task) +
    `\n\n## Previous attempt failed\n${failure}\n\nFix the reported issues and re-verify.`
  );
}

// ─── Verification, commit, tree state ──────────────────────────────────────────

/** Outcome of a test verification run. */
export interface VerifyResult {
  /** True when the test command exited 0. */
  ok: boolean;
  /** Parsed pass/fail counts. */
  parsed: { passed: number; failed: number; coveragePercent?: number };
  /** Human-readable detail (exit code / failure excerpt). */
  detail: string;
}

/**
 * Run the project's test command and parse the result.
 *
 * @param pi  - ExtensionAPI reference.
 * @param cwd - Project working directory.
 * @returns Verification outcome.
 */
export async function verifyTests(
  pi: ExtensionAPI,
  cwd: string,
): Promise<VerifyResult> {
  const [cmd, cmdArgs] = detectTestCommand(cwd);
  let exitCode = 1;
  let stdout = "";
  try {
    const res = await pi.exec(cmd, cmdArgs, { cwd, timeout: 120_000 });
    exitCode = res.exitCode ?? 0;
    stdout = res.stdout ?? "";
  } catch (err) {
    stdout = String((err as Error).message ?? err);
  }
  const parsed = parseTestOutput(exitCode, stdout);
  return {
    ok: exitCode === 0,
    parsed,
    detail:
      exitCode === 0
        ? `exit 0 passed=${parsed.passed}`
        : `exit ${exitCode} ${stdout.slice(-400)}`,
  };
}

/** Outcome of a commit attempt. */
export interface CommitResult {
  /** True when the commit landed. */
  ok: boolean;
  /** Human-readable detail on failure. */
  detail: string;
}

/**
 * Stage all changes and commit with the given subject.
 *
 * @param pi      - ExtensionAPI reference.
 * @param cwd     - Project working directory.
 * @param subject - Conventional commit subject line.
 * @returns Commit outcome.
 */
export async function commitAll(
  pi: ExtensionAPI,
  cwd: string,
  subject: string,
): Promise<CommitResult> {
  try {
    await pi.exec("git", ["add", "--all"], { cwd });
    const res = await pi.exec("git", ["commit", "-m", subject], { cwd, timeout: 60_000 });
    if ((res.exitCode ?? 1) !== 0) {
      return { ok: false, detail: (res.stdout ?? res.stderr ?? "commit failed").slice(-400) };
    }
    return { ok: true, detail: subject };
  } catch (err) {
    return { ok: false, detail: String((err as Error).message ?? err) };
  }
}

/**
 * Read a short git tree-state summary for halt reports.
 *
 * @param pi  - ExtensionAPI reference.
 * @param cwd - Project working directory.
 * @returns `git status --short` output, or "(unavailable)".
 */
export async function readTreeState(
  pi: ExtensionAPI,
  cwd: string,
): Promise<string> {
  try {
    const res = await pi.exec("git", ["status", "--short"], { cwd });
    return (res.stdout ?? "").trim() || "(clean)";
  } catch {
    return "(unavailable)";
  }
}
