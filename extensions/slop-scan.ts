// ── Pure slop parsing and gate classification (T3) ────────────────────────────
// parseAislopJson / parseWritingScore / parseAddedLines turn raw tool and git
// output into structured facts; classifySlop maps those facts plus the config
// onto a { clean | annotate | block } verdict. No I/O here — callers fetch the
// subprocess output and hand it in.

import type { SlopConfig } from "./slop-config.ts";

/** Maximum length of a block investigation string. */
const INVESTIGATION_MAX = 4000;

// ── Types ─────────────────────────────────────────────────────────────────────

/**
 * One diagnostic from `aislop --json`: repo-relative filePath, 1-based line
 * (or null when unreported), rule id, severity label, and message text.
 */
export interface AislopDiagnostic {
  filePath: string;
  line: number | null;
  rule: string;
  severity: string;
  message: string;
}

/** Parsed `aislop --json` report: score (null when absent) and diagnostics. */
export interface AislopReport {
  score: number | null;
  diagnostics: AislopDiagnostic[];
}

/** Writing score for one staged prose file: path, staged score, HEAD score. */
export interface ProseScore {
  path: string;
  staged: number;
  head: number | null;
}

/** Everything classifySlop needs: parsed code scan, prose scores, added lines. */
export interface ClassifySlopInput {
  aislop: AislopReport | null;
  prose: readonly ProseScore[];
  addedLines: ReadonlyMap<string, number[]>;
}

/** Gate verdict: kind (clean/annotate/block), notes, violations, investigation. */
export interface SlopVerdict {
  kind: "clean" | "annotate" | "block";
  notes: string[];
  violations: string[];
  investigation: string;
}

// ── Parsing ───────────────────────────────────────────────────────────────────

/**
 * Parse `aislop --json` stdout into score and diagnostics.
 *
 * The output must be a JSON object carrying a `diagnostics` array; anything
 * else (non-JSON text, missing or non-array `diagnostics`) yields null. A
 * non-numeric or absent `score` is reported as null rather than a parse
 * failure. Diagnostic entries are normalized to their five documented fields.
 *
 * @param stdout - Raw stdout of the aislop tool.
 * @returns The report, or null when the output is not an aislop JSON report.
 */
export function parseAislopJson(stdout: string): AislopReport | null {
  let raw: unknown;
  try {
    raw = JSON.parse(stdout);
  } catch {
    return null;
  }
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) return null;

  const record = raw as Record<string, unknown>;
  if (!Array.isArray(record.diagnostics)) return null;

  const diagnostics: AislopDiagnostic[] = [];
  for (const entry of record.diagnostics) {
    if (entry === null || typeof entry !== "object") continue;
    const d = entry as Record<string, unknown>;
    diagnostics.push({
      filePath: typeof d.filePath === "string" ? d.filePath : "",
      line: typeof d.line === "number" ? d.line : null,
      rule: typeof d.rule === "string" ? d.rule : "",
      severity: typeof d.severity === "string" ? d.severity : "",
      message: typeof d.message === "string" ? d.message : "",
    });
  }

  const score =
    typeof record.score === "number" && Number.isFinite(record.score)
      ? record.score
      : null;
  return { score, diagnostics };
}

/**
 * Extract the writing score from a `Writing score: N/100` line.
 *
 * @param output - Raw tool output, e.g. from a prose scoring run.
 * @returns The score (e.g. 82.8), or null when no score line exists.
 */
export function parseWritingScore(output: string): number | null {
  const match = /Writing score:\s*(\d+(?:\.\d+)?)\s*\/\s*100/.exec(output);
  if (match === null) return null;
  const score = Number(match[1]);
  return Number.isFinite(score) ? score : null;
}

/**
 * Map each file in a `git diff --cached -U0` output to its added line numbers.
 *
 * Only new-side (`+`) lines advance the counter; removed lines and context
 * lines are accounted for by their own side. Every file named by a `diff --git`
 * header gets an entry, so newly added files count every line and deleted files
 * map to an empty array.
 *
 * @param diff - Raw unified-diff output (typically with `-U0` context).
 * @returns Added new-side line numbers per file path, in diff order.
 */
export function parseAddedLines(diff: string): Map<string, number[]> {
  const added = new Map<string, number[]>();
  let path: string | null = null;
  let nextLine = 0;
  let inHunk = false;

  const bucket = (file: string): number[] => {
    let lines = added.get(file);
    if (lines === undefined) {
      lines = [];
      added.set(file, lines);
    }
    return lines;
  };

  for (const raw of diff.split("\n")) {
    if (raw.startsWith("diff --git ")) {
      inHunk = false;
      const m = /^diff --git a\/(.+) b\/(.+)$/.exec(raw);
      path = m === null ? null : m[2];
      if (path !== null) bucket(path);
      continue;
    }
    if (raw.startsWith("@@")) {
      const m = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/.exec(raw);
      inHunk = m !== null;
      if (m !== null) nextLine = Number(m[1]);
      continue;
    }
    if (inHunk) {
      if (raw.startsWith("+")) {
        if (path !== null) bucket(path).push(nextLine);
        nextLine += 1;
      } else if (raw.startsWith("-")) {
        // old-side line: no effect on new-side numbering
      } else if (raw.startsWith(" ") || raw === "") {
        nextLine += 1;
      }
      continue;
    }
    if (raw.startsWith("+++ ")) {
      const target = raw.slice(4);
      if (target.startsWith("b/")) {
        path = target.slice(2);
        bucket(path);
      }
    }
  }
  return added;
}

// ── Classification ────────────────────────────────────────────────────────────

/**
 * Format one diagnostic as `path:line rule — message`.
 *
 * @param d - Diagnostic to format; a null line renders as `path:? rule — …`.
 * @returns The violation line.
 */
function formatDiagnostic(d: AislopDiagnostic): string {
  return `${d.filePath}:${d.line ?? "?"} ${d.rule} — ${d.message}`;
}

/**
 * Format one prose breach as a violation line.
 *
 * @param p - Prose file that breached the gate.
 * @param proseGate - Configured prose threshold.
 * @returns The violation line naming the file and the threshold.
 */
function proseViolation(p: ProseScore, proseGate: number): string {
  return `${p.path}: staged score ${p.staged} exceeds proseGate ${proseGate}`;
}

/** Build the clean verdict (no notes, no violations, no investigation). */
function cleanVerdict(): SlopVerdict {
  return { kind: "clean", notes: [], violations: [], investigation: "" };
}

/**
 * Build the blocking verdict with an investigation naming mode and thresholds.
 *
 * @param config - Resolved slop gate configuration.
 * @param violations - Every breach line found; never truncated.
 * @returns The block verdict with the investigation capped at 4000 chars.
 */
function blockVerdict(config: SlopConfig, violations: string[]): SlopVerdict {
  const investigation = [
    `slop gate blocked: mode=${config.mode}, codeFailBelow=${config.codeFailBelow}, proseGate=${config.proseGate}`,
    `violations=${violations.length}`,
    ...violations,
  ]
    .join("\n")
    .slice(0, INVESTIGATION_MAX);
  return { kind: "block", notes: [], violations, investigation };
}

/**
 * Classify the staged state into a gate verdict.
 *
 * Mode semantics:
 * - `off`: always clean, whatever breaches.
 * - `advisory`: never blocks; one `slop advisory:` note per breach — code
 *   score below `codeFailBelow`, or a prose file score above `proseGate`.
 * - `hard`: blocks on a code score below `codeFailBelow` (each diagnostic
 *   listed as `path:line rule — message`) or any prose score above `proseGate`.
 * - `baseline`: ignores the raw code score; blocks only on diagnostics whose
 *   line was added in the staged diff, and on prose files whose staged score
 *   exceeds both `proseGate` and their HEAD score (no HEAD score compares to
 *   `proseGate` alone). A null aislop score is not scoreable: no code breach.
 *
 * @param input - Parsed scan results, prose scores and added line numbers.
 * @param config - Resolved slop gate configuration.
 * @returns The verdict: `clean`, `annotate` (advisory notes) or `block`.
 */
export function classifySlop(
  input: ClassifySlopInput,
  config: SlopConfig,
): SlopVerdict {
  if (config.mode === "off") return cleanVerdict();

  const report = input.aislop;
  const score = report?.score ?? null;
  const diagnostics = report?.diagnostics ?? [];
  const codeBreach = score !== null && score < config.codeFailBelow;

  if (config.mode === "advisory") {
    const notes: string[] = [];
    if (codeBreach) {
      notes.push(
        `slop advisory: code score ${score} is below codeFailBelow ${config.codeFailBelow}`,
      );
    }
    for (const p of input.prose) {
      if (p.staged > config.proseGate) {
        notes.push(
          `slop advisory: ${p.path} staged score ${p.staged} exceeds proseGate ${config.proseGate}`,
        );
      }
    }
    if (notes.length === 0) return cleanVerdict();
    return { kind: "annotate", notes, violations: [], investigation: "" };
  }

  if (config.mode === "baseline") {
    const violations: string[] = [];
    for (const d of diagnostics) {
      if (d.line === null) continue;
      if (input.addedLines.get(d.filePath)?.includes(d.line)) {
        violations.push(formatDiagnostic(d));
      }
    }
    for (const p of input.prose) {
      const aboveHead = p.head === null || p.staged > p.head;
      if (p.staged > config.proseGate && aboveHead) {
        violations.push(proseViolation(p, config.proseGate));
      }
    }
    if (violations.length === 0) return cleanVerdict();
    return blockVerdict(config, violations);
  }

  // hard: score breach lists every diagnostic; prose breach per file.
  const violations: string[] = [];
  if (codeBreach) {
    for (const d of diagnostics) violations.push(formatDiagnostic(d));
  }
  let proseBreach = false;
  for (const p of input.prose) {
    if (p.staged > config.proseGate) {
      proseBreach = true;
      violations.push(proseViolation(p, config.proseGate));
    }
  }
  if (!codeBreach && !proseBreach) return cleanVerdict();
  return blockVerdict(config, violations);
}
