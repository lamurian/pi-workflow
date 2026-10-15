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
 * (`abort` + stdin close, SIGKILL fallback). A child that exits before
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
 * @returns Parsed report, plus `error`/`timedOut`/`missingReport` on failure.
 */
export async function runImplementerUnit(
  systemPrompt: string,
  taskText: string,
  cwd: string,
  signal?: AbortSignal,
  timeoutMs: number = getImplementerTimeoutMs(),
): Promise<ImplementerReport & { error?: string; timedOut?: boolean; missingReport?: boolean }> {
  const client = spawnRpcUnitClient({ systemPrompt, cwd });

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

  const unsubEvents = client.onEvent(() => checkReport());
  const unsubExit = client.onExit((info) => {
    exitCode = info.code;
    if (!reportSeen) settleWait();
  });

  const killNow = () => {
    timedOut = true;
    client.kill();
  };
  const timer = timeoutMs > 0 ? setTimeout(killNow, timeoutMs) : undefined;
  const onAbort = () => killNow();
  if (signal) {
    if (signal.aborted) onAbort();
    else signal.addEventListener("abort", onAbort, { once: true });
  }

  client.prompt(taskText);
  await waitDone;
  if (timer) clearTimeout(timer);
  signal?.removeEventListener("abort", onAbort);
  unsubEvents();
  unsubExit();

  // Completion (report seen) or exit/kill: graceful shutdown, then classify.
  await client.shutdown(2_000);

  const stdout = client.rawStdout();
  const stderr = client.stderrText();
  const report = parseImplementerReport(stdout);
  if (timedOut) {
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
    const stdoutTail = stdout.trim().slice(-2000);
    const parts = [
      stderr.trim() || `implementer exited with code ${exitCode}`,
      stdoutTail ? `--- unit stdout tail ---\n${stdoutTail}` : "",
    ].filter(Boolean);
    return { ...report, error: parts.join("\n\n") };
  }
  const finalText = lastAssistantText(stdout);
  if (!hasParseableReport(finalText)) {
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
  return report;
}
