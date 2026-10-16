// ─── Rendered scan-evidence output with basename fan-out collapse ─────────────
// Pure module, split from test-scan.ts to stay under the 300-line rule.
// Collapses generic-basename fan-out per entry so save_task's tool result
// stays small; high-confidence matches are never collapsed.

/** Per-entry cap: above this many [basename, low] matches, collapse. */
export const BASENAME_FANOUT_CAP = 5;

/** Number of sample test paths kept in a collapsed basename summary line. */
const SAMPLE_PATHS = 3;

/** One parsed evidence line: a match line or an entry-level free-form line. */
interface EvidenceLine {
  raw: string;
  /** Declared entry the line belongs to (text before " -> " or ":"). */
  entry: string;
  /** Matched test path, when the line is a match line. */
  testPath?: string;
  /** Match method, when the line is a match line. */
  method?: string;
  /** Confidence tag, when the line is a match line. */
  confidence?: string;
}

const MATCH_LINE = /^(.+?) -> (.+) \[(\w+), (high|low)\]$/;

/** Parse one evidence line into entry + optional match fields. */
function parseLine(raw: string): EvidenceLine {
  const m = MATCH_LINE.exec(raw);
  if (!m) return { raw, entry: raw.split(":")[0] ?? raw };
  return { raw, entry: m[1]!, testPath: m[2]!, method: m[3]!, confidence: m[4]! };
}

/** Whether a line is a low-confidence basename match (collapsible). */
function isBasenameLow(line: EvidenceLine): boolean {
  return line.testPath !== undefined && line.method === "basename" && line.confidence === "low";
}

/** Basename of a source entry without its extension: "a/research.json" -> "research". */
function entryBasename(entry: string): string {
  const last = entry.split("/").pop() ?? entry;
  const dot = last.lastIndexOf(".");
  return dot > 0 ? last.slice(0, dot) : last;
}

/** Escape regex metacharacters in the grep-hint basename. */
function escapeHint(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Build the one-line summary replacing a collapsed basename fan-out block.
 *
 * @param entry - The declared source entry the matches belong to.
 * @param basenameLines - All collapsible [basename, low] lines for the entry.
 * @returns Summary with total count, first 3 sample paths, and a grep hint.
 */
function summaryLine(entry: string, basenameLines: EvidenceLine[]): string {
  const samples = basenameLines
    .slice(0, SAMPLE_PATHS)
    .map((l) => l.testPath)
    .join(", ");
  const hint = escapeHint(entryBasename(entry));
  return `${entry}: ${basenameLines.length} test files match [basename, low] — e.g. ${samples} — too generic to enumerate; grep "\\b${hint}\\b" in test files if relevant`;
}

/**
 * Render one entry's evidence lines, collapsing basename fan-out above the cap.
 *
 * @param lines - All evidence lines belonging to a single entry, in order.
 * @returns Rendered lines: high-confidence and free-form lines unchanged; the
 *   [basename, low] block replaced by one summary line when above the cap.
 */
function renderEntry(lines: EvidenceLine[]): string[] {
  const basenameLines = lines.filter(isBasenameLow);
  if (basenameLines.length <= BASENAME_FANOUT_CAP) return lines.map((l) => l.raw);
  const out: string[] = [];
  let summaryEmitted = false;
  for (const line of lines) {
    if (isBasenameLow(line)) {
      if (!summaryEmitted) {
        out.push(summaryLine(line.entry, basenameLines));
        summaryEmitted = true;
      }
      continue;
    }
    out.push(line.raw);
  }
  return out;
}

/**
 * Render scan evidence lines for the save_task tool result.
 *
 * Groups lines per declared entry (in first-appearance order). When an
 * entry's [basename, low] matches exceed BASENAME_FANOUT_CAP, they collapse
 * into one summary line keeping the first 3 sample paths, the total count,
 * and a word-boundary grep hint. High-confidence matches (structural /
 * import-path / symbol) and non-match entry lines are never collapsed.
 * Lines are joined with "\n"; bullets are the caller's concern.
 *
 * @param evidence - Raw evidence lines as produced by crossCheck.
 * @returns Rendered evidence text ("" for empty input).
 */
export function renderEvidence(evidence: readonly string[]): string {
  const groups = new Map<string, EvidenceLine[]>();
  for (const raw of evidence) {
    const parsed = parseLine(raw);
    let group = groups.get(parsed.entry);
    if (!group) {
      group = [];
      groups.set(parsed.entry, group);
    }
    group.push(parsed);
  }
  const out: string[] = [];
  for (const lines of groups.values()) out.push(...renderEntry(lines));
  return out.join("\n");
}
