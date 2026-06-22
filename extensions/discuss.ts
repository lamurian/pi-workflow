import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { WorkflowState } from "./state.ts";
import { transitionTo, updateUi, loadState } from "./state.ts";

/**
 * Type guard for assistant message content which can be either a plain string
 * or an array of content parts (e.g., [{ type: "text", text: "..." }]).
 */
interface ContentPart {
  type: string;
  text?: string;
  [key: string]: unknown;
}

/**
 * Start a discussion session about an issue, bug, chore, or small fix.
 *
 * The LLM acts as an engineer who:
 * 1. Clarifies the user's intention
 * 2. Proposes an implementation approach
 * 3. Iterates with user feedback
 * 4. Presents a finalized implementation strategy
 *
 * Unlike /brainstorm, /discuss does NOT write any files (ADRs, specs, plans).
 * The plan is streamed in the conversation session.
 * The user can then run `/implement` to execute the agreed plan.
 *
 * @param args - The topic or issue to discuss.
 * @param pi   - ExtensionAPI reference.
 * @param ctx  - Current extension context.
 */
export async function runDiscussion(
  args: string,
  pi: ExtensionAPI,
  ctx: ExtensionContext,
): Promise<void> {
  const topic = args.trim() || "Let's discuss this issue.";

  const state: WorkflowState = {
    phase: "discussing",
    specText: topic,
    adrFiles: [],
    specFiles: [],
    planFiles: [],
  };

  transitionTo(pi, state, "discussing");
  updateUi(state, ctx);

  ctx.ui.notify(
    "Starting discussion. I'll help clarify the issue and plan the implementation.",
    "info",
  );

  pi.sendUserMessage(topic, { deliverAs: "steer" });
}

/**
 * Get the content of the latest assistant (AI) message from the session.
 *
 * Used by `/implement` (when invoked without arguments) to pick up the
 * finalized plan that the AI presented at the end of a discussion.
 * This is more precise than `detectDiscussionTopic()`, which only returns
 * the initial topic text.
 *
 * Handles both plain-string content and array-of-parts content (the pi
 * SDK may deliver messages in either format). Array content is joined
 * into a single string by concatenating all text parts.
 *
 * @param ctx - Extension context with session manager access.
 * @returns The latest assistant message content, or empty string if none found.
 */
export function getLatestAssistantMessage(ctx: ExtensionContext): string {
  const entries = ctx.sessionManager.getBranch();
  for (let i = entries.length - 1; i >= 0; i--) {
    const entry = entries[i];
    if (entry.type === "message") {
      const msg = (entry as { message?: { role?: string; content?: unknown } }).message;
      if (msg && msg.role === "assistant" && msg.content != null) {
        // Handle plain string content
        if (typeof msg.content === "string") {
          return msg.content;
        }
        // Handle array content (e.g., [{ type: "text", text: "..." }])
        if (Array.isArray(msg.content)) {
          return (msg.content as ContentPart[])
            .filter((part) => part.type === "text" && typeof part.text === "string")
            .map((part) => part.text!)
            .join("\n");
        }
        return "";
      }
    }
  }
  return "";
}

/**
 * Detect whether a discussion topic exists in the session.
 *
 * Scans session entries for:
 * 1. A saved state entry with phase === "discussing" (primary) → returns specText
 * 2. The most recent user message that starts with /discuss (fallback) → returns
 *    the message content after the command
 * 3. Returns empty string if nothing found
 *
 * This ensures /implement can detect a discussion even if the custom state
 * entry is on a different branch path or was lost during compaction.
 *
 * @param ctx - Extension context with session manager access.
 * @returns The discussion topic, or empty string if none found.
 */
export function detectDiscussionTopic(ctx: ExtensionContext): string {
  // 1. Try saved state first
  const state = loadState(ctx);
  if (state && state.phase === "discussing" && state.specText) {
    return state.specText;
  }

  // 2. Fallback: scan session for /discuss user message
  const entries = ctx.sessionManager.getBranch();
  for (let i = entries.length - 1; i >= 0; i--) {
    const entry = entries[i];
    if (entry.type === "message") {
      const msg = (entry as { message?: { role?: string; content?: unknown } }).message;
      if (msg && msg.role === "user" && typeof msg.content === "string") {
        const trimmed = msg.content.trim();
        if (trimmed.startsWith("/discuss ")) {
          return trimmed.slice("/discuss ".length).trim();
        }
        if (trimmed === "/discuss") {
          return "Let's discuss this issue.";
        }
      }
    }
  }

  // 3. Nothing found
  return "";
}
