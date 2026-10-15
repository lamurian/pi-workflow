import { spawn, type ChildProcess } from "node:child_process";
import { buildImplementerArgs, getPiInvocation } from "./subagent-runner.ts";

// ─── Types ─────────────────────────────────────────────────────────────────────

/** An image attachment in RPC ImageContent format. */
export interface RpcImage {
  type: "image";
  data: string;
  mimeType: string;
}

/** A correlated response to an RPC command (`type: "response"`). */
export interface RpcResponse {
  type?: string;
  command?: string;
  success?: boolean;
  error?: string;
  id?: string;
  data?: unknown;
}

/** Exit info surfaced exactly once per child. */
export interface RpcExitInfo {
  /** Process exit code; 1 when killed by signal or spawn failure. */
  code: number;
}

/** Options for spawning an RPC unit client. */
export interface RpcUnitClientOptions {
  /** Literal unit prompt text (from content/unit-prompt.md). */
  systemPrompt: string;
  /** Working directory for the subprocess. */
  cwd: string;
}

/**
 * Bidirectional client for one `pi --mode rpc` implementer subprocess.
 *
 * Owns the child process, strict JSONL stdin writes with unique command
 * ids, and incremental stdout event parsing. Completion and timeout
 * policy stay with the caller (implementer-runner).
 */
export interface RpcUnitClient {
  /** Send a command (JSONL line with a unique id); fire-and-forget. */
  send(command: Record<string, unknown>): void;
  /** Send a command and await its correlated response. */
  command(command: Record<string, unknown>, timeoutMs?: number): Promise<RpcResponse>;
  /** Deliver the task text as a `prompt` command on stdin. */
  prompt(message: string): void;
  /** Forward user feedback as a `steer` command (images supported). */
  steer(message: string, images?: RpcImage[]): void;
  /** Graceful shutdown: `abort` command + stdin close, SIGKILL fallback. */
  shutdown(graceMs?: number): Promise<void>;
  /** SIGKILL the child immediately. */
  kill(): void;
  /** Subscribe to stdout events; returns an unsubscribe function. */
  onEvent(listener: (event: Record<string, unknown>) => void): () => void;
  /** Subscribe to the child exit; fires immediately when already exited. */
  onExit(listener: (info: RpcExitInfo) => void): () => void;
  /** Raw stdout captured so far (JSONL, for report parsing/diagnostics). */
  rawStdout(): string;
  /** Raw stderr captured so far. */
  stderrText(): string;
  /** True while the child process has not exited. */
  isAlive(): boolean;
}

// ─── Spawn ─────────────────────────────────────────────────────────────────────

let commandSeq = 0;

/**
 * Spawn a `pi --mode rpc` implementer subprocess with the lean flag set.
 *
 * The child's stdin stays open for later `steer` commands; the task text
 * must be delivered via `client.prompt(...)`, not argv. Stdout is parsed
 * incrementally as strict JSONL (LF-delimited). Never throws — spawn
 * failures surface through the exit event with the error in stderr text.
 *
 * @param options - System prompt, cwd.
 * @returns A live client handle for the child process.
 */
export function spawnRpcUnitClient(options: RpcUnitClientOptions): RpcUnitClient {
  const args = buildImplementerArgs(options.systemPrompt);
  const invocation = getPiInvocation(args);
  const proc: ChildProcess = spawn(invocation.command, invocation.args, {
    cwd: options.cwd,
    shell: false,
    stdio: ["pipe", "pipe", "pipe"],
  });

  let raw = "";
  let stderrBuf = "";
  let buffer = "";
  let exited = false;
  let lastExitCode = 1;
  const eventListeners = new Set<(event: Record<string, unknown>) => void>();
  const exitListeners = new Set<(info: RpcExitInfo) => void>();
  const pending = new Map<string, (response: RpcResponse) => void>();

  const emitExit = (code: number): void => {
    if (exited) return;
    exited = true;
    lastExitCode = code;
    for (const listener of exitListeners) listener({ code });
    exitListeners.clear();
    for (const resolve of pending.values()) {
      resolve({ type: "response", success: false, error: "process exited", id: "" });
    }
    pending.clear();
  };

  const processLine = (line: string): void => {
    if (!line.trim()) return;
    raw += line + "\n";
    let event: unknown;
    try {
      event = JSON.parse(line);
    } catch {
      return; // Skip malformed JSON lines.
    }
    if (typeof event === "object" && event !== null) {
      const record = event as Record<string, unknown>;
      if (record.type === "response" && typeof record.id === "string") {
        const resolver = pending.get(record.id);
        if (resolver) {
          pending.delete(record.id);
          resolver(record as unknown as RpcResponse);
        }
      }
      for (const listener of eventListeners) listener(record);
    }
  };

  proc.stdout?.on("data", (data: Buffer) => {
    buffer += data.toString();
    const lines = buffer.split("\n");
    buffer = lines.pop() ?? "";
    for (const line of lines) processLine(line);
  });

  proc.stderr?.on("data", (data: Buffer) => {
    stderrBuf += data.toString();
  });

  proc.on("error", (err) => {
    const message = String((err as Error)?.message ?? err);
    stderrBuf += (stderrBuf && !stderrBuf.endsWith("\n") ? "\n" : "") + message;
    emitExit(1);
  });

  proc.on("exit", (code, signal) => {
    if (buffer.trim()) processLine(buffer);
    emitExit(code ?? (signal ? 1 : 0));
  });

  // Writing to a dead child's stdin raises EPIPE — never let it crash the host.
  proc.stdin?.on("error", () => {});

  const write = (command: Record<string, unknown>): string => {
    const id = `rpc-${++commandSeq}`;
    if (!exited && proc.stdin && !proc.stdin.destroyed) {
      try {
        // Strict JSONL: one JSON object per line, LF is the only delimiter.
        proc.stdin.write(JSON.stringify({ ...command, id }) + "\n");
      } catch {
        // Stream raced closed — the exit handler settles the caller.
      }
    }
    return id;
  };

  const onExit = (listener: (info: RpcExitInfo) => void): (() => void) => {
    if (exited) {
      listener({ code: lastExitCode });
      return () => {};
    }
    exitListeners.add(listener);
    return () => exitListeners.delete(listener);
  };

  const kill = (): void => {
    try {
      proc.kill("SIGKILL");
    } catch {
      // Already dead.
    }
    // Safety net: settle callers even if the exit event is somehow missed.
    setTimeout(() => emitExit(lastExitCode), 100);
  };

  return {
    send: (command) => {
      write(command);
    },
    command: (commandObj, timeoutMs = 30_000) =>
      new Promise<RpcResponse>((resolve) => {
        if (exited) {
          resolve({ type: "response", success: false, error: "process exited", id: "" });
          return;
        }
        const id = write(commandObj);
        const timer = setTimeout(() => {
          pending.delete(id);
          resolve({
            type: "response",
            success: false,
            error: `no response within ${timeoutMs}ms`,
            id,
          });
        }, timeoutMs);
        pending.set(id, (response) => {
          clearTimeout(timer);
          resolve(response);
        });
      }),
    prompt: (message) => {
      write({ type: "prompt", message });
    },
    steer: (message, images) => {
      write(images && images.length > 0 ? { type: "steer", message, images } : { type: "steer", message });
    },
    shutdown: async (graceMs = 2_000) => {
      if (exited) return;
      write({ type: "abort" });
      try {
        proc.stdin?.end();
      } catch {
        // Stream already closed.
      }
      await new Promise<void>((resolve) => {
        const unsub = onExit(() => {
          clearTimeout(timer);
          unsub();
          resolve();
        });
        const timer = setTimeout(() => {
          unsub();
          kill();
          // kill() settles the exit via the process exit event or its
          // safety-net timer — wait for it so isAlive() is false by the
          // time shutdown resolves.
          void new Promise<void>((done) => {
            const stop = onExit(() => {
              clearTimeout(safety);
              stop();
              done();
            });
            const safety = setTimeout(() => {
              stop();
              done();
            }, 1_000);
          }).then(resolve);
        }, graceMs);
      });
    },
    kill,
    onEvent: (listener) => {
      eventListeners.add(listener);
      return () => eventListeners.delete(listener);
    },
    onExit,
    rawStdout: () => raw,
    stderrText: () => stderrBuf,
    isAlive: () => !exited,
  };
}
