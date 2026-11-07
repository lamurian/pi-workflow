// Outcome classification of a fresh attempt and the diagnosis/recommendation
// derivation for a halted orchestration. Pure: no I/O — the loop gathers
// attempts, tree state and findings; this module classifies and diagnoses.

import { EARLY_HALT_DIAGNOSIS } from "./unit-progress.ts";
import { PROVIDER_ERROR_RE, PROVIDER_FAILURE_RE } from "./implementer-report.ts";
import type { AttemptLike, AttemptOutcome, AttemptRecord, HaltDiagnosis } from "./halt-report.ts";

/**
 * Classify a fresh attempt before the commit gate sees it.
 *
 * Precedence starts with the undelivered-steer marker (T3): a fix round the
 * kept-alive child never picked up is a "transport" outcome ahead of every
 * other check. The model-error outcome (B2, a provider-rejected model) is
 * classified next, then the loop's partial path: timeout, then
 * missing-report, unit error, and a "partial" report status; a usable
 * report that reaches the commit gate is "ok" until its verdict seals it.
 *
 * @param attempt - The attempt outcome (report plus failure flags).
 * @returns The pre-commit outcome kind.
 */
export function classifyAttemptOutcome(attempt: AttemptLike): AttemptOutcome {
  if (attempt.undeliveredSteer) return "transport";
  if (attempt.modelError) return "model-error";
  if (attempt.timedOut) return "timeout";
  if (attempt.missingReport) return "missing-report";
  if (attempt.error) return "unit-error";
  if (attempt.status === "partial") return "partial";
  return "ok";
}

/** The halt facts a diagnosis rule matches against. */
interface DiagnosisContext {
  /** The halted behavior's attempt history. */
  attempts: AttemptRecord[];
  /** One outcome entry per attempt, in order. */
  outcomes: AttemptOutcome[];
  /** The final attempt's outcome. */
  last: AttemptOutcome;
  /** The halt error text. */
  error: string;
}

/** One ordered rule: a match predicate plus the pinned diagnosis wording. */
interface DiagnosisRule {
  /** Whether this rule wins for the given halt context. */
  matches: (ctx: DiagnosisContext) => boolean;
  /** The pinned one-line diagnosis (or a builder from the halt context). */
  diagnosis: string | ((ctx: DiagnosisContext) => string);
  /** The pinned one-line recommended next action. */
  recommendation: string;
}

/**
 * Build a rule that fires when an outcome appears anywhere in the history.
 *
 * @param outcome        - The attempt outcome this rule diagnoses.
 * @param diagnosis      - The pinned one-line diagnosis.
 * @param recommendation - The pinned one-line recommended next action.
 * @returns A rule matching histories containing the outcome.
 */
function outcomeRule(
  outcome: AttemptOutcome,
  diagnosis: string,
  recommendation: string,
): DiagnosisRule {
  return { matches: (ctx) => ctx.outcomes.includes(outcome), diagnosis, recommendation };
}

/** Generic per-history fallback: no rule above fired. */
const GENERIC_RULE: DiagnosisRule = {
  matches: () => true,
  diagnosis: "unit attempts failed without converging",
  recommendation:
    "Review the error and attempt history above, fix the blocker (or split the behavior " +
    "via /discuss -> /finalize), then run /implement again.",
};

/**
 * Ordered outcome rules for deriveDiagnosis — first match wins, so array
 * order is the precedence: transport, the three provider-evidence tiers,
 * the non-converging pair, then the commit-gate/guard outcomes
 * (contract-guard before test-guard), then the last-attempt missing-report
 * rule, and finally the generic fallback.
 */
const DIAGNOSIS_RULES: DiagnosisRule[] = [
  {
    // T3: the last round was never delivered to the unit — an orchestrator-side
    // infrastructure transport failure, not a unit verdict. It outranks every
    // other diagnosis; the timeout/partial tally below never counts transport
    // attempts, so they cannot trigger the early-halt diagnosis either.
    matches: (ctx) => ctx.last === "transport",
    diagnosis: "the orchestrator's delivery of its steer to the unit failed — infrastructure transport failure",
    recommendation:
      "Re-run /implement to resume with a fresh child; no unit-side fix is needed — " +
      "the unit never received the instruction.",
  },
  {
    // B4 tier 1: the provider rejected the child's model — the raw attempt text
    // (or the halt error) carries the deprecation/410 markers. It outranks the
    // non-converging rule below: more time never fixes a rejected model.
    matches: (ctx) =>
      PROVIDER_ERROR_RE.test(ctx.error) ||
      ctx.attempts.some((a) => PROVIDER_ERROR_RE.test(a.lastText)),
    diagnosis: "child model rejected by provider — check default model",
    recommendation:
      "Point the spawned children at a working model (settings.json defaultModel), " +
      "then run /implement again — the contract needs no change.",
  },
  {
    // B4 tier 2: provider-failure evidence without the rejection markers (the
    // 400/upstream class) — the call failed at the provider, but the model
    // reference itself is correct, so no model or contract change is warranted.
    matches: (ctx) =>
      PROVIDER_FAILURE_RE.test(ctx.error) ||
      ctx.attempts.some((a) => PROVIDER_FAILURE_RE.test(a.lastText)),
    diagnosis: "child model call failed at the provider — the model reference is correct",
    recommendation:
      "Check the provider's status, then run /implement again — the model reference " +
      "is correct, so no model or contract change is needed.",
  },
  {
    // B4 tier 3: a dead run with no evidence at all — neutral, and it points at
    // the attempt error (which now carries the child's stderr/stdout tail).
    matches: (ctx) => ctx.outcomes.includes("model-error"),
    diagnosis: "the unit run ended without producing any output",
    recommendation:
      "Inspect the attempt error above (it carries the child's last message, stderr " +
      "and stdout tail), fix the reported cause, then run /implement again.",
  },
  {
    // Repeated no-progress timeouts/partials ("exploration not converging"),
    // also detected via the early-halt error text; transport attempts never
    // count toward the pair.
    matches: (ctx) => {
      const lastTwo = ctx.attempts.slice(-2);
      return (
        ctx.error.includes(EARLY_HALT_DIAGNOSIS) ||
        (lastTwo.length === 2 &&
          lastTwo.every((a) => a.outcome === "timeout" || a.outcome === "partial") &&
          lastTwo.every((a) => !a.progress))
      );
    },
    diagnosis: EARLY_HALT_DIAGNOSIS,
    recommendation:
      "Split this behavior into smaller behaviors via /discuss -> /finalize, " +
      "or raise PI_IMPLEMENT_TIMEOUT_MS so the unit has more time to converge.",
  },
  outcomeRule(
    "contract-guard",
    "staged diff violates the declared file allowlist",
    "Re-declare the affected paths via /discuss -> /finalize (list them in files " +
      "with A/M/D status), then run /implement again.",
  ),
  outcomeRule(
    "test-guard",
    "staged-diff guard blocked edits to undeclared test files",
    "Re-declare the affected test paths via /discuss -> /finalize (list them in files), " +
      "then run /implement again.",
  ),
  outcomeRule(
    "slop-guard",
    "the slop gate blocked the commit — flagged slop in the staged diff",
    "Review the findings above and remove the flagged slop, or set implement.slop.mode " +
      "to advisory in workflow.json, then run /implement again.",
  ),
  outcomeRule(
    "hook-rejected",
    "pre-commit hooks rejected the unit's commits",
    "Run the failing hook locally against the current tree, fix the reported issue, " +
      "then run /implement again to resume.",
  ),
  outcomeRule(
    "no-changes",
    "units finished without producing committed changes",
    "Inspect the working tree for the missing changes; refine the behavior via " +
      "/discuss -> /finalize if it is ambiguous, then run /implement again.",
  ),
  {
    // The unit itself reported status blocked: name its blockedReason from the halt text.
    matches: (ctx) => ctx.outcomes.includes("unit-blocked"),
    diagnosis: (ctx) => {
      const reason = /blockedReason: ([\w-]+)/.exec(ctx.error)?.[1] ?? "unspecified";
      return `the unit reported itself blocked (blockedReason: ${reason})`;
    },
    recommendation:
      "Fix the named blocker, or split the behavior via /discuss -> /finalize, " +
      "then run /implement again.",
  },
  outcomeRule(
    "blocked",
    "a sandbox-blocked command must run outside the sandbox",
    "Run the command listed under Action required in your shell, " +
      "then run /implement again to resume.",
  ),
  outcomeRule(
    "commit-timeout",
    "the commit process exceeded its infrastructure budget",
    "Raise PI_COMMIT_TIMEOUT_MS or narrow the project's pre-commit hooks, " +
      "then run /implement again.",
  ),
  {
    // missing-report diagnoses only when it is the final attempt.
    matches: (ctx) => ctx.last === "missing-report",
    diagnosis: "the unit ended without its required JSON report",
    recommendation:
      "Re-run /implement; if it repeats, check content/unit-prompt.md and PI_IMPLEMENT_TIMEOUT_MS.",
  },
  GENERIC_RULE,
];

/**
 * Derive the halt diagnosis and recommended next action.
 *
 * An empty attempt history means the run halted before any unit spawned
 * (a failed start-time chore commit, a refused completion gate) — that
 * gets the pre-unit diagnosis first (T9). Otherwise the diagnosis comes from
 * DIAGNOSIS_RULES: the first rule whose predicate matches wins, so the table
 * order pins the precedence — transport (T3), then the provider-evidence
 * tiers (B4), then repeated no-progress timeouts/partials ("exploration not
 * converging", also detected via the early-halt error text; transport
 * attempts never count toward the pair), then contract-guard, test-guard,
 * slop-guard, hook-rejected, no-changes, blocked, commit-timeout, the
 * last-attempt missing-report rule, and finally a generic fallback. Wording
 * is pinned in the table, byte-for-byte identical to the pre-table branches.
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
  const ctx: DiagnosisContext = {
    attempts,
    outcomes,
    last: outcomes[outcomes.length - 1]!,
    error,
  };
  const rule = DIAGNOSIS_RULES.find((r) => r.matches(ctx)) ?? GENERIC_RULE;
  const diagnosis = typeof rule.diagnosis === "function" ? rule.diagnosis(ctx) : rule.diagnosis;
  return { diagnosis, recommendation: rule.recommendation };
}
