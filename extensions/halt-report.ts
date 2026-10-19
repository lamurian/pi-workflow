/**
 * Enriched halt report rendering (T8, pure logic).
 *
 * Holds the attempt-history types, the outcome classification, the
 * diagnosis derivation and the markdown renderer used by composeHaltReport
 * in implement.ts (a thin wrapper). No I/O: the loop gathers commits,
 * tree state and findings; this module only renders.
 */

import type { Finding } from "./findings-ledger.ts";
import { EARLY_HALT_DIAGNOSIS } from "./unit-progress.ts";

/** Maximum characters kept from an attempt's last text in the table. */
export const ATTEMPT_TEXT_LIMIT = 200;

/** Number of ledger entries shown in the halt report's findings tail. */
export const FINDINGS_TAIL_LIMIT = 10;

/** Final line of the halt report (pinned wording). */
export const HALT_REPORT_CLOSING_LINE =
  "Relay this status and the recommended next action to the user. " +
  "Do not run tools or modify the working tree.";

/** Outcome kinds recorded per attempt in the halt report table. */
export type AttemptOutcome =
  | "timeout"
  | "partial"
  | "missing-report"
  | "unit-error"
  | "hook-rejected"
  | "no-changes"
  | "test-guard"
  | "blocked"
  | "commit-timeout"
  | "landed"
  | "ok";

/** One recorded attempt of the halted behavior. */
export interface AttemptRecord {
  /** 1-based attempt number within the behavior. */
  attempt: number;
  /** How the attempt ended (pre-commit classification, commit-gate verdict, or "ok"). */
  outcome: AttemptOutcome;
  /** Wall-clock duration of the attempt, rounded to seconds. */
  durationSec: number;
  /** True when the tree fingerprint moved or new findings landed during the attempt. */
  progress: boolean;
  /** Last assistant text (summary or error), truncated to {@link ATTEMPT_TEXT_LIMIT} chars. */
  lastText: string;
}

/** Minimal attempt shape the pre-commit outcome classification needs. */
export interface AttemptLike {
  /** Parsed report status field. */
  status?: string;
  /** True when the subprocess was killed by the wall-clock timeout. */
  timedOut?: boolean;
  /** True when the unit exited 0 without the mandatory JSON report. */
  missingReport?: boolean;
  /** Failure detail from the unit runner. */
  error?: string;
}

/** Diagnosis plus recommended next action for a halted orchestration. */
export interface HaltDiagnosis {
  /** One-line diagnosis of why the behavior halted. */
  diagnosis: string;
  /** One-line recommended next action for the user/orchestrator. */
  recommendation: string;
}

/** Everything the halt report renders; gathered by the orchestrator loop. */
export interface HaltReportInput {
  /** Behavior the run halted on. */
  haltedOn?: string;
  /** Failure detail. */
  error?: string;
  /** `git status --short` snapshot at halt time. */
  treeState?: string;
  /** Commit subjects since the /implement baseline (per-run landedCommits as fallback). */
  commits: string[];
  /** Per-attempt history for the halted behavior. */
  attempts?: AttemptRecord[];
  /** Shared findings ledger (the tail is rendered). */
  findings?: Finding[];
  /** Pre-derived diagnosis line (derived from attempts when absent). */
  diagnosis?: string;
  /** Pre-derived recommendation line (derived from attempts when absent). */
  recommendation?: string;
  /** Sandbox-blocked command the user must run before resuming. */
  pendingCommand?: { command: string; reason?: string };
}

/**
 * Truncate an attempt's last text to {@link ATTEMPT_TEXT_LIMIT} chars.
 *
 * @param text - Raw last text (summary or error).
 * @returns The text capped at 200 chars with a trailing "…" when cut.
 */
export function truncateAttemptText(text: string): string {
  const trimmed = text.trim();
  return trimmed.length > ATTEMPT_TEXT_LIMIT
    ? trimmed.slice(0, ATTEMPT_TEXT_LIMIT) + "…"
    : trimmed;
}

/**
 * Classify a fresh attempt before the commit gate sees it.
 *
 * Precedence matches the loop's partial path: timeout first, then
 * missing-report, unit error, and a "partial" report status; a usable
 * report that reaches the commit gate is "ok" until its verdict seals it.
 *
 * @param attempt - The attempt outcome (report plus failure flags).
 * @returns The pre-commit outcome kind.
 */
export function classifyAttemptOutcome(attempt: AttemptLike): AttemptOutcome {
  if (attempt.timedOut) return "timeout";
  if (attempt.missingReport) return "missing-report";
  if (attempt.error) return "unit-error";
  if (attempt.status === "partial") return "partial";
  return "ok";
}

/**
 * Derive the halt diagnosis and recommended next action.
 *
 * Priority: repeated no-progress timeouts/partials ("exploration not
 * converging", also detected via the early-halt error text), then
 * test-guard, hook-rejected, no-changes, blocked, commit-timeout, and
 * finally a generic per-last-outcome fallback.
 *
 * @param attempts - The halted behavior's attempt history.
 * @param error    - The halt error text.
 * @returns The diagnosis and recommended next action.
 */
export function deriveDiagnosis(attempts: AttemptRecord[], error: string): HaltDiagnosis {
  const outcomes = attempts.map((a) => a.outcome);
  const lastTwo = attempts.slice(-2);
  const nonConverging =
    error.includes(EARLY_HALT_DIAGNOSIS) ||
    (lastTwo.length === 2 &&
      lastTwo.every((a) => a.outcome === "timeout" || a.outcome === "partial") &&
      lastTwo.every((a) => !a.progress));
  if (nonConverging) {
    return {
      diagnosis: EARLY_HALT_DIAGNOSIS,
      recommendation:
        "Split this behavior into smaller behaviors via /discuss -> /finalize, " +
        "or raise PI_IMPLEMENT_TIMEOUT_MS so the unit has more time to converge.",
    };
  }
  if (outcomes.includes("test-guard")) {
    return {
      diagnosis: "staged-diff guard blocked edits to undeclared test files",
      recommendation:
        "Re-declare the affected test paths via /discuss -> /finalize (list them in files), " +
        "then run /implement again.",
    };
  }
  if (outcomes.includes("hook-rejected")) {
    return {
      diagnosis: "pre-commit hooks rejected the unit's commits",
      recommendation:
        "Run the failing hook locally against the current tree, fix the reported issue, " +
        "then run /implement again to resume.",
    };
  }
  if (outcomes.includes("no-changes")) {
    return {
      diagnosis: "units finished without producing committed changes",
      recommendation:
        "Inspect the working tree for the missing changes; refine the behavior via " +
        "/discuss -> /finalize if it is ambiguous, then run /implement again.",
    };
  }
  if (outcomes.includes("blocked")) {
    return {
      diagnosis: "a sandbox-blocked command must run outside the sandbox",
      recommendation:
        "Run the command listed under Action required in your shell, " +
        "then run /implement again to resume.",
    };
  }
  if (outcomes.includes("commit-timeout")) {
    return {
      diagnosis: "the commit process exceeded its infrastructure budget",
      recommendation:
        "Raise PI_COMMIT_TIMEOUT_MS or narrow the project's pre-commit hooks, " +
        "then run /implement again.",
    };
  }
  const last = outcomes[outcomes.length - 1];
  if (last === "missing-report") {
    return {
      diagnosis: "the unit ended without its required JSON report",
      recommendation:
        "Re-run /implement; if it repeats, check content/unit-prompt.md and PI_IMPLEMENT_TIMEOUT_MS.",
    };
  }
  return {
    diagnosis: "unit attempts failed without converging",
    recommendation:
      "Review the error and attempt history above, fix the blocker (or split the behavior " +
      "via /discuss -> /finalize), then run /implement again.",
  };
}

/** Escape a table cell: pipes escaped, newlines collapsed to spaces. */
function escapeCell(text: string): string {
  return text.replace(/\|/g, "\\|").replace(/\s*\n\s*/g, " ");
}

/**
 * Render the attempt history as a markdown table.
 *
 * @param attempts - The halted behavior's attempt history.
 * @returns Table lines, or a "(no attempts recorded)" placeholder row.
 */
export function renderAttemptTable(attempts: AttemptRecord[]): string[] {
  if (attempts.length === 0) return ["(no attempts recorded)"];
  const rows = [
    "| # | Outcome | Duration | Progress | Last text |",
    "| - | ------- | -------- | -------- | --------- |",
  ];
  for (const a of attempts) {
    rows.push(
      `| ${a.attempt} | ${a.outcome} | ${a.durationSec}s | ${a.progress ? "yes" : "no"} | ` +
        `${escapeCell(truncateAttemptText(a.lastText))} |`,
    );
  }
  return rows;
}

/**
 * Render the enriched halt report.
 *
 * Sections in order: halted heading, error, tree state, cumulative
 * commits since /implement started, attempt table, findings tail,
 * Diagnosis and Recommended next action, optional Action-required block
 * for a pending command, the resume line, and the pinned closing
 * instruction ({@link HALT_REPORT_CLOSING_LINE}) as the final line.
 *
 * @param input - Everything gathered by the orchestrator loop.
 * @returns The markdown report string.
 */
export function renderHaltReport(input: HaltReportInput): string {
  const attempts = input.attempts ?? [];
  const derived = deriveDiagnosis(attempts, input.error ?? "");
  const diagnosis = input.diagnosis ?? derived.diagnosis;
  const recommendation = input.recommendation ?? derived.recommendation;
  const lines: string[] = [
    `## Implementation status: halted on ${input.haltedOn ?? "(unknown)"}`,
    "",
    `Error: ${input.error ?? "(unknown)"}`,
    "",
    "Tree state:",
    input.treeState ?? "(unavailable)",
    "",
    "Commits landed since /implement started:",
  ];
  if (input.commits.length) {
    for (const subject of input.commits) lines.push(`- ${subject}`);
  } else {
    lines.push("(none)");
  }
  lines.push("", "Attempt history:");
  lines.push(...renderAttemptTable(attempts));
  lines.push("", "Findings (latest):");
  const tail = (input.findings ?? []).slice(-FINDINGS_TAIL_LIMIT);
  if (tail.length) {
    for (const entry of tail) lines.push(`- [${entry.behaviorId}] ${entry.text}`);
  } else {
    lines.push("(none)");
  }
  lines.push("", `Diagnosis: ${diagnosis}`, "", `Recommended next action: ${recommendation}`);
  if (input.pendingCommand) {
    lines.push(
      "",
      "Action required:",
      "Run this command in your shell (the sandbox blocks it here):",
      "",
      "```",
      input.pendingCommand.command,
      "```",
    );
    if (input.pendingCommand.reason) {
      lines.push(`Reason: ${input.pendingCommand.reason}`);
    }
    lines.push("", "Then run /implement again to resume.");
  }
  lines.push(
    "",
    "Resume: run /implement again to resume from the first active behavior.",
    "",
    HALT_REPORT_CLOSING_LINE,
  );
  return lines.join("\n");
}
