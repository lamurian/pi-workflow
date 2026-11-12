import type { RpcUnitClient } from "./rpc-unit-client.ts";

/**
 * Budget steer policy for one implementer unit (T3, write-check steer).
 *
 * Owns the three steer ratios, the steer messages, the write-tool predicate
 * and the timer arming. implementer-runner delegates here and re-exports
 * the progress/wrap-up constants for the existing import sites.
 */

/** Fraction of the per-unit time budget at which the write-check steer fires. */
export const WRITE_CHECK_RATIO = 0.4;

/** Fraction of the per-unit time budget at which the progress-check steer fires. */
export const PROGRESS_CHECK_RATIO = 0.5;

/** Fraction of the per-unit time budget at which the wrap-up steer fires. */
export const SOFT_DEADLINE_RATIO = 0.7;

/** Write-check steer delivered once at 40% of the budget when no write happened. */
export const NO_WRITE_STEER_MESSAGE =
  "40% of the time budget used and no write, edit or delete_file tool call seen yet: " +
  "start landing your changes on disk now, then keep going";

/** Progress-check steer delivered once at half the time budget. */
export const PROGRESS_STEER_MESSAGE =
  "progress check: half the time budget is used; focus on the remaining work " +
  "and plan to emit the JSON report before the deadline";

/**
 * Wrap-up steer delivered once when a unit nears its hard-kill deadline.
 *
 * Asks the unit to stop exploring, persist its work uncommitted, and emit
 * the JSON report with status partial, findings and nextSteps so a
 * continuation unit can pick up where it left off.
 */
export const WRAP_UP_STEER_MESSAGE =
  "time budget nearly exhausted: stop exploring, write what you have to disk, " +
  "emit the JSON report with status partial, findings, nextSteps";

/** Tool names whose call means the unit is writing to disk. */
const WRITE_TOOLS = new Set(["write", "edit", "delete_file"]);

/**
 * Whether an event carries a write, edit or delete_file tool call.
 *
 * Inspects assistant `message_end` events for `toolCall` (or `tool_use`)
 * content blocks naming one of the mutating file tools. Other events and
 * non-write tools never match.
 *
 * @param event - One parsed stdout event from the unit subprocess.
 * @returns True when the event records a write, edit or delete_file call.
 */
export function isWriteToolEvent(event: Record<string, unknown>): boolean {
  if (event.type !== "message_end") return false;
  const message = event.message as { role?: unknown; content?: unknown } | undefined;
  if (message?.role !== "assistant" || !Array.isArray(message.content)) return false;
  return message.content.some((block) => {
    if (typeof block !== "object" || block === null) return false;
    const b = block as { type?: unknown; name?: unknown; toolName?: unknown };
    if (b.type !== "toolCall" && b.type !== "tool_use") return false;
    return WRITE_TOOLS.has(String(b.name ?? b.toolName ?? ""));
  });
}

/** Handle over the armed steer timers for one attempt. */
export interface SteerTimers {
  /** Feed each stdout event; a write tool call disarms the pending write-check steer. */
  onEvent(event: Record<string, unknown>): void;
  /** Clear every armed steer timer (settle, exit or abort path). */
  clear(): void;
}

/**
 * Arm the budget steer timers for one attempt.
 *
 * With `timeoutMs > 0` arms three one-shot timers: the write-check steer at
 * 40% (suppressed once a write, edit or delete_file tool call has been
 * observed), the progress steer at 50%, and the wrap-up steer at 70%. All
 * are delivered as `prompt` commands with `streamingBehavior: "steer"`.
 * With `timeoutMs <= 0` nothing is armed.
 *
 * @param client   - The live unit client; only `prompt` is used.
 * @param timeoutMs - Per-process wall-clock budget in ms; 0 disables the timers.
 * @returns A handle whose `onEvent` records write activity and whose `clear`
 *          disarms all pending steer timers.
 */
export function armSteerTimers(
  client: Pick<RpcUnitClient, "prompt">,
  timeoutMs: number,
): SteerTimers {
  let writeSeen = false;
  const timers: ReturnType<typeof setTimeout>[] = [];
  if (timeoutMs > 0) {
    timers.push(
      setTimeout(() => {
        if (!writeSeen) client.prompt(NO_WRITE_STEER_MESSAGE, "steer");
      }, Math.floor(timeoutMs * WRITE_CHECK_RATIO)),
    );
    timers.push(
      setTimeout(
        () => client.prompt(PROGRESS_STEER_MESSAGE, "steer"),
        Math.floor(timeoutMs * PROGRESS_CHECK_RATIO),
      ),
    );
    timers.push(
      setTimeout(
        () => client.prompt(WRAP_UP_STEER_MESSAGE, "steer"),
        Math.floor(timeoutMs * SOFT_DEADLINE_RATIO),
      ),
    );
  }
  return {
    onEvent(event: Record<string, unknown>): void {
      if (isWriteToolEvent(event)) writeSeen = true;
    },
    clear(): void {
      for (const timer of timers) clearTimeout(timer);
    },
  };
}
