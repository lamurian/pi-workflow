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
