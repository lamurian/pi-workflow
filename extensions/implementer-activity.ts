import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

// ─── Zero-token activity relay (T2) ─────────────────────────────────────────────

/** Data persisted for one relayed implementer activity entry. */
export interface ImplementerActivityData {
  /** Behavior the activity belongs to, e.g. "T2". */
  behaviorId: string;
  /** Activity flavor: a completed turn, an assistant message, or a status query. */
  kind: "turn" | "assistant" | "status";
  /** Relayed text: full assistant milestone text, or a compact turn summary. */
  text: string;
  /** ISO timestamp of the relay. */
  at: string;
}

/** Transcript-line budget for formatImplementerActivity. */
export const RELAY_TEXT_LIMIT = 200;

/**
 * Format one activity entry as a compact transcript line.
 *
 * @param data - The persisted activity entry.
 * @returns A single line: `<behaviorId> <kind>: <text>`, truncated with "…".
 */
export function formatImplementerActivity(data: ImplementerActivityData): string {
  const text =
    data.text.length > RELAY_TEXT_LIMIT
      ? data.text.slice(0, RELAY_TEXT_LIMIT) + "…"
      : data.text;
  return `${data.behaviorId} ${data.kind}: ${text}`;
}

/**
 * Extract concatenated text blocks from a message content array.
 *
 * @param content - The message content (array of content blocks, or anything else).
 * @returns The joined, trimmed text of all text blocks, or "" when none.
 */
export function extractTextContent(content: unknown): string {
  if (!Array.isArray(content)) return "";
  return content
    .filter(
      (block): block is { type: string; text: string } =>
        typeof block === "object" &&
        block !== null &&
        (block as { type?: unknown }).type === "text" &&
        typeof (block as { text?: unknown }).text === "string",
    )
    .map((block) => block.text)
    .join("\n")
    .trim();
}

/**
 * Best-effort compact description of a completed turn.
 *
 * @param event - One parsed stdout event from the child (turn_end).
 * @returns "working with tools…" when the turn used tools, else "responding…".
 */
export function summarizeTurn(event: Record<string, unknown>): string {
  const message = event.message as { content?: unknown } | undefined;
  const blocks = Array.isArray(message?.content) ? message.content : [];
  const tools = blocks.filter(
    (block) =>
      typeof block === "object" &&
      block !== null &&
      /tool/i.test(String((block as { type?: unknown }).type ?? "")),
  );
  return tools.length > 0 ? "working with tools…" : "responding…";
}

/**
 * Persist one activity entry (custom entries are never sent to the LLM).
 *
 * @param pi   - ExtensionAPI reference.
 * @param data - The persisted activity entry.
 */
export function persistActivity(pi: ExtensionAPI, data: ImplementerActivityData): void {
  pi.appendEntry("implementer-activity", data);
}

/**
 * Relay one implementer stdout event into the main session at zero token cost.
 *
 * turn_end drives the footer status line; assistant message_end events emit a
 * milestone notification with the complete message text. Both are persisted as
 * `implementer-activity` custom entries (not sent to the model). User-role
 * messages and other event types are ignored.
 *
 * @param pi         - ExtensionAPI reference.
 * @param ctx        - Extension context (UI access).
 * @param behaviorId - Behavior the child is implementing.
 * @param position   - Loop position string, e.g. "1/2".
 * @param event      - One parsed stdout event from the child.
 */
export function relayImplementerEvent(
  pi: ExtensionAPI,
  ctx: ExtensionContext,
  behaviorId: string,
  position: string,
  event: Record<string, unknown>,
): void {
  if (event.type === "turn_end") {
    const compact = summarizeTurn(event);
    ctx.ui.setStatus("implement", `✦ ${behaviorId} (${position}): ${compact}`);
    persistActivity(pi, { behaviorId, kind: "turn", text: compact, at: new Date().toISOString() });
    return;
  }
  if (event.type === "message_end") {
    const message = event.message as { role?: string; content?: unknown } | undefined;
    if (message?.role !== "assistant") return;
    const text = extractTextContent(message.content);
    if (!text) return;
    ctx.ui.notify(`${behaviorId}: ${text}`, "info");
    persistActivity(pi, { behaviorId, kind: "assistant", text, at: new Date().toISOString() });
  }
}
