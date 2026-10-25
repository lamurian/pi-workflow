// ─── Halt diagnosis (T8/T9) ──────────────────────────────────────────────────
// Outcome classification of a fresh attempt and the diagnosis/recommendation
// derivation for a halted orchestration. Pure: no I/O — the loop gathers
// attempts, tree state and findings; this module classifies and diagnoses.

import { EARLY_HALT_DIAGNOSIS } from "./unit-progress.ts";
import type { AttemptLike, AttemptOutcome, AttemptRecord, HaltDiagnosis } from "./halt-report.ts";

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
 * An empty attempt history means the run halted before any unit spawned
 * (a failed start-time chore commit, a refused completion gate) — that
 * gets the pre-unit diagnosis first (T9). Otherwise the priority is:
 * repeated no-progress timeouts/partials ("exploration not converging",
 * also detected via the early-halt error text), then test-guard,
 * hook-rejected, no-changes, blocked, commit-timeout, and finally a
 * generic per-last-outcome fallback.
 *
 * @param attempts - The halted behavior's attempt history.
 * @param error    - The halt error text.
 * @returns The diagnosis and recommended next action.
 */
export function deriveDiagnosis(attempts: AttemptRecord[], error: string): HaltDiagnosis {
  if (attempts.length === 0) {
    return {
      diagnosis: "the run halted before any unit started",
      recommendation: "Fix the error above, then run /implement again.",
    };
  }
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
  if (outcomes.includes("contract-guard")) {
    return {
      diagnosis: "staged diff violates the declared file allowlist",
      recommendation:
        "Re-declare the affected paths via /discuss -> /finalize (list them in files " +
        "with A/M/D status), then run /implement again.",
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
