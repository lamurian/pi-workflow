import { existsSync } from "node:fs";
import { basename } from "node:path";

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

// ─── Subprocess invocation ────────────────────────────────────────────────────

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
