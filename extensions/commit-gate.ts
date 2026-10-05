import type { Behavior, TaskContract } from "./state.ts";
import type { ImplementerReport } from "./subagent-runner.ts";

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
  | { kind: "commit-timeout"; investigation: string };

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

/**
 * Attribute hook output to a failing stage (lint/format/test), best-effort.
 *
 * @param output - Captured commit/hook output.
 * @returns The matched stage name, or "unknown" when nothing matches.
 */
export function detectFailingStage(output: string): string {
  for (const { stage, pattern } of STAGE_PATTERNS) {
    if (pattern.test(output)) return stage;
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
    return {
      kind: "hook-rejected",
      investigation: buildInvestigation(behavior, input),
      hookOutput: input.commitOutput.trim().slice(-4000),
    };
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
  outcome: Exclude<GateOutcome, { kind: "landed" }>,
  attempt: number,
): string {
  const header = `## Previous attempt failed (retry ${attempt}/${RETRY_BUDGET})`;
  let body: string;
  if (outcome.kind === "hook-rejected") {
    body =
      `${outcome.investigation}\n\n## Raw hook output\n\n${outcome.hookOutput || "(empty)"}`;
  } else if (outcome.kind === "commit-timeout") {
    body = outcome.investigation;
  } else {
    body = outcome.investigation;
  }
  return [header, body, "", "## Original task", original].join("\n");
}
