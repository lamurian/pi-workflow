import type { RpcUnitClient } from "./rpc-unit-client.ts";

/** Timeout for the get_session_stats RPC probe (2 s per the T5 contract). */
export const SESSION_STATS_TIMEOUT_MS = 2_000;

/**
 * Read the child's current context-window usage percentage.
 *
 * Sends the `get_session_stats` RPC command with a 2 s timeout and narrows
 * the response to `data.contextUsage.percent`. Returns undefined when the
 * command fails, times out (the client resolves a failed response), rejects,
 * or the response carries no numeric `contextUsage.percent` (absent, null
 * post-compaction, or a non-number). Never throws.
 *
 * @param client - Live RPC client for the unit subprocess.
 * @returns The context usage percent, or undefined when unavailable.
 */
export async function readContextPercent(client: RpcUnitClient): Promise<number | undefined> {
  try {
    const res = await client.command({ type: "get_session_stats" }, SESSION_STATS_TIMEOUT_MS);
    if (!res.success) return undefined;
    const usage = (res.data as { contextUsage?: unknown } | undefined)?.contextUsage;
    if (typeof usage !== "object" || usage === null) return undefined;
    const percent = (usage as { percent?: unknown }).percent;
    return typeof percent === "number" ? percent : undefined;
  } catch {
    return undefined;
  }
}
