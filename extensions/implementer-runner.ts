import { getImplementerTimeoutMs } from "./process-utils.ts";
import { runDeadlineHandover, type DeadlineHandoverResult } from "./deadline-handover.ts";
import { hasParseableReport, lastAssistantText, parseImplementerReport, shouldAbortDeadRun, buildDeadRunError, type ImplementerReport } from "./implementer-report.ts";
import { getActiveUnitClient, setActiveUnitClient } from "./unit-client-registry.ts";
import { spawnRpcUnitClient } from "./rpc-unit-client.ts";
import { resolveTestExtensionPath } from "./test-tool-ensure.ts";
import type { RpcUnitClient } from "./rpc-unit-client.ts";
import type { UnitSessionSpec } from "./unit-session.ts";
import { REPORT_REMINDER_MESSAGE, reportReminderAction } from "./report-reminder.ts";

/** One orchestrator unit: a behavior plus the task text handed to its subprocess. */
export interface UnitTask {
  /** Behavior id, e.g. "T1". */
  behaviorId: string;
  /** Full task text rendered for the subprocess. */
  taskText: string;
  /** Behavior kind; manual units keep their child alive for the HITL pause. */
  kind?: "test" | "manual";
  thinking?: string; // escalation floor for this spawn's --thinking; omitted on the first attempt
  /** T3: resume session spec; forwarded to the spawn so every attempt of the
   * behavior reuses the same transcript (`--session-dir`/`--session-id`). */
  session?: UnitSessionSpec;
}

/** Fraction of the per-unit time budget at which the wrap-up steer fires. */
export const SOFT_DEADLINE_RATIO = 0.7;

/** Fraction of the per-unit time budget at which the progress-check steer fires. */
export const PROGRESS_CHECK_RATIO = 0.5;

/** Progress-check steer delivered once at half the time budget. */
export const PROGRESS_STEER_MESSAGE =
  "progress check: half the time budget is used; focus on the remaining work " +
  "and plan to emit the JSON report before the deadline";

/**
 * Wrap-up steer delivered once when a unit nears its hard-kill deadline.
 *
 * Asks the unit to stop exploring, persist its work uncommitted, and emit
 * the JSON report with status partial, findings and nextSteps so a
 * continuation unit can pick up where it left off.
 */
export const WRAP_UP_STEER_MESSAGE =
  "time budget nearly exhausted: stop exploring, write what you have to disk, " +
  "emit the JSON report with status partial, findings, nextSteps";

/** Options for the client-injected unit runner. */
export interface UnitRunnerOptions {
  /** Per-process wall-clock timeout in ms; 0 disables both timers. */
  timeoutMs?: number;
  /** Optional parent abort signal. */
  signal?: AbortSignal;
  /** Optional sink for live stdout events (zero-token relay). */
  onEvent?: (event: Record<string, unknown>) => void;
  /** Manual-kind units: skip the post-report shutdown (HITL pause). */
  keepAlive?: boolean;
}

/** Re-export: true when a final assistant message holds a valid JSON report block. */
export { hasParseableReport };

/**
 * Run one implementer unit subprocess and parse its structured report.
 *
 * Spawns a long-lived `pi --mode rpc` child and delivers the task as a
 * JSONL `prompt` command on stdin (never argv), keeping stdin open for
 * later steering. Completion is a parsed report block seen on stdout —
 * not process exit — after which the child is shut down gracefully
 * (`abort` + stdin close, SIGKILL fallback). At 70% of the budget the
 * unit is steered once with WRAP_UP_STEER_MESSAGE (soft deadline) so it
 * can emit a status-partial report before the hard kill. A child that
 * exits before
 * any report yields `error` with the same stdout-tail diagnostics as the
 * one-shot transport. The PI_IMPLEMENT_TIMEOUT_MS model-activity wall
 * clock starts the deadline handover (runDeadlineHandover: up to three
 * abort/prompt rounds) instead of SIGKILLing outright; only after the third
 * report-less round is the child killed. A report emitted during a round
 * settles the attempt with that report's fields. A parent abort signal still
 * SIGKILLs immediately without handover rounds. Timeouts are detected
 * structurally (`timedOut: true`) and their error context is the last
 * assistant text. An exit-0 child without a parseable JSON report block
 * is a failure too (`missingReport: true`), never a silent success.
 *
 * @param systemPrompt - Literal unit prompt text (from content/unit-prompt.md).
 * @param taskText     - The behavior slice for this unit.
 * @param cwd          - Working directory for the subprocess.
 * @param signal       - Optional parent abort signal.
 * @param timeoutMs    - Per-process wall-clock timeout in ms.
 * @param onEvent      - Optional sink for live stdout events (zero-token relay).
 * @param keepAlive    - Manual-kind units: skip the post-report shutdown so the
 *                       orchestrator can pause for human verification with the
 *                       child still alive. Only honored on the success path;
 *                       failures always shut the child down.
 * @param env          - Extra environment for the child (e.g.
 *                       PI_CONTRACT_GUARD_FILE), merged over process.env.
 * @param modelRef     - Optional canonical `provider/id` reference passed as `--model <ref>`.
 * @param thinkingFloor - Optional `--thinking` escalation floor (max'd with the env base).
 * @param runCommands  - T19: the task's pinned command names; non-empty grants
 *                       `run` in `--tools` (forwarded to spawnRpcUnitClient).
 * @param session      - T3: resume session spec; forwarded to the spawn so the
 *                       child gets `--session-dir`/`--session-id` instead of
 *                       `--no-session` (absent keeps today's argv).
 * @returns Parsed report, plus `client` when kept alive and
 *          `error`/`timedOut`/`missingReport`/`modelError` on failure.
 */
export async function runImplementerUnit(
  systemPrompt: string,
  taskText: string,
  cwd: string,
  signal?: AbortSignal,
  timeoutMs: number = getImplementerTimeoutMs(),
  onEvent?: (event: Record<string, unknown>) => void,
  keepAlive = false,
  env?: Record<string, string>,
  modelRef?: string,
  thinkingFloor?: string,
  runCommands: readonly string[] = [],
  session?: UnitSessionSpec,
): Promise<ImplementerReport & { error?: string; timedOut?: boolean; missingReport?: boolean; modelError?: boolean; client?: RpcUnitClient }> {
  // Per-spawn resolution: the generated test extension is loaded via a second
  // -e flag (and the `test` tool granted) only when the project has one.
  const client = spawnRpcUnitClient({
    systemPrompt,
    cwd,
    env,
    testExtPath: resolveTestExtensionPath(cwd),
    modelRef, thinkingFloor, runCommands, session,
  });
  setActiveUnitClient(client);
  return runImplementerUnitWithClient(client, taskText, { timeoutMs, signal, onEvent, keepAlive });
}

/**
 * Run one implementer unit on an already-spawned client.
 *
 * Shared core behind runImplementerUnit; exported as the test seam for
 * fake-timer tests with an injected client. Arms two timers when
 * `timeoutMs > 0`:
 *
 * - a soft deadline at SOFT_DEADLINE_RATIO (70%) of the budget that
 *   steers the unit once with WRAP_UP_STEER_MESSAGE so it can wrap up
 *   with a status-partial report before the kill;
 * - the wall clock at `timeoutMs` that runs runDeadlineHandover instead of
 *   SIGKILLing outright: up to three abort/prompt rounds; a report during a
 *   round settles the attempt with that report (timedOut=true), and only
 *   three report-less rounds SIGKILL the child. A parent abort signal
 *   bypasses the handover and kills immediately.
 *
 * All timers are cleared as soon as the run settles (report seen, child
 * exit, or abort), so a completed unit is never steered afterwards.
 *
 * @param client   - Live RPC client for the unit subprocess.
 * @param taskText - The behavior slice for this unit.
 * @param options  - Timeout, abort signal, event sink, keep-alive flag.
 * @returns Parsed report, plus `client` when kept alive and
 *          `error`/`timedOut`/`missingReport`/`modelError` on failure.
 */
export async function runImplementerUnitWithClient(
  client: RpcUnitClient,
  taskText: string,
  options: UnitRunnerOptions = {},
): Promise<ImplementerReport & { error?: string; timedOut?: boolean; missingReport?: boolean; modelError?: boolean; client?: RpcUnitClient }> {
  const { timeoutMs = getImplementerTimeoutMs(), signal, onEvent, keepAlive = false } = options;

  let timedOut = false;
  let reportSeen = false;
  let exitCode = 0;
  // T3: activity flags for the fail-fast dead-run decision (B2).
  let toolActivitySeen = false;
  let assistantText = "";
  let reminderSent = false;
  let deadRun: { message?: string } | undefined; // fail-fast abort; provider message when known

  let settleWait: () => void = () => {};
  const waitDone = new Promise<void>((resolve) => {
    settleWait = resolve;
  });

  const checkReport = () => {
    if (!reportSeen && hasParseableReport(lastAssistantText(client.rawStdout()))) {
      reportSeen = true;
      settleWait();
    }
  };

  const unsubEvents = client.onEvent((event) => {
    onEvent?.(event);
    checkReport();
    // T3: track this attempt's work, then let the pure helper decide the abort.
    if (String(event.type).startsWith("tool_")) toolActivitySeen = true;
    if (event.type === "message_end") {
      const message = event.message as
        | { role?: string; content?: Array<{ type?: string; text?: unknown }> }
        | undefined;
      if (message?.role === "assistant" && Array.isArray(message.content)) {
        if (message.content.some((block) => block.type === "toolCall")) toolActivitySeen = true;
        const parts = message.content
          .map((block) => block.text)
          .filter((text): text is string => typeof text === "string" && text.trim() !== "");
        if (parts.length > 0) assistantText = parts.join("\n").trim();
      }
    }
    const decision = shouldAbortDeadRun(event, { reportSeen, toolActivitySeen, assistantText });
    if (decision.abort) {
      deadRun = { message: decision.providerMessage };
      settleWait();
      return;
    }
    const action = reportReminderAction(event, { reportSeen, reminderSent });
    if (action === "remind") {
      reminderSent = true;
      client.prompt(REPORT_REMINDER_MESSAGE, "steer");
    } else if (action === "settle") settleWait();
  });
  const unsubExit = client.onExit((info) => {
    exitCode = info.code;
    if (!reportSeen) settleWait();
  });

  // Parent abort: SIGKILL immediately, never through handover rounds.
  const killNow = () => {
    timedOut = true;
    client.kill();
  };
  // T2.2b: the wall clock runs the deadline handover; the run settles when
  // the handover's report event or its final SIGKILL exit fires below.
  let handoverDone: Promise<DeadlineHandoverResult> | undefined;
  const onDeadline = () => {
    timedOut = true;
    handoverDone = runDeadlineHandover(client);
  };
  const timer = timeoutMs > 0 ? setTimeout(onDeadline, timeoutMs) : undefined;
  // Progress check at 50%, then one wrap-up steer at 70%, before the hard kill.
  const progressTimer =
    timeoutMs > 0
      ? setTimeout(
          () => client.prompt(PROGRESS_STEER_MESSAGE, "steer"),
          Math.floor(timeoutMs * PROGRESS_CHECK_RATIO),
        )
      : undefined;
  const softTimer =
    timeoutMs > 0
      ? setTimeout(
          () => client.prompt(WRAP_UP_STEER_MESSAGE, "steer"),
          Math.floor(timeoutMs * SOFT_DEADLINE_RATIO),
        )
      : undefined;
  const onAbort = () => killNow();
  if (signal) {
    if (signal.aborted) onAbort();
    else signal.addEventListener("abort", onAbort, { once: true });
  }

  client.prompt(taskText);
  await waitDone;
  if (timer) clearTimeout(timer);
  if (softTimer) clearTimeout(softTimer);
  if (progressTimer) clearTimeout(progressTimer);
  signal?.removeEventListener("abort", onAbort);
  unsubEvents();
  unsubExit();

  // Completion (report seen) or exit/kill: graceful shutdown (unless the
  // orchestrator keeps the child alive for a manual verification pause),
  // then classify.
  if (!keepAlive) {
    await client.shutdown(2_000);
    if (getActiveUnitClient() === client) setActiveUnitClient(undefined);
  }
  const releaseIfKept = async () => {
    if (keepAlive) {
      await client.shutdown(2_000);
      if (getActiveUnitClient() === client) setActiveUnitClient(undefined);
    }
  };

  const stdout = client.rawStdout();
  const stderr = client.stderrText();
  const report = parseImplementerReport(stdout);
  // T3/B2: fail fast — the provider rejected the model; the wall clock would only burn the budget.
  if (deadRun) {
    await releaseIfKept();
    return { ...report, error: buildDeadRunError(deadRun.message, stderr, stdout), modelError: true };
  }
  if (timedOut) {
    // T2.2b: a handover report settles the attempt with its findings and
    // nextSteps; three report-less rounds end in SIGKILL (base = parsed stdout).
    const handover = handoverDone ? await handoverDone : undefined;
    await releaseIfKept();
    const base = handover?.report ?? report;
    const assistant = lastAssistantText(stdout);
    const rawTail = assistant ? "" : stdout.trim().slice(-400);
    const marker = `timed out after ${timeoutMs}ms`;
    const head = stderr.trim() ? `${stderr.trim()}\n${marker}` : marker;
    const parts = [
      head,
      assistant ? `--- last assistant text ---\n${assistant}` : "",
      rawTail ? `--- raw stdout tail ---\n${rawTail}` : "",
    ].filter(Boolean);
    return { ...base, error: parts.join("\n\n"), timedOut: true };
  }
  if (!reportSeen && exitCode !== 0) {
    await releaseIfKept();
    const stdoutTail = stdout.trim().slice(-2000);
    const parts = [
      stderr.trim() || `implementer exited with code ${exitCode}`,
      stdoutTail ? `--- unit stdout tail ---\n${stdoutTail}` : "",
    ].filter(Boolean);
    return { ...report, error: parts.join("\n\n") };
  }
  const finalText = lastAssistantText(stdout);
  if (!hasParseableReport(finalText)) {
    await releaseIfKept();
    const detail = finalText
      ? `--- final assistant text ---\n${finalText}`
      : "(no assistant output captured)";
    return {
      ...report,
      error:
        "implementer ended without the required JSON report block " +
        "(a prose handover plea is not a report).\n\n" + detail,
      missingReport: true,
    };
  }
  if (keepAlive && client.isAlive()) {
    return { ...report, client };
  }
  return report;
}
