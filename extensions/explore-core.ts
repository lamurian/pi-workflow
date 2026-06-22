import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { complete } from "@earendil-works/pi-ai";
import { loadContent, getPackageRoot } from "./utils.ts";
import {
  discoverEmbeddedAgents,
  mapWithConcurrencyLimit,
  runScoutSubprocess,
  type ScoutResult,
} from "./subagent-runner.ts";

// ─── Types ─────────────────────────────────────────────────────────────────────

/** A single search task produced by decomposition. */
export interface SearchTask {
  agent: string;
  task: string;
}

// ─── Constants ─────────────────────────────────────────────────────────────────

const MAX_PARALLEL_TASKS = 8;
const MAX_CONCURRENCY = 4;

// ─── Decomposition ─────────────────────────────────────────────────────────────

/**
 * Decompose an exploration instruction into parallel search tasks.
 *
 * Calls the current model with the `explore-decompose.md` system prompt to
 * generate 2-6 search tasks. If the response is not valid JSON, falls back
 * to a single generic search task using the original instruction.
 *
 * @param instruction - The user's exploration instruction.
 * @param ctx         - Extension context (provides model and auth).
 * @param signal      - Optional abort signal.
 * @returns Array of search tasks.
 */
export async function decomposeInstruction(
  instruction: string,
  ctx: ExtensionContext,
  signal?: AbortSignal,
): Promise<SearchTask[]> {
  const systemPrompt = await loadContent("explore-decompose.md");

  if (!ctx.model) {
    return [{ agent: "scout", task: `Search the codebase for: ${instruction}` }];
  }

  const auth = await ctx.modelRegistry.getApiKeyAndHeaders(ctx.model);
  if (!auth.ok || !auth.apiKey) {
    return [{ agent: "scout", task: `Search the codebase for: ${instruction}` }];
  }

  const userMessage = {
    role: "user" as const,
    content: [{ type: "text" as const, text: instruction }],
    timestamp: Date.now(),
  };

  const response = await complete(
    ctx.model,
    { systemPrompt, messages: [userMessage] },
    { apiKey: auth.apiKey, headers: auth.headers, signal },
  );

  if (response.stopReason === "aborted" || response.stopReason === "error") {
    return [{ agent: "scout", task: `Search the codebase for: ${instruction}` }];
  }

  const text = response.content
    .filter((c): c is { type: "text"; text: string } => c.type === "text")
    .map((c) => c.text)
    .join("\n")
    .trim();

  if (!text) {
    return [{ agent: "scout", task: `Search the codebase for: ${instruction}` }];
  }

  try {
    const parsed = JSON.parse(text) as unknown[];
    if (!Array.isArray(parsed) || parsed.length === 0) {
      return [{ agent: "scout", task: `Search the codebase for: ${instruction}` }];
    }
    const tasks: SearchTask[] = [];
    for (const item of parsed) {
      if (item && typeof item === "object" && "agent" in item && "task" in item) {
        tasks.push({
          agent: String(item.agent),
          task: String(item.task),
      });
      }
    }
    return tasks.length > 0
      ? tasks.slice(0, MAX_PARALLEL_TASKS)
      : [{ agent: "scout", task: `Search the codebase for: ${instruction}` }];
  } catch {
    return [{ agent: "scout", task: `Search the codebase for: ${instruction}` }];
  }
}

// ─── Parallel execution ────────────────────────────────────────────────────────

/**
 * Run parallel exploration tasks by spawning scout subprocesses.
 *
 * Each task runs as a separate `pi --mode json -p --no-session` process
 * with the scout agent's model, tools, and system prompt.
 *
 * @param tasks     - Array of search tasks to execute.
 * @param _cwd      - Working directory for scout processes.
 * @param _signal   - Optional abort signal.
 * @param _onUpdate - Optional callback for streaming progress.
 * @returns Array of scout results.
 */
export async function runParallelExploration(
  tasks: SearchTask[],
  _cwd: string,
  _signal?: AbortSignal,
  _onUpdate?: (partial: ScoutResult[]) => void,
): Promise<ScoutResult[]> {
  if (tasks.length === 0) return [];

  const packageRoot = getPackageRoot();
  const agents = discoverEmbeddedAgents(packageRoot);
  const scout = agents.find((a) => a.name === "scout");
  if (!scout) {
    return tasks.map((t) => ({
      agent: t.agent,
      task: t.task,
      output: "",
      usage: { input: 0, output: 0, cost: 0, turns: 0 },
      exitCode: 1,
      errorMessage: "Scout agent not found in embedded agents",
    }));
  }

  // Pre-fill partial results with sentinel exitCode (-1 = not yet completed)
  const partialResults: ScoutResult[] = tasks.map((t) => ({
    agent: t.agent,
    task: t.task,
    output: "",
    usage: { input: 0, output: 0, cost: 0, turns: 0 },
    exitCode: -1,
  }));

  const results = await mapWithConcurrencyLimit(tasks, MAX_CONCURRENCY, async (task, index) => {
    try {
      const output = await runScoutSubprocess(scout, task.task, _cwd, _signal);
      const result: ScoutResult = {
        agent: task.agent,
        task: task.task,
        output,
        usage: { input: 0, output: 0, cost: 0, turns: 0 },
        exitCode: 0,
      };
      partialResults[index] = result;
      _onUpdate?.([...partialResults]);
      return result;
    } catch (err) {
      const result: ScoutResult = {
        agent: task.agent,
        task: task.task,
        output: "",
        usage: { input: 0, output: 0, cost: 0, turns: 0 },
        exitCode: 1,
        errorMessage: (err as Error).message,
      };
      partialResults[index] = result;
      _onUpdate?.([...partialResults]);
      return result;
    }
  });

  return results;
}

// ─── Synthesis ─────────────────────────────────────────────────────────────────

/**
 * Synthesize multiple scout results into a structured summary.
 *
 * Calls the current model with the `explore-synthesis.md` system prompt,
 * passing all scout outputs as context.
 *
 * @param instruction - The original exploration instruction.
 * @param results     - Array of scout results.
 * @param ctx         - Extension context (provides model and auth).
 * @param signal      - Optional abort signal.
 * @returns A formatted summary string.
 */
export async function synthesizeResults(
  instruction: string,
  results: ScoutResult[],
  ctx: ExtensionContext,
  signal?: AbortSignal,
): Promise<string> {
  const systemPrompt = await loadContent("explore-synthesis.md");

  if (!ctx.model) {
    return formatFallbackSummary(instruction, results);
  }

  const auth = await ctx.modelRegistry.getApiKeyAndHeaders(ctx.model);
  if (!auth.ok || !auth.apiKey) {
    return formatFallbackSummary(instruction, results);
  }

  const scoutOutputs = results
    .map(
      (r) =>
        `### Task: ${r.task}\nStatus: ${r.exitCode === 0 ? "success" : "failed"}${r.errorMessage ? ` (${r.errorMessage})` : ""}\n\n${r.output || "(no output)"}`,
    )
    .join("\n\n---\n\n");

  const userMessage = {
    role: "user" as const,
    content: [
      {
        type: "text" as const,
        text: `## Exploration Instruction\n${instruction}\n\n## Scout Results\n\n${scoutOutputs}`,
      },
    ],
    timestamp: Date.now(),
  };

  const response = await complete(
    ctx.model,
    { systemPrompt, messages: [userMessage] },
    { apiKey: auth.apiKey, headers: auth.headers, signal },
  );

  if (response.stopReason === "aborted" || response.stopReason === "error") {
    return formatFallbackSummary(instruction, results);
  }

  const text = response.content
    .filter((c): c is { type: "text"; text: string } => c.type === "text")
    .map((c) => c.text)
    .join("\n")
    .trim();

  return text || formatFallbackSummary(instruction, results);
}

/** Fallback summary when LLM is unavailable. */
function formatFallbackSummary(instruction: string, results: ScoutResult[]): string {
  const lines: string[] = [
    `## Summary`,
    `Exploration results for: ${instruction}`,
    ``,
    `## Key Files`,
  ];
  for (const r of results) {
    if (r.output) {
      const fileMatches = r.output.match(/`[^`]+`/g);
      if (fileMatches) {
        for (const f of fileMatches) {
          lines.push(`- ${f}`);
        }
      }
    }
    if (r.exitCode !== 0) {
      lines.push(
        `\n*Task "${r.task}" failed: ${r.errorMessage || `exit code ${r.exitCode}`}*`,
      );
    }
  }
  return lines.join("\n");
}

/**
 * Create a text-based loading indicator that writes to stderr.
 *
 * The spinner animates on its own interval. `update()` overwrites the
 * current line with a new spinner frame and message. `done()` clears
 * the interval and prints a final newline to release the line.
 *
 * @param _description - Label for the spinner (currently unused, reserved).
 * @returns Object with `update(text)` and `done()` methods.
 */
export function createLoader(_description: string) {
  let frame = 0;
  const frames = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
  let currentText = "";

  const tick = () => {
    frame = (frame + 1) % frames.length;
    if (currentText) {
      process.stderr.write(`\r${frames[frame]} ${currentText}`);
    }
  };

  const interval = setInterval(tick, 80);

  return {
    /** Update the loader text and redraw. */
    update(text: string) {
      currentText = text;
      process.stderr.write(`\r${frames[frame]} ${text}`);
    },
    /** Stop the loader and release the line. */
    done() {
      clearInterval(interval);
      if (currentText) {
        process.stderr.write(`\r${currentText}\n`);
      }
    },
  };
}
