import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { readFileSync } from "node:fs";
import { getActiveUnitClient, shutdownActiveClient } from "./unit-client-registry.ts";
import type { RpcImage } from "./rpc-unit-client.ts";
import type { Behavior } from "./state.ts";

// ─── Manual verification pause (T3) ───────────────────────────────────────────

/** An open manual-verification pause (one at a time; the loop runs one unit). */
export interface HitlWindow {
  /** Behavior awaiting verification, e.g. "T2". */
  behaviorId: string;
  /** The behavior's contract description (for persistence/steering context). */
  description: string;
  /** Resolves the pause promise when the user approves. */
  approve: () => void;
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
  await shutdownActiveClient(graceMs);
}

/** Rearm callback for the HITL clock (set while a timed pause is open). */
let hitlRearm: (() => void) | undefined;

/** Pending HITL timer, if armed. */
let hitlTimer: ReturnType<typeof setTimeout> | undefined;

/** Outcome of a verification pause: approval (false) or clock expiry (true). */
export interface PauseOutcome {
  /** True when the HITL clock expired before the user approved. */
  timedOut: boolean;
}

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
      resolve(outcome);
    };
    const arm = () => {
      if (hitlTimer) clearTimeout(hitlTimer);
      hitlTimer = setTimeout(() => {
        ctx.ui.notify(
          `${behavior.id} verification timed out — committing anyway; listed for manual check`,
          "warning",
        );
        settle({ timedOut: true });
      }, getHitlTimeoutMs());
    };
    hitlRearm = arm;
    arm();
    hitlWindow = {
      behaviorId: behavior.id,
      description: behavior.description,
      approve: () => settle({ timedOut: false }),
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
  ctx.ui.setStatus("implement", `✦ ${window.behaviorId}: feedback forwarded`);
}

/**
 * Guess an image mimeType from a file extension.
 *
 * @param path - The file path (or token) whose extension to inspect.
 * @returns The mimeType, or undefined for non-image extensions.
 */
export function imageMimeType(path: string): string | undefined {
  const ext = path.toLowerCase().split(".").pop();
  switch (ext) {
    case "png":
      return "image/png";
    case "jpg":
    case "jpeg":
      return "image/jpeg";
    case "gif":
      return "image/gif";
    case "webp":
      return "image/webp";
    default:
      return undefined;
  }
}

/**
 * Best-effort read of image file paths mentioned in a steer message.
 *
 * Whitespace-separated tokens with an image extension are read as base64
 * and attached; unreadable files are silently skipped (the text still
 * reaches the child either way).
 *
 * @param message - The steer message text.
 * @returns Attached images, possibly empty.
 */
export function readImageAttachments(message: string): RpcImage[] {
  const images: RpcImage[] = [];
  for (const token of message.split(/\s+/)) {
    const mimeType = imageMimeType(token);
    if (!mimeType) continue;
    try {
      const data = readFileSync(token).toString("base64");
      images.push({ type: "image", data, mimeType });
    } catch {
      // Unreadable path: skip; the message text still forwards.
    }
  }
  return images;
}

/**
 * Input policy for the orchestrated run: while a verification pause is open,
 * plain user text (plus pasted images) is consumed and forwarded to the live
 * child as a steer command; slash commands always reach the main agent, and
 * with no open window every input passes through.
 *
 * @param event - The user input event.
 * @returns `{ action: "handled" }` when forwarded; otherwise continue.
 */
export function handleWorkflowInput(
  event: { text: string; images?: Array<{ type: string; data: string; mimeType: string }> },
): { action: "handled" } | { action: "continue" } {
  const window = hitlWindow;
  const client = getActiveUnitClient();
  if (!window || !client || !client.isAlive()) return { action: "continue" };
  if (event.text.trim().startsWith("/")) return { action: "continue" };
  client.steer(event.text, (event.images ?? []) as RpcImage[]);
  resetHitlClock();
  return { action: "handled" };
}

/**
 * Register the orchestration input handler, replacing any prior registration.
 * cleanupOrchestration unregisters it on every exit path.
 *
 * @param pi - ExtensionAPI reference.
 */
export function registerWorkflowInputHandler(pi: ExtensionAPI): void {
  offInputHandler?.();
  offInputHandler = pi.on("input", async (event) => handleWorkflowInput(event));
}
