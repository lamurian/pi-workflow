import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { readFileSync } from "node:fs";
import {
  saveState,
  updateUi,
  type WorkflowState,
  type TaskContract,
  type Behavior,
  type PendingCommand,
  type PendingManualCheck,
} from "./state.ts";
import { evaluateCompletionGate, renderTaskContract } from "./task-contract.ts";
import { appendFindings, createToolCallCollector, renderFindingsSection, renderToolCallDigest, type Finding } from "./findings-ledger.ts";
import {
  buildContinuationTaskText,
  classifyProgress,
  decideContinuation,
  computeTreeFingerprint,
  isPartialAttempt,
  shouldHaltEarly,
  buildEarlyHaltError,
} from "./unit-progress.ts";
import {
  classifyAttemptOutcome,
  deriveDiagnosis,
  truncateAttemptText,
  type AttemptOutcome,
  type AttemptRecord,
} from "./halt-report.ts";
import {
  runImplementerUnit,
  getActiveUnitClient,
  setActiveUnitClient,
  shutdownActiveClient,
  type UnitTask,
} from "./implementer-runner.ts";
import type { BlockedCommand, ImplementerReport } from "./subagent-runner.ts";
import type { RpcUnitClient, RpcImage } from "./rpc-unit-client.ts";
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
  /** Live rpc client handle; present only for manual-kind behaviors (T3). */
  client?: RpcUnitClient;
};

/** Injectable unit runner: execute one behavior, return its report. */
export type UnitRunner = (
  unit: UnitTask,
  cwd: string,
  signal?: AbortSignal,
  onEvent?: (event: Record<string, unknown>) => void,
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
  /** Manual behaviors whose verification timed out — committed but unconfirmed. */
  pendingManualChecks?: PendingManualCheck[];
  /** Per-attempt history recorded for the halted behavior (T8). */
  attempts?: AttemptRecord[];
  /** Commit subjects since the /implement baseline, git log baseline..HEAD (T8). */
  commitsSinceBaseline?: string[];
  /** Shared findings ledger snapshot at halt time; the report renders its tail (T8). */
  findings?: Finding[];
  /** Derived one-line halt diagnosis (T8). */
  diagnosis?: string;
  /** Derived one-line recommended next action (T8). */
  recommendation?: string;
}

// ─── Zero-token activity relay (T2) ─────────────────────────────────────────────

/** Data persisted for one relayed implementer activity entry. */
export interface ImplementerActivityData {
  /** Behavior the activity belongs to, e.g. "T2". */
  behaviorId: string;
  /** Activity flavor: a completed turn, an assistant message, or a status query. */
  kind: "turn" | "assistant" | "status";
  /** Relayed text: full assistant milestone text, or a compact turn summary. */
  text: string;
  /** ISO timestamp of the relay. */
  at: string;
}

/** Transcript-line budget for formatImplementerActivity. */
const RELAY_TEXT_LIMIT = 200;

/**
 * Format one activity entry as a compact transcript line.
 *
 * @param data - The persisted activity entry.
 * @returns A single line: `<behaviorId> <kind>: <text>`, truncated with "…".
 */
export function formatImplementerActivity(data: ImplementerActivityData): string {
  const text =
    data.text.length > RELAY_TEXT_LIMIT
      ? data.text.slice(0, RELAY_TEXT_LIMIT) + "…"
      : data.text;
  return `${data.behaviorId} ${data.kind}: ${text}`;
}

/** Extract concatenated text blocks from a message content array. */
function extractTextContent(content: unknown): string {
  if (!Array.isArray(content)) return "";
  return content
    .filter(
      (block): block is { type: string; text: string } =>
        typeof block === "object" &&
        block !== null &&
        (block as { type?: unknown }).type === "text" &&
        typeof (block as { text?: unknown }).text === "string",
    )
    .map((block) => block.text)
    .join("\n")
    .trim();
}

/** Best-effort compact description of a completed turn. */
function summarizeTurn(event: Record<string, unknown>): string {
  const message = event.message as { content?: unknown } | undefined;
  const blocks = Array.isArray(message?.content) ? message.content : [];
  const tools = blocks.filter(
    (block) =>
      typeof block === "object" &&
      block !== null &&
      /tool/i.test(String((block as { type?: unknown }).type ?? "")),
  );
  return tools.length > 0 ? "working with tools…" : "responding…";
}

/** Persist one activity entry (custom entries are never sent to the LLM). */
function persistActivity(pi: ExtensionAPI, data: ImplementerActivityData): void {
  pi.appendEntry("implementer-activity", data);
}

/**
 * Relay one implementer stdout event into the main session at zero token cost.
 *
 * turn_end drives the footer status line; assistant message_end events emit a
 * milestone notification with the complete message text. Both are persisted as
 * `implementer-activity` custom entries (not sent to the model). User-role
 * messages and other event types are ignored.
 *
 * @param pi         - ExtensionAPI reference.
 * @param ctx        - Extension context (UI access).
 * @param behaviorId - Behavior the child is implementing.
 * @param position   - Loop position string, e.g. "1/2".
 * @param event      - One parsed stdout event from the child.
 */
export function relayImplementerEvent(
  pi: ExtensionAPI,
  ctx: ExtensionContext,
  behaviorId: string,
  position: string,
  event: Record<string, unknown>,
): void {
  if (event.type === "turn_end") {
    const compact = summarizeTurn(event);
    ctx.ui.setStatus("implement", `✦ ${behaviorId} (${position}): ${compact}`);
    persistActivity(pi, { behaviorId, kind: "turn", text: compact, at: new Date().toISOString() });
    return;
  }
  if (event.type === "message_end") {
    const message = event.message as { role?: string; content?: unknown } | undefined;
    if (message?.role !== "assistant") return;
    const text = extractTextContent(message.content);
    if (!text) return;
    ctx.ui.notify(`${behaviorId}: ${text}`, "info");
    persistActivity(pi, { behaviorId, kind: "assistant", text, at: new Date().toISOString() });
  }
}

// ─── Manual verification pause (T3) ───────────────────────────────────────────

/** An open manual-verification pause (one at a time; the loop runs one unit). */
export interface HitlWindow {
  /** Behavior awaiting verification, e.g. "T2". */
  behaviorId: string;
  /** The behavior's contract description (for persistence/steering context). */
  description: string;
  /** Resolves the pause promise when the user approves. */
  approve: () => void;
}

let hitlWindow: HitlWindow | undefined;

/** Unsubscribe for the orchestration input handler (module scope so session
 * shutdown and halt paths can unregister it too). */
let offInputHandler: (() => void) | undefined;

/**
 * Tear down every orchestration artifact: input handler, pause window,
 * HITL clock, and any live implementer child (graceful abort, then
 * SIGKILL after a short grace). Idempotent; safe to call from session
 * shutdown, halt, and crash paths.
 *
 * @param graceMs - Grace period before the child's SIGKILL fallback.
 */
export async function cleanupOrchestration(graceMs: number = 1_000): Promise<void> {
  offInputHandler?.();
  offInputHandler = undefined;
  hitlWindow = undefined;
  disarmHitlClock();
  await shutdownActiveClient(graceMs);
}

/** Rearm callback for the HITL clock (set while a timed pause is open). */
let hitlRearm: (() => void) | undefined;

/** Pending HITL timer, if armed. */
let hitlTimer: ReturnType<typeof setTimeout> | undefined;

/** Outcome of a verification pause: approval (false) or clock expiry (true). */
export interface PauseOutcome {
  /** True when the HITL clock expired before the user approved. */
  timedOut: boolean;
}

/** Default HITL clock: 15 minutes of human time per pause. */
const DEFAULT_HITL_TIMEOUT_MS = 900_000;

/**
 * Resolve the HITL (human-verification) timeout budget.
 *
 * Independent of PI_IMPLEMENT_TIMEOUT_MS: that one bounds model activity,
 * this one bounds waiting for a human. Invalid or non-positive values fall
 * back to the default.
 *
 * @param env - Environment map (defaults to `process.env`); injectable for tests.
 * @returns The timeout in milliseconds (&gt; 0).
 */
export function getHitlTimeoutMs(
  env: Record<string, string | undefined> = process.env,
): number {
  const raw = env.PI_HITL_TIMEOUT_MS;
  if (raw) {
    const parsed = Number(raw);
    if (Number.isFinite(parsed) && parsed > 0) return parsed;
  }
  return DEFAULT_HITL_TIMEOUT_MS;
}

/** Clear the HITL timer and its rearm hook. */
function disarmHitlClock(): void {
  if (hitlTimer) clearTimeout(hitlTimer);
  hitlTimer = undefined;
  hitlRearm = undefined;
}

/**
 * Reset the HITL clock after user activity (a successful steer).
 *
 * No-op when no timed pause is open. Restarting on activity keeps an
 * engaged user from ever hitting the deferral while still bounding an
 * abandoned pause.
 */
export function resetHitlClock(): void {
  hitlRearm?.();
}

/**
 * Get the open verification pause, if any.
 *
 * @returns The current window, or undefined when no pause is open.
 */
export function getHitlWindow(): HitlWindow | undefined {
  return hitlWindow;
}

/**
 * Set (or clear with undefined) the open verification pause.
 *
 * @param window - The window handle, or undefined to clear.
 */
export function setHitlWindow(window: HitlWindow | undefined): void {
  hitlWindow = window;
}

/**
 * `/approve`: close the open verification pause so the loop may commit.
 *
 * With an open window: clears it and resolves the pause promise (the loop
 * then shuts the child down and commits through the gate). Outside a pause:
 * refuses with a warning and changes nothing.
 *
 * @param _pi - ExtensionAPI reference (unused; kept for symmetry/telemetry).
 * @param ctx - Extension context (UI access).
 */
export function runApprove(_pi: ExtensionAPI, ctx: ExtensionContext): void {
  const window = hitlWindow;
  if (!window) {
    ctx.ui.notify(
      "/approve is only valid during a manual verification pause — while a " +
        'kind:"manual" behavior awaits your check.',
      "warning",
    );
    return;
  }
  hitlWindow = undefined;
  disarmHitlClock();
  ctx.ui.notify(`${window.behaviorId} approved — committing.`, "info");
  window.approve();
}

/**
 * Open a verification pause for a manual behavior and wait for approval
 * or the HITL clock (PI_HITL_TIMEOUT_MS).
 *
 * Notifies the guidance line, sets the awaiting-verification status frame,
 * registers the window that /approve resolves, and arms the HITL clock.
 * The commit is deferred until the returned promise settles — either by
 * approval (`timedOut: false`) or clock expiry (`timedOut: true`, with a
 * warning notify). Successful steers reset the clock.
 *
 * @param ctx       - Extension context (UI access).
 * @param behavior  - The manual behavior awaiting verification.
 * @returns A promise resolving with how the pause ended.
 */
function openVerificationPause(
  ctx: ExtensionContext,
  behavior: Behavior,
): Promise<PauseOutcome> {
  return new Promise<PauseOutcome>((resolve) => {
    const settle = (outcome: PauseOutcome) => {
      hitlWindow = undefined;
      disarmHitlClock();
      resolve(outcome);
    };
    const arm = () => {
      if (hitlTimer) clearTimeout(hitlTimer);
      hitlTimer = setTimeout(() => {
        ctx.ui.notify(
          `${behavior.id} verification timed out — committing anyway; listed for manual check`,
          "warning",
        );
        settle({ timedOut: true });
      }, getHitlTimeoutMs());
    };
    hitlRearm = arm;
    arm();
    hitlWindow = {
      behaviorId: behavior.id,
      description: behavior.description,
      approve: () => settle({ timedOut: false }),
    };
    ctx.ui.notify(
      `${behavior.id} awaiting manual verification — type feedback (auto-forwarded) or /steer <msg>, /approve`,
      "info",
    );
    ctx.ui.setStatus("implement", `✦ ${behavior.id}: awaiting verification`);
  });
}

/**
 * `/steer`: explicit text path into the verification pause.
 *
 * Forwards the message to the live child (best-effort: image file paths in
 * the args are read and attached) and emits the feedback status frame.
 * Refuses with a warning outside an open pause.
 *
 * @param message - The feedback text, possibly with image file path tokens.
 * @param pi      - ExtensionAPI reference.
 * @param ctx     - Extension context (UI access).
 */
export function runSteer(message: string, pi: ExtensionAPI, ctx: ExtensionContext): void {
  void pi;
  const window = hitlWindow;
  const client = getActiveUnitClient();
  if (!window || !client || !client.isAlive()) {
    ctx.ui.notify(
      "/steer is only valid during a verification pause — while a kind:\"manual\" " +
        "behavior awaits your check and its implementer subprocess is alive.",
      "warning",
    );
    return;
  }
  client.steer(message.trim(), readImageAttachments(message));
  resetHitlClock();
  ctx.ui.setStatus("implement", `✦ ${window.behaviorId}: feedback forwarded`);
}

/** Guess an image mimeType from a file extension. */
function imageMimeType(path: string): string | undefined {
  const ext = path.toLowerCase().split(".").pop();
  switch (ext) {
    case "png":
      return "image/png";
    case "jpg":
    case "jpeg":
      return "image/jpeg";
    case "gif":
      return "image/gif";
    case "webp":
      return "image/webp";
    default:
      return undefined;
  }
}

/**
 * Best-effort read of image file paths mentioned in a steer message.
 *
 * Whitespace-separated tokens with an image extension are read as base64
 * and attached; unreadable files are silently skipped (the text still
 * reaches the child either way).
 *
 * @param message - The steer message text.
 * @returns Attached images, possibly empty.
 */
function readImageAttachments(message: string): RpcImage[] {
  const images: RpcImage[] = [];
  for (const token of message.split(/\s+/)) {
    const mimeType = imageMimeType(token);
    if (!mimeType) continue;
    try {
      const data = readFileSync(token).toString("base64");
      images.push({ type: "image", data, mimeType });
    } catch {
      // Unreadable path: skip; the message text still forwards.
    }
  }
  return images;
}

/**
 * Input policy for the orchestrated run: while a verification pause is open,
 * plain user text (plus pasted images) is consumed and forwarded to the live
 * child as a steer command; slash commands always reach the main agent, and
 * with no open window every input passes through.
 *
 * @param event - The user input event.
 * @returns `{ action: "handled" }` when forwarded; otherwise continue.
 */
export function handleWorkflowInput(
  event: { text: string; images?: Array<{ type: string; data: string; mimeType: string }> },
): { action: "handled" } | { action: "continue" } {
  const window = hitlWindow;
  const client = getActiveUnitClient();
  if (!window || !client || !client.isAlive()) return { action: "continue" };
  if (event.text.trim().startsWith("/")) return { action: "continue" };
  client.steer(event.text, (event.images ?? []) as RpcImage[]);
  resetHitlClock();
  return { action: "handled" };
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

/**
 * Read the working-tree fingerprint used for partial-attempt progress
 * detection (T6): `git status --short` + `git diff --stat`, joined by
 * computeTreeFingerprint. Best-effort: failed commands contribute empty
 * strings, keeping the fingerprint stable across attempts.
 *
 * @param pi  - ExtensionAPI reference (for exec access).
 * @param cwd - Working directory.
 * @returns The joined tree fingerprint.
 */
async function readTreeFingerprint(pi: ExtensionAPI, cwd: string): Promise<string> {
  const status = await readTreeState(pi, cwd);
  let diffStat = "";
  try {
    const res = await pi.exec("git", ["diff", "--stat"], { cwd });
    diffStat = (res.stdout ?? "").trim();
  } catch {
    diffStat = "";
  }
  return computeTreeFingerprint(status, diffStat);
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

/**
 * Read the commit subjects landed since the /implement baseline (T8).
 *
 * Runs `git log <baselineHead>..HEAD --pretty=%s` so the halt report can
 * list cumulative commits across ALL runs of the task, not just the
 * current one. Best-effort: returns null when no baseline was recorded
 * (older sessions, git unavailable, or a failed log) so callers fall
 * back to the per-run landedCommits.
 *
 * @param pi          - ExtensionAPI reference.
 * @param cwd         - Working directory.
 * @param baselineHead - HEAD recorded when /implement started (optional).
 * @returns Commit subjects since the baseline, or null when unavailable.
 */
export async function readCommitsSinceBaseline(
  pi: ExtensionAPI,
  cwd: string,
  baselineHead: string | undefined,
): Promise<string[] | null> {
  if (!baselineHead) return null;
  try {
    const res = await pi.exec("git", ["log", `${baselineHead}..HEAD`, "--pretty=%s"], { cwd });
    if (res.code !== 0) return null;
    return (res.stdout ?? "")
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean);
  } catch {
    return null;
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
 * A non-empty engineerNote is appended to every unit's task text: the base
 * attempt, every retry (buildRetryTask), and every fix subagent (whose
 * original task text already carries it). On completion the loop clears
 * state.engineerNote along with the phase switch to idle.
 *
 * @param pi           - ExtensionAPI reference.
 * @param ctx          - Extension context (cwd, UI).
 * @param state        - Current workflow state (mutated in place).
 * @param task         - The task contract.
 * @param runUnit      - Injectable unit runner (defaults to the real subprocess).
 * @param engineerNote - Optional engineer's note forwarded from /implement.
 * @returns Loop outcome including landed commits and halt details.
 */
export async function runOrchestratedImplement(
  pi: ExtensionAPI,
  ctx: ExtensionContext,
  state: WorkflowState,
  task: TaskContract,
  runUnit: UnitRunner = (unit, cwd, signal, onEvent) =>
    runImplementerUnit(
      loadUnitPrompt(),
      unit.taskText,
      cwd,
      signal,
      undefined,
      onEvent,
      unit.kind === "manual",
    ),
  engineerNote?: string,
): Promise<OrchestratorResult> {
  const cwd = ctx.cwd;
  const landedCommits: string[] = [];
  const noteSection = engineerNote ? buildEngineerNoteSection(engineerNote) : "";
  const units = task.behaviors.filter((b) => b.status === "active");

  /** Current findings section for task texts (shared ledger, all behaviors). */
  const findingsSection = () => renderFindingsSection(state.findings);

  /**
   * Append a unit attempt's report findings to the shared ledger and
   * persist the state. Exact duplicates are skipped; when nothing new
   * lands, no persist happens.
   *
   * @returns True when at least one new finding landed in the ledger.
   */
  const recordFindings = (behaviorId: string, texts: string[] | undefined): boolean => {
    if (!texts?.length) return false;
    const { ledger, changed } = appendFindings(state.findings ?? [], behaviorId, texts);
    if (!changed) return false;
    state.findings = ledger;
    saveState(pi, state);
    return true;
  };

  const result: OrchestratorResult = {
    complete: false,
    unitsRun: 0,
    landedCommits,
    deferredCommands: [],
    pendingManualChecks: [],
  };

  // T8: per-attempt history of the currently-halted-behavior candidate.
  // Reset per behavior; on halt it feeds the attempt table, the diagnosis
  // derivation and lastHalt persistence.
  const attemptHistory: AttemptRecord[] = [];

  // Steering (T4): while a verification pause is open, plain user input at
  // the main prompt is consumed and forwarded to the live child; slash
  // commands and everything outside a pause pass through. Unregistered on
  // every exit path via cleanupOrchestration.

  const halt = async (
    behaviorId: string,
    error: string,
    pendingCommand?: PendingCommand,
  ) => {
    await cleanupOrchestration();
    result.haltedOn = behaviorId;
    result.error = error;
    result.treeState = await readTreeState(pi, cwd);
    if (pendingCommand) result.pendingCommand = pendingCommand;
    // T8: enrich the halt — cumulative commits since the /implement
    // baseline (per-run fallback stays in composeHaltReport), the halted
    // behavior's attempt history, the findings tail, and a derived
    // diagnosis + recommended next action. All of it persists to lastHalt.
    const commits = await readCommitsSinceBaseline(pi, cwd, state.baselineHead);
    if (commits?.length) result.commitsSinceBaseline = commits;
    result.attempts = attemptHistory.map((entry) => ({ ...entry }));
    result.findings = state.findings?.length ? [...state.findings] : undefined;
    const diagnosis = deriveDiagnosis(result.attempts, error);
    result.diagnosis = diagnosis.diagnosis;
    result.recommendation = diagnosis.recommendation;
    state.lastHalt = {
      behaviorId,
      error,
      treeState: result.treeState,
      landedCommits: [...landedCommits],
      attempts: result.attempts,
      diagnosis: diagnosis.diagnosis,
      recommendation: diagnosis.recommendation,
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
      state.engineerNote = undefined;
      state.findings = undefined;
      saveState(pi, state);
      updateUi(null, ctx);
    }
    ctx.ui.setStatus("implement", undefined);
    return result;
  }

  const resuming = state.phase === "implementing";
  offInputHandler?.();
  offInputHandler = pi.on("input", async (event) => handleWorkflowInput(event));
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
    // T8: attempt history is per behavior — a landed behavior's history
    // is irrelevant to a later behavior's halt report.
    attemptHistory.length = 0;
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
    const baseCore = taskPrefix + buildUnitTask(behavior, task) + noteSection + resumeTreeContext;
    const baseTask: UnitTask = {
      behaviorId: behavior.id,
      taskText: baseCore + findingsSection(),
      kind: behavior.kind,
    };
    resumeTreeContext = "";

    const relay = (event: Record<string, unknown>) =>
      relayImplementerEvent(pi, ctx, behavior.id, position, event);
    /**
     * Run one unit attempt and record its report findings in the ledger.
     * Timed-out or report-less attempts additionally contribute a tool-call
     * digest (T5) so the next attempt does not re-read blindly. Captures the
     * tree fingerprint before the attempt (T6 progress detection) and tracks
     * whether any new finding landed during it.
     */
    let attemptFingerprintBefore = "";
    let attemptNewFindings = false;
    let attemptProgress = false;
    const runAndRecord = async (unit: UnitTask): Promise<UnitAttempt> => {
      attemptFingerprintBefore = await readTreeFingerprint(pi, cwd);
      attemptNewFindings = false;
      const startedAt = Date.now();
      const digest = createToolCallCollector();
      const out = await runUnit(unit, cwd, undefined, (event) => {
        digest.record(event);
        relay(event);
      });
      attemptNewFindings = recordFindings(behavior.id, out.findings);
      if (out.timedOut || out.missingReport) {
        const digestText = renderToolCallDigest(digest.entries());
        if (digestText) {
          attemptNewFindings = recordFindings(behavior.id, [digestText]) || attemptNewFindings;
        }
      }
      // T8: classify and record the finished attempt. Timed-out/partial
      // attempts additionally compute their progress flag here; the
      // partial branch reuses it instead of re-fingerprinting the tree.
      const preOutcome = classifyAttemptOutcome(out);
      let progress = attemptNewFindings;
      if (preOutcome === "timeout" || preOutcome === "partial") {
        progress =
          classifyProgress({
            fingerprintBefore: attemptFingerprintBefore,
            fingerprintAfter: await readTreeFingerprint(pi, cwd),
            newFindings: attemptNewFindings,
          }) || attemptNewFindings;
      }
      attemptProgress = progress;
      attemptHistory.push({
        attempt: attemptHistory.length + 1,
        outcome: preOutcome,
        durationSec: Math.max(0, Math.round((Date.now() - startedAt) / 1000)),
        progress,
        lastText: truncateAttemptText(out.error ?? out.summary ?? ""),
      });
      return out;
    };
    /** Seal the last recorded attempt with the commit-gate verdict (T8). */
    const sealLastAttempt = (outcome: AttemptOutcome) => {
      const last = attemptHistory[attemptHistory.length - 1];
      if (last) last.outcome = outcome;
    };
    let attempt = await runAndRecord(baseTask);
    result.unitsRun++;
    let taskText = baseTask.taskText;
    // T6: continuation units per behavior, bounded and never charged to the
    // retry budget; reset per behavior.
    let continuations = 0;
    let retry = 1;
    // T7: consecutive timed-out/partial attempts that neither moved the tree
    // fingerprint nor added findings; two in a row halt the behavior early.
    let noProgressStreak = 0;

    while (retry <= RETRY_BUDGET + 1) {
      // T6: partial reports and timed-out attempts never reach the commit
      // gate — their work stays uncommitted for a continuation unit.
      if (!attempt.missingReport && isPartialAttempt(attempt)) {
        const progressed = attemptProgress;
        if (progressed) {
          noProgressStreak = 0;
        } else if (shouldHaltEarly(++noProgressStreak)) {
          // T7: repeated identical timeouts/partial reports waste hours —
          // halt with an actionable diagnosis instead of burning retries.
          return halt(behavior.id, buildEarlyHaltError(behavior.id, noProgressStreak));
        }
        if (decideContinuation({ progressed, continuations }) === "continue") {
          continuations++;
          ctx.ui.setStatus("implement", `✦ ${behavior.id} (${position}): continuing partial work…`);
          taskText =
            buildContinuationTaskText(behavior.id, attempt, baseCore, await readTreeState(pi, cwd)) +
            noteSection +
            findingsSection();
          attempt = await runAndRecord({ behaviorId: behavior.id, taskText, kind: behavior.kind });
          result.unitsRun++;
          continue;
        }
        if (!attempt.error) {
          // A partial report without progress consumes one retry as today.
          if (retry > RETRY_BUDGET) {
            return halt(
              behavior.id,
              `Unit ${behavior.id} reported partial work after ${RETRY_BUDGET} retries without ` +
                `advancing the tree or adding findings: ${attempt.summary ?? "no summary"}`,
            );
          }
          ctx.ui.setStatus("implement", `✦ ${behavior.id} (${position}): retry ${retry}/${RETRY_BUDGET}…`);
          taskText = buildRetryTask(behavior, task, attempt, retry) + noteSection + findingsSection();
          attempt = await runAndRecord({ behaviorId: behavior.id, taskText, kind: behavior.kind });
          result.unitsRun++;
          retry++;
          continue;
        }
        // Timed out without progress (or beyond the continuation budget):
        // fall through to the unchanged timeout-retry path below.
      }

      if (attempt.error) {
        // A plain unit error (no partial report, no timeout) breaks any
        // no-progress streak: only timed-out/partial attempts count toward
        // the early halt.
        if (!isPartialAttempt(attempt)) noProgressStreak = 0;
        if (retry > RETRY_BUDGET) {
          return halt(behavior.id, `Unit ${behavior.id} failed after ${RETRY_BUDGET} retries: ${attempt.error}`);
        }
        ctx.ui.setStatus("implement", `✦ ${behavior.id} (${position}): retry ${retry}/${RETRY_BUDGET}…`);
        taskText = buildRetryTask(behavior, task, attempt, retry) + noteSection + findingsSection();
        attempt = await runAndRecord({ behaviorId: behavior.id, taskText, kind: behavior.kind });
        result.unitsRun++;
        retry++;
        continue;
      }

      // mustRunNow: the unit cannot proceed without the user running a
      // sandbox-blocked command. Pause immediately — no commit attempt, no
      // retry-budget consumption; the behavior stays active for resume.
      const mustRun = attempt.blockedCommands?.find((entry) => entry.mustRunNow);
      if (mustRun) {
        sealLastAttempt("blocked");
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
      // The attempt reached the commit gate with a usable report: any
      // no-progress streak from earlier partial attempts is broken.
      noProgressStreak = 0;

      // Manual behaviors pause before commit for human verification (T3).
      // The kept-alive child stays available for mid-pause steering; once
      // the pause closes (approve or HITL timeout), it is shut down and the
      // commit runs. A timeout defers the behavior to pendingManualChecks
      // after the commit lands (T5).
      let pauseOutcome: PauseOutcome | undefined;
      if (behavior.kind === "manual" && attempt.client) {
        pauseOutcome = await openVerificationPause(ctx, behavior);
        await attempt.client.shutdown(2_000);
        if (getActiveUnitClient() === attempt.client) setActiveUnitClient(undefined);
      }

      const subject = pickCommitSubject(attempt, behavior);
      ctx.ui.setStatus("implement", `✦ ${behavior.id} (${position}): committing…`);
      const commit = await commitAndGate(pi, cwd, subject, behavior, task, retry);
      // T8: the commit-gate verdict seals the last attempt's outcome in
      // the halt report's attempt table (landed attempts reset with the
      // next behavior's history).
      if (commit.outcome !== null) sealLastAttempt(commit.outcome.kind);

      if (commit.outcome === null) {
        landedCommits.push(subject);
        behavior.status = "done";
        if (pauseOutcome?.timedOut) {
          const check: PendingManualCheck = {
            behaviorId: behavior.id,
            description: behavior.description,
          };
          state.pendingManualChecks = [...(state.pendingManualChecks ?? []), check];
          result.pendingManualChecks = [...(result.pendingManualChecks ?? []), check];
        }
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
      taskText = buildFixTask(behavior, task, baseCore, commit.outcome, retry) + findingsSection();
      attempt = await runAndRecord({ behaviorId: behavior.id, taskText, kind: behavior.kind });
      result.unitsRun++;
      retry++;
    }
  }

  const refusal = evaluateCompletionGate(state);
  if (refusal) {
    return halt(units[units.length - 1]!.id, `Completion gate refused: ${refusal}`);
  }
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
 * Build the `## Engineer's note` section appended to unit task texts.
 *
 * Mirrors the wording the solo /implement prompt uses: the note is guidance
 * on top of the authoritative contract, never a license to extend it.
 *
 * @param note - The engineer's note text (non-empty).
 * @returns The rendered markdown section, ready for string concatenation.
 */
export function buildEngineerNoteSection(note: string): string {
  return (
    `\n\n## Engineer's note\n\n${note}` +
    "\n\nGuidance on top of the authoritative contract. If it implies changes " +
    "beyond the contract, report that and tell the user to run /finalize — " +
    "do not implement beyond the contract."
  );
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
      `The previous run hit the hard wall-clock timeout (PI_IMPLEMENT_TIMEOUT_MS, 900 s default) and was ` +
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
