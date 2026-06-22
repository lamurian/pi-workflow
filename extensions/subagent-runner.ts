import { spawn } from "node:child_process";
import { readFileSync, readdirSync, unlinkSync, rmdirSync, existsSync } from "node:fs";
import { readFile, writeFile, mkdtemp } from "node:fs/promises";
import { join, resolve, basename, dirname } from "node:path";
import { tmpdir } from "node:os";
import { parseFrontmatter, withFileMutationQueue } from "@earendil-works/pi-coding-agent";

// ─── Types ─────────────────────────────────────────────────────────────────────

/** Configuration for a subagent. */
export interface AgentConfig {
  name: string;
  description: string;
  tools?: string[];
  model?: string;
  systemPrompt: string;
  source: "embedded" | "user" | "project";
  filePath: string;
}

/** Result from a single scout process execution. */
export interface ScoutResult {
  agent: string;
  task: string;
  output: string;
  usage: { input: number; output: number; cost: number; turns: number };
  exitCode: number;
  errorMessage?: string;
}

// ─── Agent discovery ───────────────────────────────────────────────────────────

/**
 * Discover agents embedded in the extension's content/agents/ directory.
 *
 * Reads all `.md` files from `<packageRoot>/content/agents/`, parses their
 * YAML frontmatter, and returns AgentConfig entries.
 *
 * @param packageRoot - Absolute path to the extension package root.
 * @returns Array of discovered agent configurations.
 */
export function discoverEmbeddedAgents(packageRoot: string): AgentConfig[] {
  const agentsDir = resolve(packageRoot, "content", "agents");
  const agents: AgentConfig[] = [];

  let dirEntries;
  try {
    dirEntries = readdirSync(agentsDir, { withFileTypes: true });
  } catch {
    return agents;
  }

  for (const entry of dirEntries) {
    if (!entry.name.endsWith(".md")) continue;
    if (!entry.isFile() && !entry.isSymbolicLink()) continue;

    const filePath = join(agentsDir, entry.name);
    let content: string;
    try {
      content = readFileSync(filePath, "utf-8");
    } catch {
      continue;
    }

    const { frontmatter, body } = parseFrontmatter<Record<string, string>>(content);
    if (!frontmatter.name || !frontmatter.description) {
      continue;
    }

    const tools = frontmatter.tools
      ?.split(",")
      .map((t: string) => t.trim())
      .filter(Boolean);

    agents.push({
      name: frontmatter.name,
      description: frontmatter.description,
      tools: tools && tools.length > 0 ? tools : undefined,
      model: frontmatter.model || undefined,
      systemPrompt: body,
      source: "embedded",
      filePath,
    });
  }

  return agents;
}

// ─── Subprocess invocation ────────────────────────────────────────────────────

/**
 * Resolve how to invoke `pi` as a subprocess.
 *
 * Tries to detect the current script, then falls back to `pi` on PATH.
 */
// ─── Timeout signal ─────────────────────────────────────────────────────────────

/**
 * Create an AbortSignal that fires after a timeout, optionally combined with
 * a parent signal (e.g., from the caller). Whichever fires first wins.
 *
 * Returns a `clear` function to cancel the timeout before it fires.
 * Always call `clear()` when the operation completes to avoid timer leaks.
 *
 * @param timeoutMs    - Milliseconds before the signal aborts.
 * @param parentSignal - Optional parent signal to combine.
 * @returns Object with `signal` (AbortSignal) and `clear()` function.
 */
export function createTimeoutSignal(
  timeoutMs: number,
  parentSignal?: AbortSignal,
): { signal: AbortSignal; clear: () => void } {
  const controller = new AbortController();

  const timeoutId = setTimeout(() => {
    controller.abort(new Error(`Operation timed out after ${timeoutMs}ms`));
  }, timeoutMs);

  const clear = () => {
    clearTimeout(timeoutId);
  };

  if (parentSignal) {
    if (parentSignal.aborted) {
      clearTimeout(timeoutId);
      controller.abort(parentSignal.reason);
    } else {
      parentSignal.addEventListener(
        "abort",
        () => {
          clearTimeout(timeoutId);
          controller.abort(parentSignal.reason);
        },
        { once: true },
      );
    }
  }

  return { signal: controller.signal, clear };
}

function getPiInvocation(args: string[]): { command: string; args: string[] } {
  const currentScript = process.argv[1];
  const isBunVirtualScript = currentScript?.startsWith("/$bunfs/root/");
  if (currentScript && !isBunVirtualScript && existsSync(currentScript)) {
    return { command: process.execPath, args: [currentScript, ...args] };
  }

  const execName = basename(process.execPath).toLowerCase();
  const isGenericRuntime = /^(node|bun)(\.exe)?$/.test(execName);
  if (!isGenericRuntime) {
    return { command: process.execPath, args };
  }

  return { command: "pi", args };
}

// ─── Scout args builder ──────────────────────────────────────────────────────────

/**
 * Build the argv array for the scout subprocess.
 *
 * Uses lean flags to skip extension/skill/context loading for fast startup.
 * Does NOT pass --model so the subprocess uses the user's default model.
 *
 * @param agent - Agent configuration (determines tools and system prompt).
 * @param task  - The exploration task to execute.
 * @returns Array of CLI arguments for the scout subprocess.
 */
export function buildScoutArgs(agent: AgentConfig, task: string): string[] {
  const args: string[] = [
    "--mode", "json", "-p", "--no-session",
    "--no-extensions", "--no-skills", "--no-context-files", "--offline",
  ];

  // Intentionally omit --model: use user's default model for speed and simplicity
  // agent.model is ignored

  if (agent.tools && agent.tools.length > 0) {
    args.push("--tools", agent.tools.join(","));
  }

  if (agent.systemPrompt.trim()) {
    // System prompt is passed via --append-system-prompt with a temp file path
    // (the caller must resolve the path before calling this function)
    args.push("--append-system-prompt");
    // The prompt file path is appended separately by runScoutSubprocess after
    // writing the temp file
  }

  args.push(`Task: ${task}`);
  return args;
}

// ─── Scout subprocess execution ────────────────────────────────────────────────

/**
 * Write the agent's system prompt to a temporary file.
 *
 * @param agentName - Name of the agent (for safe filename).
 * @param prompt    - The system prompt content.
 * @returns The temp dir and file path.
 */
async function writePromptToTempFile(
  agentName: string,
  prompt: string,
): Promise<{ dir: string; filePath: string }> {
  const tmpDir = await mkdtemp(join(tmpdir(), "pi-explore-"));
  const safeName = agentName.replace(/[^\w.-]+/g, "_");
  const filePath = join(tmpDir, `prompt-${safeName}.md`);
  await withFileMutationQueue(filePath, async () => {
    await writeFile(filePath, prompt, { encoding: "utf-8", mode: 0o600 });
  });
  return { dir: tmpDir, filePath };
}

/** Default timeout for a single scout subprocess, in milliseconds. */
const DEFAULT_SCOUT_TIMEOUT_MS = 60_000;

/**
 * Run a single scout subprocess and return the text output.
 *
 * Spawns `pi` (with lean flags) with the agent's tool set and system
 * prompt, then parses JSON events to extract the assistant's final text.
 *
 * The subprocess is killed if it does not complete within `timeoutMs`.
 *
 * @param agent    - Agent configuration (scout).
 * @param task     - The exploration task to execute.
 * @param cwd      - Working directory for the subprocess.
 * @param signal   - Optional abort signal to kill the subprocess.
 * @param timeoutMs- Per-process timeout in ms (default 60s). 0 = no timeout.
 * @returns The final text output from the scout.
 */
export async function runScoutSubprocess(
  agent: AgentConfig,
  task: string,
  cwd: string,
  signal?: AbortSignal,
  timeoutMs: number = DEFAULT_SCOUT_TIMEOUT_MS,
): Promise<string> {
  const args: string[] = buildScoutArgs(agent, task);

  let tmpPromptDir: string | null = null;
  let tmpPromptPath: string | null = null;
  let timeoutClear: (() => void) | null = null;

  try {
    if (agent.systemPrompt.trim()) {
      const tmp = await writePromptToTempFile(agent.name, agent.systemPrompt);
      tmpPromptDir = tmp.dir;
      tmpPromptPath = tmp.filePath;
      // Insert --append-system-prompt before the Task positional arg at the end
      args.splice(args.length - 1, 0, "--append-system-prompt", tmpPromptPath);
    }

    // Create combined timeout + parent signal
    let killSignal: AbortSignal | undefined = signal;
    if (timeoutMs > 0) {
      const combined = createTimeoutSignal(timeoutMs, signal);
      killSignal = combined.signal;
      timeoutClear = combined.clear;
    }

    const messages: Array<{ role: string; content: Array<{ type: string; text?: string }> }> = [];
    let stderr = "";

    const exitCode = await new Promise<number>((resolvePromise) => {
      const invocation = getPiInvocation(args);
      const proc = spawn(invocation.command, invocation.args, {
        cwd,
        shell: false,
        stdio: ["ignore", "pipe", "pipe"],
      });


      let buffer = "";

      const processLine = (line: string) => {
        if (!line.trim()) return;
        try {
          const event = JSON.parse(line);
          if (event.type === "message_end" && event.message) {
            messages.push(event.message);
          }
          if (event.type === "tool_result_end" && event.message) {
            messages.push(event.message);
          }
        } catch {
          // Skip malformed JSON lines
        }
      };

      proc.stdout.on("data", (data: Buffer) => {
        buffer += data.toString();
        const lines = buffer.split("\n");
        buffer = lines.pop() || "";
        for (const line of lines) processLine(line);
      });

      proc.stderr.on("data", (data: Buffer) => {
        stderr += data.toString();
      });

      proc.on("close", (code) => {
        if (buffer.trim()) processLine(buffer);
        resolvePromise(code ?? 0);
      });

      proc.on("error", () => {
        resolvePromise(1);
      });

      // Wire up combined kill signal (timeout + parent abort)
      if (killSignal) {
        const killProc = () => {
          // Use SIGKILL directly (no SIGTERM + backup timer) to avoid
          // a race condition: SIGTERM can be sent before the subprocess
          // has fully started, causing the signal to be missed. When
          // that happens, the subprocess runs until the 5-second backup
          // SIGKILL fires — and the process handle keeps the event loop
          // alive during that window, hanging the test suite for ~35s.
          // SIGKILL is always delivered and kills immediately.
          proc.kill("SIGKILL");
        };
        if (killSignal.aborted) {
          // SIGKILL immediately. The process doesn't need to be
          // initialized first — SIGKILL delivered before execve
          // is handled when the process starts.
          killProc();
        } else {
          killSignal.addEventListener("abort", killProc, { once: true });
        }
      }
    });

    if (exitCode !== 0 && messages.length === 0) {
      throw new Error(stderr || `Process exited with code ${exitCode}`);
    }

    // Extract final text from the last assistant message
    for (let i = messages.length - 1; i >= 0; i--) {
      const msg = messages[i];
      if (msg.role === "assistant") {
        const textParts = msg.content
          .filter((c) => c.type === "text" && c.text)
          .map((c) => c.text);
        if (textParts.length > 0) {
          return textParts.join("\n").trim();
        }
      }
    }

    return stderr || "(no output)";
  } finally {
    timeoutClear?.();
    if (tmpPromptPath) {
      try { unlinkSync(tmpPromptPath); } catch { /* ignore */ }
    }
    if (tmpPromptDir) {
      try { rmdirSync(tmpPromptDir); } catch { /* ignore */ }
    }
  }
}

// ─── Concurrency limiter ───────────────────────────────────────────────────────

/**
 * Run an async function over an array of items with a maximum concurrency limit.
 *
 * Tasks are dispatched up to `concurrency` at a time. Results are returned
 * in the same order as the input array.
 *
 * @param items       - Array of input items.
 * @param concurrency - Maximum number of concurrent async operations.
 * @param fn          - Async function to apply to each item.
 * @returns Promise resolving to an array of results in input order.
 */
export async function mapWithConcurrencyLimit<TIn, TOut>(
  items: TIn[],
  concurrency: number,
  fn: (item: TIn, index: number) => Promise<TOut>,
): Promise<TOut[]> {
  if (items.length === 0) return [];
  const limit = Math.max(1, Math.min(concurrency, items.length));
  const results: TOut[] = new Array(items.length);
  let nextIndex = 0;

  const worker = async () => {
    while (true) {
      const current = nextIndex++;
      if (current >= items.length) return;
      results[current] = await fn(items[current], current);
    }
  };

  const workers = new Array(limit).fill(null).map(() => worker());
  await Promise.all(workers);
  return results;
}
