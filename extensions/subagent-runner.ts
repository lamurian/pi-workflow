import { spawn } from "node:child_process";
import { readFileSync, readdirSync, existsSync } from "node:fs";
import { join, resolve, basename } from "node:path";
import { parseFrontmatter } from "@earendil-works/pi-coding-agent";

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
  // Explicit override — lets tests (and embedders) pin a specific pi binary
  // instead of relying on script-detection heuristics.
  const piBin = process.env.PI_BIN;
  if (piBin) {
    return { command: piBin, args };
  }

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
    // Pin thinking low: the subprocess inherits the user's default thinking
    // level (often "high"), which is the dominant scout latency driver.
    "--thinking", "minimal",
  ];

  // Intentionally omit --model: use user's default model for speed and simplicity
  // agent.model is ignored

  if (agent.tools && agent.tools.length > 0) {
    args.push("--tools", agent.tools.join(","));
  }

  if (agent.systemPrompt.trim()) {
    // --append-system-prompt takes literal TEXT (verified in pi's CLI arg
    // parser) — pass the prompt directly, no temp file indirection.
    args.push("--append-system-prompt", agent.systemPrompt);
  }

  args.push(`Task: ${task}`);
  return args;
}

// ─── Scout subprocess execution ────────────────────────────────────────────────

/**
 * Default per-scout timeout in milliseconds. Scouts that exceed this are
 * killed and reported as failed (never as silent success).
 */
const DEFAULT_SCOUT_TIMEOUT_MS = 120_000;

/**
 * Resolve the per-scout timeout budget, honoring the `PI_EXPLORE_TIMEOUT_MS`
 * environment variable override (milliseconds). Invalid or missing values fall
 * back to {@link DEFAULT_SCOUT_TIMEOUT_MS}.
 *
 * @param env - Environment map (defaults to `process.env`); injectable for tests.
 * @returns The timeout in milliseconds (&gt; 0).
 */
export function getScoutTimeoutMs(
  env: Record<string, string | undefined> = process.env,
): number {
  const raw = env.PI_EXPLORE_TIMEOUT_MS;
  if (raw) {
    const parsed = Number(raw);
    if (Number.isFinite(parsed) && parsed > 0) return parsed;
  }
  return DEFAULT_SCOUT_TIMEOUT_MS;
}

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
 * @param timeoutMs- Per-process timeout in ms. 0 = no timeout.
 * @returns The final text output from the scout.
 */
export async function runScoutSubprocess(
  agent: AgentConfig,
  task: string,
  cwd: string,
  signal?: AbortSignal,
  timeoutMs: number = getScoutTimeoutMs(),
): Promise<string> {
  const args: string[] = buildScoutArgs(agent, task);
  let timeoutClear: (() => void) | null = null;

  try {
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

      proc.on("close", (code, signal) => {
        if (buffer.trim()) processLine(buffer);
        // A signal kill (timeout/abort) yields code=null. Masking it as 0
        // turns killed scouts into silent "success" with no output —
        // report it as a failure instead.
        resolvePromise(code ?? (signal ? 1 : 0));
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
      // Prefer the timeout/abort reason so the error message is descriptive
      // (e.g. "Operation timed out after 120000ms") instead of a bare exit code.
      const reason = killSignal?.reason;
      throw new Error(
        reason instanceof Error
          ? reason.message
          : stderr || `Process exited with code ${exitCode}`,
      );
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
  }
}

// ─── Implementer subprocess (orchestrator units) ─────────────────────────────

/** Tools granted to an implementer subprocess: filesystem + bash only. */
const IMPLEMENTER_TOOLS = "write,edit,bash";

/** Structured report extracted from an implementer subprocess output. */
export interface ImplementerReport {
  /** One or two sentences on what the unit changed and how it verified. */
  summary: string;
  /** Conventional commit subject suggested by the unit (no behavior id). */
  suggestedCommit?: string;
}

/**
 * Build the argv array for an implementer subprocess.
 *
 * Lean flags skip extension/skill/session loading for fast startup and
 * determinism. Tools are restricted to write/edit/bash — the unit cannot
 * commit or touch workflow state; the orchestrator owns both. Does NOT
 * pass --model so the subprocess uses the user's default model.
 *
 * @param systemPrompt - Literal unit prompt text (from content/unit-prompt.md).
 * @param taskText     - The behavior slice for this unit.
 * @returns Array of CLI arguments for the implementer subprocess.
 */
export function buildImplementerArgs(
  systemPrompt: string,
  taskText: string,
): string[] {
  const args: string[] = [
    "--mode", "json",
    "-p",
    "--no-session",
    "--no-extensions",
    "--no-skills",
    "--offline",
    "--thinking", "minimal",
    "--tools", IMPLEMENTER_TOOLS,
  ];
  if (systemPrompt.trim()) {
    args.push("--append-system-prompt", systemPrompt);
  }
  args.push(taskText);
  return args;
}

/**
 * Extract the last assistant text from JSON-mode event output.
 *
 * Malformed JSON lines (e.g. from a killed process) are skipped.
 *
 * @param stdout - Raw JSONL output from the subprocess.
 * @returns The last assistant message text, or "" when none parsed.
 */
function lastAssistantText(stdout: string): string {
  let last = "";
  for (const line of stdout.split("\n")) {
    if (!line.trim()) continue;
    try {
      const event = JSON.parse(line) as {
        type?: string;
        message?: { role?: string; content?: Array<{ type?: string; text?: string }> };
      };
      if (
        (event.type === "message_end" || event.type === "tool_result_end") &&
        event.message?.role === "assistant"
      ) {
        const parts = event.message.content
          ?.filter((c) => c.type === "text" && c.text)
          .map((c) => c.text as string);
        if (parts && parts.length > 0) last = parts.join("\n").trim();
      }
    } catch {
      // Skip malformed JSON lines (truncated writes from killed processes).
    }
  }
  return last;
}

/**
 * Parse implementer JSON-mode output into a structured report.
 *
 * Reads the final fenced ```json block from the last assistant message.
 * Tolerates malformed JSON lines and killed processes: when no block or
 * only a broken block is found, falls back to the whole message text (or
 * an empty summary). Never throws.
 *
 * @param stdout - Raw JSONL output from the implementer subprocess.
 * @returns The parsed report; `suggestedCommit` absent when unavailable.
 */
export function parseImplementerReport(stdout: string): ImplementerReport {
  const text = lastAssistantText(stdout);
  if (!text) return { summary: "" };
  const jsonMatch = text.match(/```json\s*([\s\S]*?)```/);
  if (jsonMatch) {
    try {
      const parsed = JSON.parse(jsonMatch[1]!) as Record<string, unknown>;
      if (typeof parsed.summary === "string") {
        return {
          summary: parsed.summary,
          ...(typeof parsed.suggestedCommit === "string"
            ? { suggestedCommit: parsed.suggestedCommit }
            : {}),
        };
      }
    } catch {
      // Broken JSON block — fall through to whole-message summary.
    }
  }
  return { summary: text.trim() };
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
