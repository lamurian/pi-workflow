import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
  saveState,
  updateUi,
  type WorkflowState,
  type TaskContract,
  type Behavior,
  type PendingCommand,
} from "./state.ts";
import { evaluateCompletionGate, renderTaskContract } from "./task-contract.ts";
import {
  runImplementerUnit,
  type UnitTask,
} from "./implementer-runner.ts";
import type { BlockedCommand, ImplementerReport } from "./subagent-runner.ts";
import {
  RETRY_BUDGET,
  buildFixTask,
  classifyCommit,
  classifyStagedDiff,
  type GateOutcome,
} from "./commit-gate.ts";

// ─── Types ─────────────────────────────────────────────────────────────────────

/** Result of one unit attempt: the parsed report plus failure diagnostics. */
export type UnitAttempt = ImplementerReport & {
  error?: string;
  /** True when the unit subprocess was killed by the wall-clock timeout. */
  timedOut?: boolean;
  /** True when the unit exited 0 without the mandatory JSON report block. */
  missingReport?: boolean;
};

/** Injectable unit runner: execute one behavior, return its report. */
export type UnitRunner = (
  unit: UnitTask,
  cwd: string,
  signal?: AbortSignal,
) => Promise<UnitAttempt>;

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
  /** Sandbox-blocked command the user must run before resuming (pause-halt). */
  pendingCommand?: PendingCommand;
  /** Deferrable sandbox-blocked commands reported by units (informational). */
  deferredCommands?: BlockedCommand[];
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
    if (result.code !== 0) return null;
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
    commitExitCode = res.code;
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
 * no-changes (same budget). A mustRunNow blockedCommands report pauses
 * immediately (no commit, no retry consumption) with pendingCommand on the
 * halt handoff. Commit-process timeouts halt as infrastructure
 * failures. Every halt persists lastHalt into workflow state so failures are
 * diagnosable from the session log. Already-done behaviors are skipped, so
 * re-running resumes cleanly. Progress notifications (unit start + landed
 * commit) keep a multi-minute run visibly alive in the UI.
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
  const result: OrchestratorResult = { complete: false, unitsRun: 0, landedCommits, deferredCommands: [] };

  const halt = async (
    behaviorId: string,
    error: string,
    pendingCommand?: PendingCommand,
  ) => {
    result.haltedOn = behaviorId;
    result.error = error;
    result.treeState = await readTreeState(pi, cwd);
    if (pendingCommand) result.pendingCommand = pendingCommand;
    state.lastHalt = {
      behaviorId,
      error,
      treeState: result.treeState,
      landedCommits: [...landedCommits],
      ...(pendingCommand ? { pendingCommand } : {}),
      at: new Date().toISOString(),
    };
    saveState(pi, state);
    updateUi(state, ctx);
    ctx.ui.setStatus("implement", undefined);
    return result;
  };

  if (units.length === 0) {
    result.complete = evaluateCompletionGate(state) === null;
    if (result.complete) {
      state.phase = "idle";
      saveState(pi, state);
      updateUi(null, ctx);
    }
    ctx.ui.setStatus("implement", undefined);
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

  const totalUnits = units.length;
  // Resume after a mustRunNow pause-halt: the user was asked to run the
  // blocked command outside the sandbox. Assume it was executed — the
  // unit must not attempt it (its sandbox still blocks it). Capture the
  // note before the loop (a landed commit clears state.lastHalt), attach
  // it only to the behavior that halted, then clear it so later behaviors
  // never inherit it.
  let pendingNote: { behaviorId: string; note: string } | undefined;
  if (state.lastHalt?.pendingCommand) {
    const pending = state.lastHalt.pendingCommand;
    pendingNote = {
      behaviorId: state.lastHalt.behaviorId,
      note:
        `\n\n## Previously blocked command — assumed run\n` +
        `The user was asked to run this command outside the sandbox:\n\n` +
        "```\n" + pending.command + "\n```\n\n" +
        (pending.reason ? `It was blocked: ${pending.reason}.\n\n` : "") +
        `Assume it has been executed. Do NOT attempt to run it yourself — your sandbox still blocks it. ` +
        `Verify its effects by other means (read files, run allowed checks). ` +
        `If its effects are missing, report that in your JSON report instead of retrying the command.`,
    };
  }
  for (let unitIndex = 0; unitIndex < units.length; unitIndex++) {
    const behavior = units[unitIndex]!;
    // Progress visibility: a unit subprocess can run for minutes with captured
    // stdio — announce start and landing so a healthy run never looks frozen.
    ctx.ui.notify(`Running unit ${behavior.id} (${unitIndex + 1}/${totalUnits})`, "info");
    // B3: live footer status under the distinct "implement" key; the
    // "workflow" key from state.ts updateUi is never written by these frames.
    const position = `${unitIndex + 1}/${totalUnits}`;
    ctx.ui.setStatus("implement", `✦ ${behavior.id} (${position}): implementing…`);
    let taskPrefix = "";
    if (pendingNote && pendingNote.behaviorId === behavior.id) {
      taskPrefix = pendingNote.note;
      pendingNote = undefined;
      if (state.lastHalt?.pendingCommand) {
        state.lastHalt.pendingCommand = undefined;
        saveState(pi, state);
      }
    }
    const baseTask: UnitTask = {
      behaviorId: behavior.id,
      taskText: taskPrefix + buildUnitTask(behavior, task) + resumeTreeContext,
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
        ctx.ui.setStatus("implement", `✦ ${behavior.id} (${position}): retry ${retry}/${RETRY_BUDGET}…`);
        taskText = buildRetryTask(behavior, task, attempt, retry);
        attempt = await runUnit({ behaviorId: behavior.id, taskText }, cwd);
        result.unitsRun++;
        continue;
      }

      // mustRunNow: the unit cannot proceed without the user running a
      // sandbox-blocked command. Pause immediately — no commit attempt, no
      // retry-budget consumption; the behavior stays active for resume.
      const mustRun = attempt.blockedCommands?.find((entry) => entry.mustRunNow);
      if (mustRun) {
        const pendingCommand: PendingCommand = {
          command: mustRun.command,
          ...(mustRun.reason ? { reason: mustRun.reason } : {}),
        };
        return halt(
          behavior.id,
          `Unit ${behavior.id} reported a sandbox-blocked command that must run now: ` +
            `${mustRun.command}${mustRun.reason ? ` (${mustRun.reason})` : ""}. ` +
            `Run it outside the sandbox, then /implement resumes.`,
          pendingCommand,
        );
      }

      // Deferrable entries never block landing: the commit gate runs as
      // usual and the commands are reported to the user at completion.
      for (const entry of attempt.blockedCommands ?? []) {
        result.deferredCommands!.push(entry);
      }

      const subject = pickCommitSubject(attempt, behavior);
      ctx.ui.setStatus("implement", `✦ ${behavior.id} (${position}): committing…`);
      const commit = await commitAndGate(pi, cwd, subject, behavior, task, retry);

      if (commit.outcome === null) {
        landedCommits.push(subject);
        behavior.status = "done";
        ctx.ui.setStatus("implement", `✦ ${behavior.id} (${position}): landed`);
        state.lastMarkedHead = (await readGitHead(pi, cwd)) ?? state.lastMarkedHead;
        state.lastHalt = undefined;
        saveState(pi, state);
        updateUi(state, ctx);
        ctx.ui.notify(`Landed commit for ${behavior.id}: ${subject}`, "info");
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

      ctx.ui.setStatus("implement", `✦ ${behavior.id} (${position}): retry ${retry}/${RETRY_BUDGET}…`);
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
  ctx.ui.setStatus("implement", undefined);
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
 * Three branches keyed off structured flags on the prior attempt:
 * - `timedOut` → infrastructure timeout at the wall clock, not a check
 *   failure; the retry inspects the on-disk work first, fixes one blocker,
 *   and reports even if verification is incomplete (context = last
 *   assistant text from the runner, not raw JSONL).
 * - `missingReport` → the unit ended without the mandatory JSON report;
 *   it runs headless, so blocked commands go in blockedCommands, never as
 *   a prose request to a user that does not exist mid-run.
 * - default → unchanged failure + retry wording (byte-compatible).
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
  prior: UnitAttempt,
  attempt: number,
): string {
  const failure = prior.error ?? prior.summary ?? "unknown failure";
  if (prior.timedOut) {
    return (
      `## Previous attempt was killed at the time limit (retry ${attempt}/${RETRY_BUDGET})\n` +
      `The previous run hit the hard wall-clock timeout (PI_IMPLEMENT_TIMEOUT_MS, 600 s default) and was ` +
      `killed mid-investigation — this was an infrastructure timeout, not a check failure.\n\n` +
      `Your work from that run is likely already on disk. Do NOT redo it from scratch: inspect git status ` +
      `and git diff first, then fix exactly one blocking issue. ` +
      `Emit the JSON report even if verification is incomplete.\n\n` +
      `## Last assistant text before the kill\n` +
      failure +
      `\n\n## Original task\n` +
      buildUnitTask(behavior, task) +
      "\n\nFix the reported issues and re-verify."
    );
  }
  if (prior.missingReport) {
    return (
      `## Previous attempt ended without the required JSON report (retry ${attempt}/${RETRY_BUDGET})\n` +
      `You run headless in a sandbox — no user is available mid-run. A blocked command must be reported ` +
      `via blockedCommands in the JSON report, never as a prose request to the user.\n\n` +
      `## Previous final message\n` +
      failure +
      `\n\n## Original task\n` +
      buildUnitTask(behavior, task) +
      "\n\nFix the reported issues and re-verify."
    );
  }
  return (
    `## Previous attempt failed (retry ${attempt}/${RETRY_BUDGET})\n` +
    failure +
    `\n\n## Original task\n` +
    buildUnitTask(behavior, task) +
    "\n\nFix the reported issues and re-verify."
  );
}
