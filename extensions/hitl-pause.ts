import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { getActiveUnitClient, shutdownActiveClient } from "./unit-client-registry.ts";
import type { RpcImage } from "./rpc-unit-client.ts";
import type { Behavior } from "./state.ts";
import { armHitlTimer, armSteerWatchdog, disarmHitlClock, disarmSteerWatchdog, getHitlTimeoutMs, resetHitlClock, setHitlRearm } from "./hitl-clock.ts";
import { readImageAttachments } from "./hitl-images.ts";

// ─── Manual verification pause (T3) ───────────────────────────────────────────

/** An open manual-verification pause (one at a time; the loop runs one unit). */
export interface HitlWindow {
  /** Behavior awaiting verification, e.g. "T2". */
  behaviorId: string;
  /** The behavior's contract description (for persistence/steering context). */
  description: string;
  /** Resolves the pause promise when the user approves. */
  approve: () => void;
  /** Resolves the pause promise when the run is cancelled (B2). Optional so
   * existing test fixtures that only wire `approve` keep compiling. */
  cancel?: () => void;
}

let hitlWindow: HitlWindow | undefined;

/** Unsubscribe for the orchestration input handler (module scope so session
 * shutdown and halt paths can unregister it too). */
let offInputHandler: (() => void) | undefined;

/**
 * Tear down every orchestration artifact: input handler, pause window,
 * HITL clock, and any live implementer child (graceful abort, then
 * SIGKILL after a short grace). Idempotent; safe to call from session
 * shutdown, halt, and crash paths.
 *
 * @param graceMs - Grace period before the child's SIGKILL fallback.
 */
export async function cleanupOrchestration(graceMs: number = 1_000): Promise<void> {
  offInputHandler?.();
  offInputHandler = undefined;
  hitlWindow = undefined;
  disarmHitlClock();
  disarmSteerWatchdog();
  await shutdownActiveClient(graceMs);
}

/** Outcome of a verification pause: approval (false), clock expiry (true),
 * or cancellation (cancelled: true, B2 /discuss path). */
export interface PauseOutcome {
  /** True when the HITL clock expired before the user approved. */
  timedOut: boolean;
  /** True when the pause was settled by cancelOrchestration (B2). */
  cancelled?: boolean;
}

/**
 * Get the open verification pause, if any.
 *
 * @returns The current window, or undefined when no pause is open.
 */
export function getHitlWindow(): HitlWindow | undefined {
  return hitlWindow;
}

/**
 * Set (or clear with undefined) the open verification pause.
 *
 * @param window - The window handle, or undefined to clear.
 */
export function setHitlWindow(window: HitlWindow | undefined): void {
  hitlWindow = window;
}

/**
 * Cancel the open verification pause (B2: /discuss cancellation path).
 *
 * Unlike a plain clear, this RESOLVES the open pause promise with
 * `cancelled: true` so the behavior loop wakes up at its post-pause
 * checkpoint and returns a cancelled result instead of proceeding to the
 * commit gate. Disarms the HITL clock. Safe when no pause is open.
 *
 * @returns True when a window was open and has been cancelled.
 */
export function cancelVerificationPause(): boolean {
  const window = hitlWindow;
  if (!window) return false;
  hitlWindow = undefined;
  disarmHitlClock();
  disarmSteerWatchdog();
  if (window.cancel) window.cancel();
  else window.approve();
  return true;
}

/**
 * `/approve`: close the open verification pause so the loop may commit.
 *
 * With an open window: clears it and resolves the pause promise (the loop
 * then shuts the child down and commits through the gate). Outside a pause:
 * refuses with a warning and changes nothing.
 *
 * @param _pi - ExtensionAPI reference (unused; kept for symmetry/telemetry).
 * @param ctx - Extension context (UI access).
 */
export function runApprove(_pi: ExtensionAPI, ctx: ExtensionContext): void {
  const window = hitlWindow;
  if (!window) {
    ctx.ui.notify(
      "/approve is only valid during a manual verification pause — while a " +
        'kind:"manual" behavior awaits your check.',
      "warning",
    );
    return;
  }
  hitlWindow = undefined;
  disarmHitlClock();
  disarmSteerWatchdog();
  ctx.ui.notify(`${window.behaviorId} approved — committing.`, "info");
  window.approve();
}

/**
 * Open a verification pause for a manual behavior and wait for approval
 * or the HITL clock (PI_HITL_TIMEOUT_MS).
 *
 * Notifies the guidance line, sets the awaiting-verification status frame,
 * registers the window that /approve resolves, and arms the HITL clock.
 * The commit is deferred until the returned promise settles — either by
 * approval (`timedOut: false`) or clock expiry (`timedOut: true`, with a
 * warning notify). Successful steers reset the clock.
 *
 * @param ctx       - Extension context (UI access).
 * @param behavior  - The manual behavior awaiting verification.
 * @returns A promise resolving with how the pause ended.
 */
export function openVerificationPause(
  ctx: ExtensionContext,
  behavior: Behavior,
): Promise<PauseOutcome> {
  return new Promise<PauseOutcome>((resolve) => {
    const settle = (outcome: PauseOutcome) => {
      hitlWindow = undefined;
      disarmHitlClock();
      disarmSteerWatchdog();
      resolve(outcome);
    };
    const arm = () => {
      armHitlTimer(getHitlTimeoutMs(), () => {
        ctx.ui.notify(
          `${behavior.id} verification timed out — committing anyway; listed for manual check`,
          "warning",
        );
        settle({ timedOut: true });
      });
    };
    setHitlRearm(arm);
    arm();
    hitlWindow = {
      behaviorId: behavior.id,
      description: behavior.description,
      approve: () => settle({ timedOut: false }),
      cancel: () => settle({ timedOut: false, cancelled: true }),
    };
    ctx.ui.notify(
      `${behavior.id} awaiting manual verification — type feedback (auto-forwarded) or /steer <msg>, /approve`,
      "info",
    );
    ctx.ui.setStatus("implement", `✦ ${behavior.id}: awaiting verification`);
  });
}

/**
 * `/steer`: explicit text path into the verification pause.
 *
 * Forwards the message to the live child (best-effort: image file paths in
 * the args are read and attached) and emits the feedback status frame.
 * Refuses with a warning outside an open pause.
 *
 * @param message - The feedback text, possibly with image file path tokens.
 * @param pi      - ExtensionAPI reference.
 * @param ctx     - Extension context (UI access).
 */
export function runSteer(message: string, pi: ExtensionAPI, ctx: ExtensionContext): void {
  void pi;
  const window = hitlWindow;
  const client = getActiveUnitClient();
  if (!window || !client || !client.isAlive()) {
    ctx.ui.notify(
      "/steer is only valid during a verification pause — while a kind:\"manual\" " +
        "behavior awaits your check and its implementer subprocess is alive.",
      "warning",
    );
    return;
  }
  client.steer(message.trim(), readImageAttachments(message));
  resetHitlClock();
  ctx.ui.notify(`${window.behaviorId}: feedback forwarded to the implementer`, "info");
  armSteerWatchdog(ctx, window.behaviorId);
  ctx.ui.setStatus("implement", `✦ ${window.behaviorId}: feedback forwarded`);
}

/**
 * Input policy for the orchestrated run: while a verification pause is open,
 * plain user text (plus pasted images) is consumed and forwarded to the live
 * child as a steer command; slash commands always reach the main agent, and
 * with no open window every input passes through.
 *
 * Plain-text input during an open pause is never swallowed silently: a dead
 * child gets a warning notify before the text continues to the main agent,
 * and a live child gets a "feedback forwarded" notify plus the response
 * watchdog.
 *
 * @param event - The user input event.
 * @param ctx   - Extension context (UI access for the visibility notifies).
 * @returns `{ action: "handled" }` when forwarded; otherwise continue.
 */
export function handleWorkflowInput(
  event: { text: string; images?: Array<{ type: string; data: string; mimeType: string }> },
  ctx: ExtensionContext,
): { action: "handled" } | { action: "continue" } {
  const window = hitlWindow;
  if (!window) return { action: "continue" };
  if (event.text.trim().startsWith("/")) return { action: "continue" };
  const client = getActiveUnitClient();
  if (!client || !client.isAlive()) {
    ctx.ui.notify(
      `${window.behaviorId} implementer subprocess is no longer alive — ` +
        "your message reaches the main agent",
      "warning",
    );
    return { action: "continue" };
  }
  client.steer(event.text, (event.images ?? []) as RpcImage[]);
  resetHitlClock();
  ctx.ui.notify(`${window.behaviorId}: feedback forwarded to the implementer`, "info");
  armSteerWatchdog(ctx, window.behaviorId);
  return { action: "handled" };
}

/**
 * Register the orchestration input handler, replacing any prior registration.
 * cleanupOrchestration unregisters it on every exit path.
 *
 * @param pi - ExtensionAPI reference.
 * @param ctx - Extension context (UI access; forwards notify on steer).
 */
export function registerWorkflowInputHandler(pi: ExtensionAPI, ctx: ExtensionContext): void {
  offInputHandler?.();
  offInputHandler = pi.on("input", async (event) => handleWorkflowInput(event, ctx));
}
