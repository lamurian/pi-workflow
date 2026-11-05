import { existsSync } from "node:fs";
import { basename } from "node:path";

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

/**
 * Format a session model as a canonical `provider/id` CLI reference.
 *
 * Spawned children (implementer units, scouts) receive this as `--model`
 * so they run on the session's model instead of the settings default;
 * pi resolves a canonical `provider/id` reference exactly, so no
 * `--provider` flag is needed.
 *
 * @param model - The session model (provider + id), or absent.
 * @returns `provider/id`, or undefined when no model is available.
 */
export function formatModelRef(
  model: { provider: string; id: string } | null | undefined,
): string | undefined {
  if (!model?.provider || !model.id) return undefined;
  return `${model.provider}/${model.id}`;
}

/**
 * Resolve how to invoke `pi` as a subprocess.
 *
 * Tries to detect the current script, then falls back to `pi` on PATH.
 */
export function getPiInvocation(args: string[]): { command: string; args: string[] } {
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

/**
 * Default per-implementer-unit timeout in milliseconds. Implementer units
 * read the codebase, write code, and self-check — far heavier than scouts,
 * which is why they get a dedicated budget instead of the scout timeout.
 */
const DEFAULT_IMPLEMENT_TIMEOUT_MS = 900_000;

/**
 * Resolve the per-implementer-unit timeout budget, honoring the
 * `PI_IMPLEMENT_TIMEOUT_MS` environment variable override (milliseconds).
 * Deliberately independent of `PI_EXPLORE_TIMEOUT_MS`: the scout budget
 * must not leak into implementation units.
 *
 * @param env - Environment map (defaults to `process.env`); injectable for tests.
 * @returns The timeout in milliseconds (&gt; 0).
 */
export function getImplementerTimeoutMs(
  env: Record<string, string | undefined> = process.env,
): number {
  const raw = env.PI_IMPLEMENT_TIMEOUT_MS;
  if (raw) {
    const parsed = Number(raw);
    if (Number.isFinite(parsed) && parsed > 0) return parsed;
  }
  return DEFAULT_IMPLEMENT_TIMEOUT_MS;
}

/** Ordered thinking levels; escalation floors only ever move up this ladder. */
const THINKING_LEVELS = ["minimal", "low", "medium", "high", "xhigh"];

/** Default thinking level for spawned children (supersedes the old `minimal` pins). */
const DEFAULT_THINKING = "low";

/**
 * Resolve the thinking level for a spawned child (implementer or scout).
 *
 * Reads `PI_IMPLEMENTER_THINKING` / `PI_SCOUT_THINKING` as the env base;
 * missing or invalid values fall back to `low`. When an escalation floor
 * is given (retry ladder), the result is the HIGHER of base and floor over
 * minimal &lt; low &lt; medium &lt; high &lt; xhigh — an escalation never
 * downgrades an explicitly pinned higher base.
 *
 * @param kind  - Which child: "implementer" or "scout".
 * @param floor - Optional escalation floor (e.g. "medium" on a retry spawn).
 * @param env   - Environment map (defaults to `process.env`); injectable for tests.
 * @returns One of minimal|low|medium|high|xhigh.
 */
export function resolveChildThinking(
  kind: "implementer" | "scout",
  floor?: string,
  env: Record<string, string | undefined> = process.env,
): string {
  const key = kind === "implementer" ? "PI_IMPLEMENTER_THINKING" : "PI_SCOUT_THINKING";
  const raw = env[key]?.trim();
  const base = raw && THINKING_LEVELS.includes(raw) ? raw : DEFAULT_THINKING;
  if (!floor) return base;
  const floorIdx = THINKING_LEVELS.indexOf(floor);
  if (floorIdx === -1) return base;
  return floorIdx > THINKING_LEVELS.indexOf(base) ? floor : base;
}

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
  const results = Array.from<TOut>({ length: items.length });
  let nextIndex = 0;

  const worker = async () => {
    while (true) {
      const current = nextIndex++;
      if (current >= items.length) return;
      results[current] = await fn(items[current], current);
    }
  };

  const workers = Array.from({ length: limit }, () => worker());
  await Promise.all(workers);
  return results;
}
