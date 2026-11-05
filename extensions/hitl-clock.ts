// The timeout budgets, the steer-response watchdog and the pause timer state,
// split out of hitl-pause.ts. The timer state is module-private and exposed
// through accessors (armHitlTimer, setHitlRearm) so the pause flow never
// touches it directly.

import type { ExtensionContext } from "@earendil-works/pi-coding-agent";

/** Rearm callback for the HITL clock (set while a timed pause is open). */
let hitlRearm: (() => void) | undefined;

/** Pending HITL timer, if armed. */
let hitlTimer: ReturnType<typeof setTimeout> | undefined;

/** Default HITL clock: 15 minutes of human time per pause. */
const DEFAULT_HITL_TIMEOUT_MS = 900_000;

/**
 * Resolve the HITL (human-verification) timeout budget.
 *
 * Independent of PI_IMPLEMENT_TIMEOUT_MS: that one bounds model activity,
 * this one bounds waiting for a human. Invalid or non-positive values fall
 * back to the default.
 *
 * @param env - Environment map (defaults to `process.env`); injectable for tests.
 * @returns The timeout in milliseconds (&gt; 0).
 */
export function getHitlTimeoutMs(
  env: Record<string, string | undefined> = process.env,
): number {
  const raw = env.PI_HITL_TIMEOUT_MS;
  if (raw) {
    const parsed = Number(raw);
    if (Number.isFinite(parsed) && parsed > 0) return parsed;
  }
  return DEFAULT_HITL_TIMEOUT_MS;
}

/** Default steer-response watchdog: 60 seconds of implementer silence. */
const DEFAULT_STEER_RESPONSE_TIMEOUT_MS = 60_000;

/**
 * Resolve the steer-response watchdog timeout.
 *
 * Bounds how long a forwarded steer may go without an implementer-activity
 * event before the watchdog notifies with recovery options. Invalid or
 * non-positive values fall back to the default.
 *
 * @param env - Environment map (defaults to `process.env`); injectable for tests.
 * @returns The timeout in milliseconds (&gt; 0).
 */
export function getSteerResponseTimeoutMs(
  env: Record<string, string | undefined> = process.env,
): number {
  const raw = env.PI_STEER_RESPONSE_TIMEOUT_MS;
  if (raw) {
    const parsed = Number(raw);
    if (Number.isFinite(parsed) && parsed > 0) return parsed;
  }
  return DEFAULT_STEER_RESPONSE_TIMEOUT_MS;
}

/** Pending steer-response watchdog (one verification pause at a time). */
let steerWatchdog: { behaviorId: string; timer: ReturnType<typeof setTimeout> } | undefined;

/**
 * Arm (or rearm) the steer-response watchdog after a successful forward.
 *
 * If no implementer-activity event for `behaviorId` arrives within
 * PI_STEER_RESPONSE_TIMEOUT_MS (default 60_000), a warning notify states
 * that the implementer has not responded and lists recovery options:
 * /approve to continue, or keep waiting for its response.
 *
 * @param ctx        - Extension context (UI access).
 * @param behaviorId - Behavior whose feedback was forwarded.
 */
export function armSteerWatchdog(ctx: ExtensionContext, behaviorId: string): void {
  disarmSteerWatchdog();
  const timer = setTimeout(() => {
    steerWatchdog = undefined;
    ctx.ui.notify(
      `${behaviorId}: the implementer has not responded to your feedback — ` +
        "recovery options: /approve to continue, or keep waiting for its response",
      "warning",
    );
  }, getSteerResponseTimeoutMs());
  steerWatchdog = { behaviorId, timer };
}

/**
 * Disarm a pending steer-response watchdog before it fires.
 *
 * Called on relayed implementer activity (behavior-matched) and on every
 * pause-closure path (approve, timeout, cancel, cleanup).
 *
 * @param behaviorId - When given, only disarm if the watchdog is armed for
 *                     this behavior; otherwise disarm whatever is pending.
 */
export function disarmSteerWatchdog(behaviorId?: string): void {
  if (!steerWatchdog) return;
  if (behaviorId !== undefined && steerWatchdog.behaviorId !== behaviorId) return;
  clearTimeout(steerWatchdog.timer);
  steerWatchdog = undefined;
}

/**
 * Clear the HITL timer and its rearm hook.
 *
 * Internal clock bookkeeping; exported for tests and cleanup paths.
 */
export function disarmHitlClock(): void {
  if (hitlTimer) clearTimeout(hitlTimer);
  hitlTimer = undefined;
  hitlRearm = undefined;
}

/**
 * Reset the HITL clock after user activity (a successful steer).
 *
 * No-op when no timed pause is open. Restarting on activity keeps an
 * engaged user from ever hitting the deferral while still bounding an
 * abandoned pause.
 */
export function resetHitlClock(): void {
  hitlRearm?.();
}

/**
 * Arm the pause timer, replacing any pending one (T12).
 *
 * The clock owns the timer state: the open-pause flow arms it with its
 * expiry callback instead of touching module state directly.
 *
 * @param ms     - Timeout in milliseconds.
 * @param onFire - Callback run when the clock expires.
 */
export function armHitlTimer(ms: number, onFire: () => void): void {
  if (hitlTimer) clearTimeout(hitlTimer);
  hitlTimer = setTimeout(onFire, ms);
}

/**
 * Record the rearm callback for the open pause (T12).
 *
 * Invoked by resetHitlClock after user activity; undefined when no timed
 * pause is open.
 *
 * @param arm - The rearm closure, or undefined to clear it.
 */
export function setHitlRearm(arm: (() => void) | undefined): void {
  hitlRearm = arm;
}
