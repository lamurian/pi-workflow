import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { cancelVerificationPause, cleanupOrchestration } from "./hitl-pause.ts";

// ─── In-flight orchestration registry (B2: /discuss cancellation) ─────────────

/** True while a background orchestrated implementation is running. */
let inFlight = false;

/** Set by cancelOrchestration; checked at behavior-loop checkpoints. */
let cancelled = false;

/** Settlement promise of the current background run, when launched. */
let settledBackground: Promise<unknown> | undefined;

/** How long cancelOrchestration waits for the loop to settle (ms). */
export const CANCEL_AWAIT_TIMEOUT_MS = 3_000;

/**
 * Register a launched background orchestration.
 *
 * Marks the run in flight, resets the cancelled flag for the new run, and
 * keeps the settlement promise so cancelOrchestration can await it.
 *
 * @param settled - The background chain's settlement promise.
 */
export function beginOrchestration(settled: Promise<unknown>): void {
  inFlight = true;
  cancelled = false;
  settledBackground = settled;
}

/**
 * Clear the in-flight flag when the background run settles.
 *
 * Called from the background chain's finally so a later /implement
 * (or a fresh /discuss -> /implement cycle) starts cleanly.
 */
export function endOrchestration(): void {
  inFlight = false;
}

/**
 * Whether a background orchestrated implementation is currently running.
 *
 * @returns True while the background run has not settled yet.
 */
export function isOrchestrationInFlight(): boolean {
  return inFlight;
}

/**
 * Whether the current background run was cancelled via cancelOrchestration.
 *
 * Checked at behavior-loop checkpoints so kill-induced child errors after
 * a cancellation return a cancelled result instead of retrying.
 *
 * @returns True once cancellation has been requested for the current run.
 */
export function isOrchestrationCancelled(): boolean {
  return cancelled;
}

/**
 * Cancel the in-flight orchestrated implementation (B2: /discuss path).
 *
 * Sequence: set the cancelled flag, settle any open verification pause as
 * cancelled (resolving the loop's pause promise), shut down the live child
 * and unregister the input handler, then await the background run's
 * settlement (raced against a timeout) so every state write from the loop
 * finishes BEFORE the caller persists new workflow state.
 *
 * No-op when no orchestration is in flight.
 *
 * @param _ctx - Extension context (callers own UI feedback; kept for API symmetry).
 */
export async function cancelOrchestration(_ctx: ExtensionContext): Promise<void> {
  if (!inFlight) return;
  cancelled = true;
  cancelVerificationPause();
  await cleanupOrchestration();
  const settled = settledBackground;
  if (!settled) return;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<void>((resolve) => {
    timer = setTimeout(resolve, CANCEL_AWAIT_TIMEOUT_MS);
  });
  try {
    await Promise.race([
      settled.then(() => undefined, () => undefined),
      timeout,
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}
