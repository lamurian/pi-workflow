import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
  saveState,
  updateUi,
  type WorkflowState,
  type TaskContract,
  type Behavior,
} from "./state.ts";
import { evaluateCompletionGate, renderTaskContract } from "./task-contract.ts";
import {
  runImplementerUnit,
  type UnitTask,
} from "./implementer-runner.ts";
import type { ImplementerReport } from "./subagent-runner.ts";
import {
  RETRY_BUDGET,
  buildFixTask,
  classifyCommit,
  classifyStagedDiff,
  type GateOutcome,
} from "./commit-gate.ts";

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

// ─── Git helpers ───────────────────────────────────────────────────────────────

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
 * Read a short git tree-state summary for handoffs and resume context.
 *
 * @param pi  - ExtensionAPI reference.
 * @param cwd - Working directory.
 * @returns `git status --short` output, "" when clean, "(unavailable)" on error.
 */
export async function readTreeState(
  pi: ExtensionAPI,
  cwd: string,
): Promise<string> {
  try {
    const res = await pi.exec("git", ["status", "--short"], { cwd });
    return (res.stdout ?? "").trim();
  } catch {
    return "(unavailable)";
  }
}

/** Outcome of a commit attempt, classified by the HEAD gate. */
interface CommitAttempt {
  outcome: Exclude<GateOutcome, { kind: "landed" }> | null;
  /** Best-effort subject when the commit landed. */
  subject?: string;
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

/**
 * Stage all changes and commit with the given subject; classify via HEAD gate.
 *
 * Never passes --no-verify: the project's pre-commit hooks are the gate.
 * Before committing, inspects the staged diff (git diff --cached) against
 * the tamper guard: undeclared test deletions, sourceFile deletions, and
 * retry-touching of undeclared tests block the commit without invoking it.
 *
 * @param pi       - ExtensionAPI reference.
 * @param cwd      - Working directory.
 * @param subject  - Conventional commit subject line.
 * @param behavior - The behavior being committed (for investigations).
 * @param task     - The task contract (declared files + test-kind sourceFiles).
 * @param attempt  - 1 = first commit attempt; >= 2 = fix retry (stricter guard).
 * @returns The classified commit attempt.
 */
async function commitAndGate(
  pi: ExtensionAPI,
  cwd: string,
  subject: string,
  behavior: Behavior,
  task: TaskContract,
  attempt: number,
): Promise<CommitAttempt> {
  const timeoutMs = getCommitTimeoutMs();
  const headBefore = await readGitHead(pi, cwd);
  let commitOutput = "";
  let commitExitCode = 1;
  let timedOut = false;
  try {
    await pi.exec("git", ["add", "--all"], { cwd });
    // Staged-diff tamper guard: inspect before committing. On a violation the
    // commit is never invoked — the loop halts with a test-guard outcome.
    const nameStatusRes = await pi.exec("git", ["diff", "--cached", "--name-status"], { cwd });
    const unifiedRes = await pi.exec("git", ["diff", "--cached"], { cwd });
    const testKindSourceFiles = task.behaviors
      .filter((b) => b.kind === "test" && b.sourceFile)
      .map((b) => b.sourceFile!);
    const staged = classifyStagedDiff({
      nameStatus: nameStatusRes.stdout ?? "",
      declaredFiles: task.files,
      testKindSourceFiles,
      attempt,
      unifiedDiff: unifiedRes.stdout ?? "",
    });
    if (staged.kind === "test-guard") {
      return {
        outcome: {
          kind: "test-guard",
          investigation: staged.investigation,
          violations: staged.violations,
        },
      };
    }
    const res = await pi.exec("git", ["commit", "-m", subject], { cwd, timeout: timeoutMs });
    commitExitCode = res.exitCode ?? 1;
    commitOutput = [res.stdout ?? "", res.stderr ?? ""].filter(Boolean).join("\n");
  } catch (err) {
    const message = String((err as Error)?.message ?? err);
    commitOutput = message;
    timedOut = /timed out/i.test(message);
    commitExitCode = 1;
  }
  const headAfter = await readGitHead(pi, cwd);
  if (!timedOut && headBefore !== null && headAfter !== null && headAfter !== headBefore) {
    return { outcome: null, subject };
  }
  // HEAD did not move: gather tree evidence for the investigation only now.
  const statusAfter = timedOut ? "" : await readTreeState(pi, cwd);
  const diffStat = timedOut ? "" : await readDiffStat(pi, cwd);
  const outcome = classifyCommit(behavior, {
    headBefore,
    headAfter,
    commitExitCode,
    commitOutput,
    timedOut,
    statusAfter,
    diffStat,
    timeoutMs,
  });
  if (outcome.kind === "landed") return { outcome: null, subject };
  return { outcome };
}

/** Read `git diff --stat` for investigations. Best-effort, "" on failure. */
async function readDiffStat(pi: ExtensionAPI, cwd: string): Promise<string> {
  try {
    const res = await pi.exec("git", ["diff", "--stat"], { cwd });
    return (res.stdout ?? "").trim();
  } catch {
    return "";
  }
}

// ─── Commit timeout budget ─────────────────────────────────────────────────────

/** Default git-commit budget: hooks run lint+format+test on cold caches. */
const DEFAULT_COMMIT_TIMEOUT_MS = 300_000;

/**
 * Resolve the git-commit timeout budget, honoring PI_COMMIT_TIMEOUT_MS.
 *
 * @param env - Environment map (defaults to `process.env`); injectable for tests.
 * @returns The timeout in milliseconds (&gt; 0).
 */
export function getCommitTimeoutMs(
  env: Record<string, string | undefined> = process.env,
): number {
  const raw = env.PI_COMMIT_TIMEOUT_MS;
  if (raw) {
    const parsed = Number(raw);
    if (Number.isFinite(parsed) && parsed > 0) return parsed;
  }
  return DEFAULT_COMMIT_TIMEOUT_MS;
}

// ─── Orchestrator loop ─────────────────────────────────────────────────────────

/**
 * Run the orchestrator loop over a task contract (HEAD-gate design).
 *
 * For each active behavior, in order: run the unit (subprocess), then commit
 * with the unit's suggested subject — the project's pre-commit hooks fire and
 * own verification. HEAD before/after classifies the attempt: landed (done),
 * hook-rejected (investigation + fix subagent, RETRY_BUDGET retries), or
 * no-changes (same budget). Commit-process timeouts halt as infrastructure
 * failures. Every halt persists lastHalt into workflow state so failures are
 * diagnosable from the session log. Already-done behaviors are skipped, so
 * re-running resumes cleanly.
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

  const halt = async (behaviorId: string, error: string) => {
    result.haltedOn = behaviorId;
    result.error = error;
    result.treeState = await readTreeState(pi, cwd);
    state.lastHalt = {
      behaviorId,
      error,
      treeState: result.treeState,
      landedCommits: [...landedCommits],
      at: new Date().toISOString(),
    };
    saveState(pi, state);
    updateUi(state, ctx);
    return result;
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

  const resuming = state.phase === "implementing";
  let resumeTreeContext = "";
  if (resuming) {
    const tree = await readTreeState(pi, cwd);
    if (tree && tree !== "(unavailable)") {
      resumeTreeContext =
        `\n\n## Working tree is dirty (resumed session)\n` +
        `The previous run left uncommitted changes. Inspect them before implementing:\n\n` +
        "```\n" + tree + "\n```\n";
    }
  }

  for (const behavior of units) {
    const baseTask: UnitTask = {
      behaviorId: behavior.id,
      taskText: buildUnitTask(behavior, task) + resumeTreeContext,
    };
    resumeTreeContext = "";

    let attempt = await runUnit(baseTask, cwd);
    result.unitsRun++;
    let taskText = baseTask.taskText;

    for (let retry = 1; retry <= RETRY_BUDGET + 1; retry++) {
      if (attempt.error) {
        if (retry > RETRY_BUDGET) {
          return halt(behavior.id, `Unit ${behavior.id} failed after ${RETRY_BUDGET} retries: ${attempt.error}`);
        }
        taskText = buildRetryTask(behavior, task, attempt, retry);
        attempt = await runUnit({ behaviorId: behavior.id, taskText }, cwd);
        result.unitsRun++;
        continue;
      }

      const subject = pickCommitSubject(attempt, behavior);
      const commit = await commitAndGate(pi, cwd, subject, behavior, task, retry);

      if (commit.outcome === null) {
        landedCommits.push(subject);
        behavior.status = "done";
        state.lastMarkedHead = (await readGitHead(pi, cwd)) ?? state.lastMarkedHead;
        state.lastHalt = undefined;
        saveState(pi, state);
        updateUi(state, ctx);
        break;
      }

      if (commit.outcome.kind === "test-guard") {
        return halt(
          behavior.id,
          `Staged-diff guard blocked the commit for ${behavior.id} — tests are the specification. ` +
            `If the contract requires updating or removing test paths, re-declare them via ` +
            `/discuss -> /finalize listing those paths in files, then /implement resumes.\n\n` +
            commit.outcome.investigation,
        );
      }

      if (commit.outcome.kind === "commit-timeout") {
        return halt(
          behavior.id,
          `Commit process for ${behavior.id} timed out after ${getCommitTimeoutMs()}ms ` +
            `(PI_COMMIT_TIMEOUT_MS) — infrastructure failure, not a hook verdict. ` +
            `Raise the budget or scope the project's pre-commit hooks.`,
        );
      }

      if (retry > RETRY_BUDGET) {
        const detail =
          commit.outcome.kind === "hook-rejected"
            ? `pre-commit hook rejected the commit for ${behavior.id} after ${RETRY_BUDGET} retries`
            : `no changes detected for ${behavior.id} after ${RETRY_BUDGET} retries`;
        return halt(behavior.id, `${detail}\n\n${commit.outcome.investigation}`);
      }

      taskText = buildFixTask(behavior, task, baseTask.taskText, commit.outcome, retry);
      attempt = await runUnit({ behaviorId: behavior.id, taskText }, cwd);
      result.unitsRun++;
    }
  }

  const refusal = evaluateCompletionGate(state);
  if (refusal) {
    return halt(units[units.length - 1]!.id, `Completion gate refused: ${refusal}`);
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
    "## Contract (for reference)",
    renderTaskContract(task),
    "",
    "End with the JSON report block (summary, suggestedCommit) as instructed.",
  ]
    .filter(Boolean)
    .join("\n");
}

/**
 * Build the retry task text for a unit-reported failure (pre-commit stage).
 *
 * @param behavior - The behavior being retried.
 * @param task     - The full task contract.
 * @param prior    - The failed outcome from the previous attempt.
 * @param attempt  - 1-based retry attempt number.
 * @returns Rendered retry task text.
 */
export function buildRetryTask(
  behavior: Behavior,
  task: TaskContract,
  prior: ImplementerReport & { error?: string },
  attempt: number,
): string {
  const failure = prior.error ?? prior.summary ?? "unknown failure";
  return (
    `## Previous attempt failed (retry ${attempt}/${RETRY_BUDGET})\n` +
    failure +
    `\n\n## Original task\n` +
    buildUnitTask(behavior, task) +
    "\n\nFix the reported issues and re-verify."
  );
}
