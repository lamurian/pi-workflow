import { getImplementerTimeoutMs } from "./process-utils.ts";
import { lastAssistantText, parseImplementerReport, type ImplementerReport } from "./implementer-report.ts";
import { getActiveUnitClient, setActiveUnitClient } from "./unit-client-registry.ts";
import { spawnRpcUnitClient } from "./rpc-unit-client.ts";
import type { RpcUnitClient } from "./rpc-unit-client.ts";

// ─── Types ─────────────────────────────────────────────────────────────────────

/** One orchestrator unit: a behavior plus the task text handed to its subprocess. */
export interface UnitTask {
  /** Behavior id, e.g. "T1". */
  behaviorId: string;
  /** Full task text rendered for the subprocess. */
  taskText: string;
  /** Behavior kind; manual units keep their child alive for the HITL pause. */
  kind?: "test" | "manual";
}

// ─── Unit runner ───────────────────────────────────────────────────────────────

/** Fraction of the per-unit time budget at which the wrap-up steer fires. */
export const SOFT_DEADLINE_RATIO = 0.75;

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

/**
 * Check that a final assistant message contains a parseable JSON report
 * block (fenced ```json with a string `summary`).
 *
 * Mirrors parseImplementerReport's success criterion: a missing, broken,
 * or summary-less block means the unit did not comply with the mandatory
 * report format — even though parseImplementerReport tolerantly falls
 * back to the whole message text.
 *
 * @param text - Final assistant message text (may be empty).
 * @returns True when a valid report block exists.
 */
function hasParseableReport(text: string): boolean {
  const match = text.match(/```json\s*([\s\S]*?)```/);
  if (!match) return false;
  try {
    const parsed = JSON.parse(match[1]!) as Record<string, unknown>;
    return typeof parsed.summary === "string";
  } catch {
    return false;
  }
}

/**
 * Run one implementer unit subprocess and parse its structured report.
 *
 * Spawns a long-lived `pi --mode rpc` child and delivers the task as a
 * JSONL `prompt` command on stdin (never argv), keeping stdin open for
 * later steering. Completion is a parsed report block seen on stdout —
 * not process exit — after which the child is shut down gracefully
 * (`abort` + stdin close, SIGKILL fallback). At 75% of the budget the
 * unit is steered once with WRAP_UP_STEER_MESSAGE (soft deadline) so it
 * can emit a status-partial report before the hard kill. A child that
 * exits before
 * any report yields `error` with the same stdout-tail diagnostics as the
 * one-shot transport. The PI_IMPLEMENT_TIMEOUT_MS model-activity wall
 * clock still SIGKILLs a working child; timeouts are detected
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
 * @returns Parsed report, plus `client` when kept alive and
 *          `error`/`timedOut`/`missingReport` on failure.
 */
export async function runImplementerUnit(
  systemPrompt: string,
  taskText: string,
  cwd: string,
  signal?: AbortSignal,
  timeoutMs: number = getImplementerTimeoutMs(),
  onEvent?: (event: Record<string, unknown>) => void,
  keepAlive = false,
): Promise<ImplementerReport & { error?: string; timedOut?: boolean; missingReport?: boolean; client?: RpcUnitClient }> {
  const client = spawnRpcUnitClient({ systemPrompt, cwd });
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
 * - a soft deadline at SOFT_DEADLINE_RATIO (75%) of the budget that
 *   steers the unit once with WRAP_UP_STEER_MESSAGE so it can wrap up
 *   with a status-partial report before the kill;
 * - the hard kill at `timeoutMs` that SIGKILLs the child (timedOut=true).
 *
 * Both timers are cleared as soon as the run settles (report seen, child
 * exit, or abort), so a completed unit is never steered afterwards.
 *
 * @param client   - Live RPC client for the unit subprocess.
 * @param taskText - The behavior slice for this unit.
 * @param options  - Timeout, abort signal, event sink, keep-alive flag.
 * @returns Parsed report, plus `client` when kept alive and
 *          `error`/`timedOut`/`missingReport` on failure.
 */
export async function runImplementerUnitWithClient(
  client: RpcUnitClient,
  taskText: string,
  options: UnitRunnerOptions = {},
): Promise<ImplementerReport & { error?: string; timedOut?: boolean; missingReport?: boolean; client?: RpcUnitClient }> {
  const { timeoutMs = getImplementerTimeoutMs(), signal, onEvent, keepAlive = false } = options;

  let timedOut = false;
  let reportSeen = false;
  let exitCode = 0;

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
  });
  const unsubExit = client.onExit((info) => {
    exitCode = info.code;
    if (!reportSeen) settleWait();
  });

  const killNow = () => {
    timedOut = true;
    client.kill();
  };
  const timer = timeoutMs > 0 ? setTimeout(killNow, timeoutMs) : undefined;
  // Soft deadline: one wrap-up steer at 75% of the budget, before the hard kill.
  const softTimer =
    timeoutMs > 0
      ? setTimeout(
          () => client.steer(WRAP_UP_STEER_MESSAGE),
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
  if (timedOut) {
    await releaseIfKept();
    const assistant = lastAssistantText(stdout);
    const rawTail = assistant ? "" : stdout.trim().slice(-400);
    const marker = `timed out after ${timeoutMs}ms`;
    const head = stderr.trim() ? `${stderr.trim()}\n${marker}` : marker;
    const parts = [
      head,
      assistant ? `--- last assistant text ---\n${assistant}` : "",
      rawTail ? `--- raw stdout tail ---\n${rawTail}` : "",
    ].filter(Boolean);
    return { ...report, error: parts.join("\n\n"), timedOut: true };
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
