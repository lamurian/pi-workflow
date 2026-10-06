import type { Behavior, TaskContract } from "./state.ts";
import type { ImplementerReport } from "./subagent-runner.ts";
import { isTestPath, LANG_PROFILES } from "./test-scan.ts";

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
  | { kind: "test-guard"; investigation: string; violations: string[] };

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

// ─── Staged-diff tamper guard (T4) ──────────────────────────────────────────

/** Everything the staged-diff classifier needs for one commit attempt. */
export interface StagedDiffInput {
  /** Raw `git diff --cached --name-status` output. */
  nameStatus: string;
  /** The contract's declared files (the allowlist). */
  declaredFiles: readonly string[];
  /** sourceFile of every test-kind behavior (protected even when declared). */
  testKindSourceFiles: readonly string[];
  /** 1 = first attempt; >= 2 = fix retry (stricter: any undeclared M/D). */
  attempt: number;
  /** Raw `git diff --cached` output for skip markers + assertion deltas. */
  unifiedDiff?: string;
}

/** Result of the staged-diff tamper classification. */
export interface StagedDiffResult {
  kind: "clean" | "test-guard";
  /** Offending paths / rule breaches; empty when clean. */
  violations: string[];
  /** Name-status test lines + assertion-delta context (never gating). */
  investigation: string;
}

/** Assertion-like line detector for investigation context only. */
const ASSERTION_LINE = /\b(expect|assert|it|test|should|TestCase|@Test)\b/;

/** Skip/only markers: union across all profiles — the guard protects broadly. */
const SKIP_MARKERS: RegExp[] = LANG_PROFILES.flatMap((p) =>
  p.skipPatterns.map((re) => new RegExp(re.source, re.flags.replace(/g/g, ""))),
);

/** One parsed `git diff --cached --name-status` entry. */
interface NameStatusEntry {
  status: string;
  path: string;
}

/** Parse name-status lines; renames/copies split into D(old) + A(new). */
function parseNameStatus(nameStatus: string): NameStatusEntry[] {
  const entries: NameStatusEntry[] = [];
  for (const line of nameStatus.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const fields = trimmed.split("\t");
    const status = fields[0]?.[0] ?? "";
    if ((status === "R" || status === "C") && fields[1] && fields[2]) {
      entries.push({ status: "D", path: fields[1] });
      entries.push({ status: "A", path: fields[2] });
    } else if (fields[1]) {
      entries.push({ status, path: fields[1] });
    }
  }
  return entries;
}

/** Split a unified diff into per-file sections keyed by b-path (fallback a-path). */
function diffSections(unifiedDiff: string): Map<string, string> {
  const sections = new Map<string, string>();
  const chunks = unifiedDiff.split(/^(?=diff --git )/m);
  for (const chunk of chunks) {
    if (!chunk.startsWith("diff --git ")) continue;
    const header = chunk.split("\n", 1)[0] ?? "";
    const match = header.match(/diff --git a\/(.+) b\/(.+)/);
    const key = match ? (match[2] ?? match[1]!) : header;
    sections.set(key, chunk);
  }
  return sections;
}

/** True when the file's added diff lines introduce skip/only markers. */
function addsSkipMarkers(section: string | undefined): boolean {
  if (!section) return false;
  const added = section
    .split("\n")
    .filter((l) => l.startsWith("+") && !l.startsWith("+++"));
  return added.some((line) => SKIP_MARKERS.some((re) => re.test(line)));
}

/**
 * Deterministically classify one staged diff against the tamper-guard rules.
 *
 * Attempt 1: A on any test path never violates; M on a declared test path is
 * allowed; M on an undeclared test path is non-blocking unless skip/only
 * markers were added; D on an undeclared test path violates; D on a
 * test-kind behavior's sourceFile violates even when declared. Fix retries
 * (attempt >= 2) are stricter: any M/D on an undeclared test path violates.
 * Assertion deltas from the unified diff are investigation context only.
 *
 * @param input - Parsed staged diff + contract declarations + attempt number.
 * @returns Clean or test-guard with violations and investigation text.
 */
export function classifyStagedDiff(input: StagedDiffInput): StagedDiffResult {
  const entries = parseNameStatus(input.nameStatus);
  const sections = diffSections(input.unifiedDiff ?? "");
  const violations: string[] = [];
  const testLines: string[] = [];

  for (const line of input.nameStatus.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const path = trimmed.split("\t")[1];
    if (path && isTestPath(path)) testLines.push(trimmed);
  }

  for (const { status, path } of entries) {
    if (!isTestPath(path)) continue;
    const declared = input.declaredFiles.includes(path);
    const isSource = input.testKindSourceFiles.includes(path);

    if (status === "A") continue; // new tests are the norm

    if (status === "D") {
      if (isSource) {
        violations.push(
          `test-kind sourceFile deletion: ${path} — the file that surfaces this behavior's verification was deleted`,
        );
      } else if (!declared) {
        violations.push(
          `undeclared test deletion: ${path} — tests are the specification; declare it in files if the contract removes it`,
        );
      }
      continue;
    }

    // Modification (M or anything else treated as a change).
    if (declared) continue;
    if (input.attempt >= 2) {
      violations.push(
        `fix retry touched undeclared test path: ${path} — only implementation code may change on retries`,
      );
      continue;
    }
    if (addsSkipMarkers(sections.get(path))) {
      violations.push(
        `skip/only markers added to undeclared test path: ${path} — skipping a test is not a fix`,
      );
    }
  }

  // Assertion-delta context: per-file +/- assertion-like line counts.
  const deltaLines: string[] = [];
  for (const [path, section] of sections) {
    if (!isTestPath(path)) continue;
    let added = 0;
    let removed = 0;
    for (const line of section.split("\n")) {
      if (!ASSERTION_LINE.test(line)) continue;
      if (line.startsWith("+") && !line.startsWith("+++")) added++;
      else if (line.startsWith("-") && !line.startsWith("---")) removed++;
    }
    if (added > 0 || removed > 0) {
      deltaLines.push(`  ${path}: +${added} -${removed} assertion-like lines`);
    }
  }

  const parts = [
    `## Staged-diff guard: ${violations.length > 0 ? "violations detected" : "clean"}`,
    "",
    "Name-status (test paths):",
    testLines.length > 0 ? testLines.map((l) => `  ${l}`).join("\n") : "  (none)",
    "",
    "Assertion deltas (context only, never a violation):",
    deltaLines.length > 0 ? deltaLines.join("\n") : "  (none)",
  ];
  if (violations.length > 0) {
    parts.push("", "Violations:", ...violations.map((v) => `  - ${v}`));
  }

  return { kind: violations.length > 0 ? "test-guard" : "clean", violations, investigation: parts.join("\n") };
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
  } else if (outcome.kind === "hook-rejected") {
    body =
      `${outcome.investigation}\n\n## Raw hook output\n\n${outcome.hookOutput || "(empty)"}`;
  } else {
    body = outcome.investigation;
  }
  return [header, body, "", "## Original task", original].join("\n");
}
