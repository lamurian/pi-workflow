import type { Behavior, TaskContract } from "./state.ts";
import type { ImplementerReport } from "./implementer-report.ts";
import type { StagedDiffResult } from "./staged-diff-guard.ts";

// ─── Types ─────────────────────────────────────────────────────────────────────

/** Outcome of the HEAD-gate check after a commit attempt. */
export type GateOutcome =
  /** HEAD moved: the commit landed and the project's hooks passed. */
  | { kind: "landed" }
  /** HEAD unchanged + dirty tree: the pre-commit hook rejected the commit. */
  | { kind: "hook-rejected"; investigation: string; hookOutput: string }
  /** HEAD unchanged + clean tree: the unit landed no changes. */
  | { kind: "no-changes"; investigation: string }
  /** The commit process itself timed out — infrastructure, not a hook failure. */
  | { kind: "commit-timeout"; investigation: string }
  /** The staged diff deletes, skips, or retries-touches undeclared tests. */
  | { kind: "test-guard"; investigation: string; violations: string[] }
  /** The staged diff against the baseline violates the contract's file allowlist. */
  | { kind: "contract-guard"; investigation: string; violations: string[] }
  /** The slop gate blocked the commit before `git commit` ran. */
  | { kind: "slop-guard"; investigation: string; violations: string[] };

/** Everything the gate needs to classify one commit attempt. */
export interface GateInput {
  headBefore: string | null;
  headAfter: string | null;
  /** Exit code of the `git commit` process. */
  commitExitCode: number;
  /** Combined captured output of the commit process (stdout + stderr). */
  commitOutput: string;
  /** True when the commit process was killed by PI_COMMIT_TIMEOUT_MS. */
  timedOut: boolean;
  /** `git status --short` after the failed commit. */
  statusAfter: string;
  /** `git diff --stat` after the failed commit. */
  diffStat: string;
  timeoutMs: number;
}

/** Per-stage markers used to attribute hook output to lint/format/test. */
const STAGE_PATTERNS: Array<{ stage: string; pattern: RegExp }> = [
  { stage: "format", pattern: /\b(gofmt|prettier|clang-format|black|ruff format)\b/i },
  { stage: "lint", pattern: /\b(golangci-lint|eslint|stylelint|vet|staticcheck|flake8)\b/i },
  { stage: "test", pattern: /\b(go test|npm test|vitest|jest|pytest|cargo test|FAIL)\b/i },
];

/** Commit output lines from git saying the index was empty (nothing staged). */
const NOTHING_TO_COMMIT = /nothing added to commit|no changes added to commit|nothing to commit/i;

/**
 * Attribute hook output to a failing stage (lint/format/test), best-effort.
 * Lines containing `(skip)` are ignored — a skipped job never failed, and
 * lefthook prints the job name in those lines (e.g. `gofmt (skip)`), which
 * would otherwise misattribute the output to format.
 *
 * @param output - Captured commit/hook output.
 * @returns The matched stage name, or "unknown" when nothing matches.
 */
export function detectFailingStage(output: string): string {
  const active = output
    .split("\n")
    .filter((line) => !line.includes("(skip)"))
    .join("\n");
  for (const { stage, pattern } of STAGE_PATTERNS) {
    if (pattern.test(active)) return stage;
  }
  return "unknown";
}

/**
 * Build the deterministic investigation for a failed commit attempt.
 *
 * Pure: takes only what the loop already captured — no exec, no model call.
 * The fix subagent receives this text plus the raw hook output and performs
 * the actual interpretation.
 *
 * @param behavior - The behavior whose commit failed.
 * @param input    - Captured gate inputs.
 * @returns Multi-line investigation text.
 */
export function buildInvestigation(behavior: Behavior, input: GateInput): string {
  const lines: string[] = [
    `## Investigation: commit for ${behavior.id} did not land`,
    "",
    `- git commit exit code: ${input.commitExitCode}`,
    `- failing stage (best-effort): ${detectFailingStage(input.commitOutput)}`,
    `- git status --short: ${input.statusAfter.trim() || "(clean)"}`,
    `- diff --stat: ${input.diffStat.trim() || "(none)"}`,
  ];
  if (input.timedOut) {
    lines.push(
      "",
      `NOTE: the commit process itself timed out after ${input.timeoutMs}ms (PI_COMMIT_TIMEOUT_MS).`,
      "This is an infrastructure failure, not a hook verdict — the hook may still",
      "have been running. Do not treat this as a lint/format/test failure.",
    );
  }
  lines.push("", "## Hook output tail", "", input.commitOutput.trim().slice(-4000) || "(empty)");
  return lines.join("\n");
}

/**
 * Classify one commit attempt against the HEAD gate.
 *
 * @param behavior - The behavior whose commit was attempted.
 * @param input    - Captured gate inputs.
 * @returns The gate outcome for the loop to act on.
 */
export function classifyCommit(behavior: Behavior, input: GateInput): GateOutcome {
  if (input.headBefore !== null && input.headAfter !== null && input.headAfter !== input.headBefore) {
    return { kind: "landed" };
  }
  if (input.timedOut) {
    return {
      kind: "commit-timeout",
      investigation: buildInvestigation(behavior, input),
    };
  }
  const dirty = input.statusAfter.trim().length > 0;
  if (dirty) {
    // Empty-index failure: git itself refused because nothing was staged —
    // no hook ever rejected the commit (untracked files make the tree look
    // dirty, which used to misclassify this as hook-rejected and burn retries).
    if (NOTHING_TO_COMMIT.test(input.commitOutput)) {
      return {
        kind: "no-changes",
        investigation:
          `No changes detected for ${behavior.id}: git found nothing to commit — ` +
          "nothing was staged (empty index), so no hook ever ran against the change. " +
          "git status shows only untracked or unstaged work on disk; stage the " +
          "behavior's owned files (git add -- <path>) so they enter the index.",
      };
    }
    return {
      kind: "hook-rejected",
      investigation: buildInvestigation(behavior, input),
      hookOutput: input.commitOutput.trim().slice(-4000),
    };
  }
  // Hardening: git commit exited 0 means the commit was created even when
  // HEAD could not be read (rev-parse unavailable) — a successful commit
  // must never be misclassified as no-changes just because HEAD is null.
  if (
    input.commitExitCode === 0 &&
    !input.timedOut &&
    (input.headBefore === null || input.headAfter === null)
  ) {
    return { kind: "landed" };
  }
  return {
    kind: "no-changes",
    investigation:
      `No changes detected for ${behavior.id}: the unit reported success but the ` +
      "commit found nothing to commit (HEAD unchanged, working tree clean). " +
      "Implement the behavior's expectedOutput and land actual file changes.",
  };
}

// ─── Retry instructions ────────────────────────────────────────────────────────

/** Maximum fix-subagent retries per behavior (engineer's note: 5). */
export const RETRY_BUDGET = 5;

/**
 * Build the retry task text for a fix subagent after a failed commit.
 *
 * @param behavior    - The behavior being retried.
 * @param task        - The full task contract (context).
 * @param original    - The original unit task text for this behavior.
 * @param outcome     - The gate outcome that triggered the retry.
 * @param attempt     - 1-based retry attempt number.
 * @returns Rendered retry task text.
 */
export function buildFixTask(
  behavior: Behavior,
  task: TaskContract,
  original: string,
  outcome: Exclude<GateOutcome, { kind: "landed" }> | StagedDiffResult,
  attempt: number,
): string {
  const header = `## Previous attempt failed (retry ${attempt}/${RETRY_BUDGET})`;
  let body: string;
  if (outcome.kind === "test-guard") {
    body =
      `${outcome.investigation}\n\n` +
      `The staged-diff guard is ENFORCED by the orchestrator, not a request: ` +
      `the staged diff is inspected before every commit and commits that delete, ` +
      `skip, or modify undeclared tests are rejected before reaching the hook. ` +
      `Tests are the specification. If the contract requires updating or removing ` +
      `test paths, re-declare them via /discuss -> /finalize listing those paths ` +
      `in files, then /implement resumes. Do NOT delete or weaken tests to land ` +
      `this commit.`;
  } else if (outcome.kind === "contract-guard") {
    body =
      `${outcome.investigation}\n\n` +
      `The contract's files list is an AUTHORITATIVE allowlist, enforced by the ` +
      `orchestrator before every commit: every staged path must be declared with ` +
      `exactly its staged status. Fix the change to match the declarations, or ` +
      `re-declare the paths via /discuss -> /finalize, then /implement resumes.`;
  } else if (outcome.kind === "slop-guard") {
    body =
      `${outcome.investigation}\n\n` +
      `The slop gate is ENFORCED before the commit hook: remove the flagged slop ` +
      `from the staged diff — rewrite or delete the offending content named in the ` +
      `violations. Do NOT add aislop-ignore directives, suppress comments, or config ` +
      `exclusions to silence the gate; fix the content itself.`;
  } else if (outcome.kind === "hook-rejected") {
    body =
      `${outcome.investigation}\n\n## Raw hook output\n\n${outcome.hookOutput || "(empty)"}`;
  } else {
    body = outcome.investigation;
  }
  return [header, body, "", "## Original task", original].join("\n");
}

/**
 * Build the one-line halt detail for an exhausted retry budget.
 *
 * @param outcomeKind - The gate outcome kind that exhausted the budget.
 * @param behaviorId  - The behavior whose retry budget ran out.
 * @returns The detail text: slop-guard, hook-rejected, or no-changes wording.
 */
export function retryExhaustedDetail(outcomeKind: GateOutcome["kind"], behaviorId: string): string {
  if (outcomeKind === "slop-guard") {
    return `slop gate blocked the commit for ${behaviorId} after ${RETRY_BUDGET} retries`;
  }
  if (outcomeKind === "hook-rejected") {
    return `pre-commit hook rejected the commit for ${behaviorId} after ${RETRY_BUDGET} retries`;
  }
  return `no changes detected for ${behaviorId} after ${RETRY_BUDGET} retries`;
}
