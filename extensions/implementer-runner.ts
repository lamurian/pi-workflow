import { spawn } from "node:child_process";
import {
  createTimeoutSignal,
  getPiInvocation,
  getImplementerTimeoutMs,
  lastAssistantText,
  parseImplementerReport,
  type ImplementerReport,
} from "./subagent-runner.ts";
import { spawnRpcUnitClient } from "./rpc-unit-client.ts";
import type { RpcUnitClient } from "./rpc-unit-client.ts";

// ─── Active client registry ────────────────────────────────────────────────────

/**
 * The single live implementer child, if any (one unit runs at a time).
 *
 * Exposed for HITL steering and orphan-safety shutdown.
 * Test seam: setActiveUnitClient injects a fake client.
 */
let activeUnitClient: RpcUnitClient | undefined;

/**
 * Get the live implementer child client, when one is running.
 *
 * @returns The active client, or undefined when no unit is running.
 */
export function getActiveUnitClient(): RpcUnitClient | undefined {
  return activeUnitClient;
}

/**
 * Set (or clear with undefined) the live implementer child client.
 *
 * @param client - The client handle to track, or undefined to clear.
 */
export function setActiveUnitClient(client: RpcUnitClient | undefined): void {
  activeUnitClient = client;
}

/**
 * Shut down the active implementer child, if any (orphan safety).
 *
 * Graceful path: abort command + stdin close, SIGKILL after the grace
 * period (the client's built-in shutdown fallback). Clears the registry.
 *
 * @param graceMs - Grace period before the SIGKILL fallback.
 * @returns True when a child was shut down.
 */
export async function shutdownActiveClient(graceMs: number = 2_000): Promise<boolean> {
  const client = getActiveUnitClient();
  if (!client) return false;
  if (client.isAlive()) await client.shutdown(graceMs);
  if (getActiveUnitClient() === client) setActiveUnitClient(undefined);
  return true;
}

// ─── Types ─────────────────────────────────────────────────────────────────────

/** Raw output from a spawned pi subprocess. */
export interface RawProcessResult {
  /** Full stdout captured from the process. */
  stdout: string;
  /** Full stderr captured from the process. */
  stderr: string;
  /** Exit code; non-zero when the process failed or was killed. */
  exitCode: number;
}

/** One orchestrator unit: a behavior plus the task text handed to its subprocess. */
export interface UnitTask {
  /** Behavior id, e.g. "T1". */
  behaviorId: string;
  /** Full task text rendered for the subprocess. */
  taskText: string;
  /** Behavior kind; manual units keep their child alive for the HITL pause. */
  kind?: "test" | "manual";
}

// ─── Raw subprocess execution ──────────────────────────────────────────────────

/**
 * Run a pi subprocess and return its raw stdout/stderr without parsing.
 *
 * Shared spawn core for implementer units. Applies a timeout (combined with
 * an optional parent signal), kills via SIGKILL on abort, and never throws —
 * failures surface through `exitCode` so callers decide how to report them.
 *
 * Diagnostics guarantees:
 * - spawn failures (ENOENT etc.) append the error message to `stderr`
 *   instead of resolving as a silent exit 1.
 * - timeouts append `timed out after <ms>ms` to `stderr` so callers can
 *   distinguish infrastructure timeouts from unit/hook failures.
 * - after a kill, the promise settles even if orphaned grandchildren keep
 *   the stdio pipes open (a killed process's `close` event may never fire).
 *
 * @param args      - Full argv for the subprocess (from buildImplementerArgs).
 * @param cwd       - Working directory for the subprocess.
 * @param signal    - Optional parent abort signal.
 * @param timeoutMs - Per-process timeout in ms. 0 = no timeout.
 * @returns Raw stdout/stderr and the exit code.
 */
export async function runRawPiProcess(
  args: string[],
  cwd: string,
  signal?: AbortSignal,
  timeoutMs: number = getImplementerTimeoutMs(),
): Promise<RawProcessResult> {
  let timeoutClear: (() => void) | null = null;

  try {
    let killSignal: AbortSignal | undefined = signal;
    if (timeoutMs > 0) {
      const combined = createTimeoutSignal(timeoutMs, signal);
      killSignal = combined.signal;
      timeoutClear = combined.clear;
    }

    let stdout = "";
    let stderr = "";

    const exitCode = await new Promise<number>((resolvePromise) => {
      const invocation = getPiInvocation(args);
      let settled = false;
      const settle = (code: number) => {
        if (settled) return;
        settled = true;
        resolvePromise(code);
      };

      const proc = spawn(invocation.command, invocation.args, {
        cwd,
        shell: false,
        stdio: ["ignore", "pipe", "pipe"],
      });

      proc.stdout.on("data", (data: Buffer) => {
        stdout += data.toString();
      });

      proc.stderr.on("data", (data: Buffer) => {
        stderr += data.toString();
      });

      proc.on("close", (code, killedSignal) => {
        settle(code ?? (killedSignal ? 1 : 0));
      });

      proc.on("error", (err) => {
        const message = String((err as Error)?.message ?? err);
        stderr += (stderr && !stderr.endsWith("\n") ? "\n" : "") + message;
        settle(1);
      });

      if (killSignal) {
        const killProc = () => {
          proc.kill("SIGKILL");
          // Orphaned grandchildren can hold the stdio pipes open after the
          // kill, so "close" may never fire. Settle from captured output.
          stderr +=
            (stderr && !stderr.endsWith("\n") ? "\n" : "") +
            `timed out after ${timeoutMs}ms`;
          setTimeout(() => settle(1), 50);
        };
        if (killSignal.aborted) {
          killProc();
        } else {
          killSignal.addEventListener("abort", killProc, { once: true });
        }
      }
    });

    return { stdout, stderr, exitCode };
  } finally {
    timeoutClear?.();
  }
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
