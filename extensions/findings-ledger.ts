/**
 * Shared findings ledger (pure logic).
 *
 * Unit attempts report reusable facts ("findings") in their JSON report.
 * The orchestrator appends them to a ledger on the workflow state, shared
 * across ALL behaviors of the task, and renders the ledger into every
 * subsequent unit task text. The ledger is capped at the most recent
 * {@link MAX_FINDINGS} entries, deduplicated by exact text, cleared when
 * orchestration completes, and kept across halts/resumes.
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
