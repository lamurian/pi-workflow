import { spawn } from "node:child_process";
import {
  buildImplementerArgs,
  createTimeoutSignal,
  getPiInvocation,
  getImplementerTimeoutMs,
  parseImplementerReport,
  type ImplementerReport,
} from "./subagent-runner.ts";

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
 * Run one implementer unit subprocess and parse its structured report.
 *
 * Spawns `pi` with the implementer's lean argv, then parses the final
 * assistant message into `{ summary, suggestedCommit }`. A non-zero exit
 * yields an `error` field rather than throwing, so the orchestrator can
 * apply its retry policy uniformly. The error carries the captured stderr
 * (including named timeouts and spawn errors) plus a tail of stdout so the
 * retry prompt receives real diagnostic context.
 *
 * @param systemPrompt - Literal unit prompt text (from content/unit-prompt.md).
 * @param taskText     - The behavior slice for this unit.
 * @param cwd          - Working directory for the subprocess.
 * @param signal       - Optional parent abort signal.
 * @param timeoutMs    - Per-process timeout in ms.
 * @returns Parsed report, plus `error` when the unit failed.
 */
export async function runImplementerUnit(
  systemPrompt: string,
  taskText: string,
  cwd: string,
  signal?: AbortSignal,
  timeoutMs: number = getImplementerTimeoutMs(),
): Promise<ImplementerReport & { error?: string }> {
  const args = buildImplementerArgs(systemPrompt, taskText);
  const { stdout, stderr, exitCode } = await runRawPiProcess(args, cwd, signal, timeoutMs);
  const report = parseImplementerReport(stdout);
  if (exitCode !== 0) {
    const stdoutTail = stdout.trim().slice(-2000);
    const parts = [
      stderr.trim() || `implementer exited with code ${exitCode}`,
      stdoutTail ? `--- unit stdout tail ---\n${stdoutTail}` : "",
    ].filter(Boolean);
    return { ...report, error: parts.join("\n\n") };
  }
  return report;
}
