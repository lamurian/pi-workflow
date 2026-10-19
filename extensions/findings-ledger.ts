/**
 * Shared findings ledger (pure logic).
 *
 * Unit attempts report reusable facts ("findings") in their JSON report.
 * The orchestrator appends them to a ledger on the workflow state, shared
 * across ALL behaviors of the task, and renders the ledger into every
 * subsequent unit task text. The ledger is capped at the most recent
 * {@link MAX_FINDINGS} entries, deduplicated by exact text, cleared when
 * orchestration completes, and kept across halts/resumes.
 *
 * The module also provides the T5 tool-call digest: a collector fed the
 * same stdout events the relay receives records tool calls from assistant
 * message content (tool name + path for read/write/edit, command head for
 * bash truncated to {@link TOOL_DIGEST_MAX_CHARS} chars). When an attempt
 * times out or ends without a parseable report, the orchestrator appends
 * the rendered digest as a finding so the next attempt does not re-read
 * blindly.
 */

/** One recorded finding, tagged with the behavior whose unit reported it. */
export interface Finding {
  /** Behavior id of the reporting unit, e.g. "T1". */
  behaviorId: string;
  /** The reusable fact text (exact-match dedup key). */
  text: string;
}

/** Maximum number of ledger entries kept; the oldest are evicted. */
export const MAX_FINDINGS = 40;

/** Heading rendered above the ledger in unit task texts. */
export const FINDINGS_SECTION_HEADING = "## Known findings from earlier units";

/**
 * Append findings to the ledger with exact-text dedup and a recency cap.
 *
 * Whitespace-only texts are dropped. A text already present in the ledger
 * (from any behavior) is skipped — the original reporter keeps ownership.
 * When new entries land, the ledger is truncated to the {@link MAX_FINDINGS}
 * most recent entries (oldest evicted first).
 *
 * @param ledger     - The current ledger (unmutated).
 * @param behaviorId - Behavior id of the reporting unit.
 * @param texts      - Raw finding texts from the unit report.
 * @returns The resulting ledger and whether anything new was added.
 */
export function appendFindings(
  ledger: Finding[],
  behaviorId: string,
  texts: string[],
): { ledger: Finding[]; changed: boolean } {
  const seen = new Set(ledger.map((entry) => entry.text));
  const added: Finding[] = [];
  for (const raw of texts) {
    const text = typeof raw === "string" ? raw.trim() : "";
    if (!text || seen.has(text)) continue;
    seen.add(text);
    added.push({ behaviorId, text });
  }
  if (added.length === 0) return { ledger, changed: false };
  const next = [...ledger, ...added];
  return {
    ledger: next.length > MAX_FINDINGS ? next.slice(next.length - MAX_FINDINGS) : next,
    changed: true,
  };
}

/**
 * Render the ledger as a task-text section.
 *
 * @param ledger - The current ledger, or undefined when none exists.
 * @returns A markdown section listing every entry as `- [behaviorId] text`,
 *          or an empty string for a missing or empty ledger.
 */
export function renderFindingsSection(ledger: Finding[] | undefined): string {
  if (!ledger || ledger.length === 0) return "";
  const lines = ledger.map((entry) => `- [${entry.behaviorId}] ${entry.text}`);
  return `\n\n${FINDINGS_SECTION_HEADING}\n\n${lines.join("\n")}\n`;
}

// ─── Tool-call digest (T5) ────────────────────────────────────────────────────

/** Maximum characters kept from a bash command head in the digest. */
export const TOOL_DIGEST_MAX_CHARS = 120;

/** Maximum number of deduped tool-call entries kept per digest collector. */
export const TOOL_DIGEST_MAX_ENTRIES = 20;

/** Prefix of the rendered digest finding text. */
export const TOOL_DIGEST_PREFIX = "previous attempt touched:";

/** One recorded tool call: a file path or a truncated bash command head. */
export interface ToolCallEntry {
  /** Tool name, e.g. "read", "write", "edit", "bash". */
  tool: string;
  /** File path for path tools; command head (<= 120 chars) for bash. */
  detail: string;
}

/** Collector fed the same stdout events the relay receives. */
export interface ToolCallCollector {
  /** Record tool calls from one assistant message_end event (others ignored). */
  record(event: Record<string, unknown>): void;
  /** Deduped entries in first-seen order, most recent {@link TOOL_DIGEST_MAX_ENTRIES}. */
  entries(): ToolCallEntry[];
}

/**
 * Create a tool-call digest collector for one unit attempt.
 *
 * Records tool calls from assistant message content blocks of
 * `message_end` events: `{ type: "toolCall", name, arguments }` with a
 * `path` argument for read/write/edit and a `command` argument for bash
 * (truncated to {@link TOOL_DIGEST_MAX_CHARS}). Entries are deduplicated
 * by tool + detail; beyond {@link TOOL_DIGEST_MAX_ENTRIES} the oldest
 * entries are evicted.
 *
 * @returns A fresh collector with an empty digest.
 */
export function createToolCallCollector(): ToolCallCollector {
  const entries: ToolCallEntry[] = [];
  const seen = new Set<string>();
  const push = (tool: string, detail: string) => {
    const key = `${tool}\n${detail}`;
    if (!detail || seen.has(key)) return;
    seen.add(key);
    entries.push({ tool, detail });
    if (entries.length > TOOL_DIGEST_MAX_ENTRIES) entries.shift();
  };
  return {
    record(event: Record<string, unknown>): void {
      if (event.type !== "message_end") return;
      const message = event.message as { role?: unknown; content?: unknown } | undefined;
      if (message?.role !== "assistant" || !Array.isArray(message.content)) return;
      for (const block of message.content) {
        if (typeof block !== "object" || block === null) continue;
        const b = block as { type?: unknown; name?: unknown; arguments?: unknown };
        if (b.type !== "toolCall" && b.type !== "tool_use") continue;
        const name = typeof b.name === "string" ? b.name : "";
        const args =
          typeof b.arguments === "object" && b.arguments !== null
            ? (b.arguments as Record<string, unknown>)
            : {};
        if (name === "bash") {
          const command = typeof args.command === "string" ? args.command.trim() : "";
          if (command) push("bash", command.slice(0, TOOL_DIGEST_MAX_CHARS));
        } else if (name === "read" || name === "write" || name === "edit") {
          const path = typeof args.path === "string" ? args.path.trim() : "";
          if (path) push(name, path);
        }
      }
    },
    entries(): ToolCallEntry[] {
      return [...entries];
    },
  };
}

/**
 * Render recorded tool calls as a digest finding text.
 *
 * File tools group under their name in first-seen order ("read a.go,");
 * each bash command follows as "bash: <head>". Suitable for direct use as
 * a ledger finding (dedupe + cap handled by appendFindings).
 *
 * @param entries - Recorded tool calls, in first-seen order.
 * @returns "previous attempt touched: …", or "" when nothing was recorded.
 */
export function renderToolCallDigest(entries: ToolCallEntry[]): string {
  if (entries.length === 0) return "";
  const pathToolOrder: string[] = [];
  const pathsByTool = new Map<string, string[]>();
  const bashCommands: string[] = [];
  for (const entry of entries) {
    if (entry.tool === "bash") {
      bashCommands.push(entry.detail);
      continue;
    }
    let paths = pathsByTool.get(entry.tool);
    if (!paths) {
      paths = [];
      pathsByTool.set(entry.tool, paths);
      pathToolOrder.push(entry.tool);
    }
    paths.push(entry.detail);
  }
  const parts = pathToolOrder.map((tool) => `${tool} ${pathsByTool.get(tool)!.join(", ")}`);
  for (const command of bashCommands) parts.push(`bash: ${command}`);
  return `${TOOL_DIGEST_PREFIX} ${parts.join("; ")}`;
}
