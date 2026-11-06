// T7 final-gate triage (pure): extract failing test paths from red final-gate
// suite tails, mark each against the contract's declared allowlist, and render
// the undeclared/unparseable halt. No I/O — inputs are recorded verdicts.

import { posix } from "node:path";
import type { GateSuiteResult } from "./state-types.ts";
import { ownersOf, type DeclaredFile } from "./contract-guard-core.ts";

/** One failing test path extracted from a red final-gate suite. */
export interface FailingTestEntry {
  /** Repo-relative failing test path (file, or go package dir). */
  path: string;
  /** True when a declared allowlist entry covers the path. */
  declared: boolean;
  /** Owning task ids of the covering entry/entries (empty when none list owners). */
  owners: string[];
}

/** Triage verdict over every red suite of one final-gate run (T7). */
export interface FullGateTriage {
  /** Deduplicated failing tests, each marked declared/undeclared with owners. */
  failing: FailingTestEntry[];
  /** Labels of red suites whose tails yielded no failing test path. */
  unparseableSuites: string[];
}

/** Strip a leading `./` and a trailing `/...` from a suite-reported token. */
function normalizeToken(token: string): string {
  return token.replace(/^\.\//, "").replace(/\/\.\.\.$/, "");
}

/**
 * True when a `FAIL <token>` reference is a repo-relative package path rather
 * than an import path (e.g. `github.com/x/y`).
 *
 * @param token - The raw token after `FAIL`.
 * @returns True when the token maps into the repository tree.
 */
function isRepoRelativeRef(token: string): boolean {
  const rel = normalizeToken(token);
  if (!rel || rel === "...") return false;
  const first = rel.split("/")[0] ?? "";
  // A domain-like first segment (contains a dot) on a multi-segment token is
  // an import path: skip it. Single-segment dotted tokens are files (`a.test.ts`).
  return !(rel.includes("/") && first.includes("."));
}

/**
 * Extract the failing test paths from ONE red suite tail.
 *
 * Recognizes pytest `FAILED path::test` summary lines, vitest/go `FAIL <path>`
 * lines (vitest file paths and go package refs in repo-relative form), and go
 * `--- FAIL:` blocks whose indented `file:line:` detail refs resolve — bare
 * names against the package dir from a `FAIL <pkg>` line, pathed names against
 * the suite cwd. Every path is mapped to a repo-relative path via the suite cwd.
 *
 * @param suite - The red suite verdict (tail + optional repo-relative cwd).
 * @returns Deduplicated repo-relative paths in first-seen order.
 */
export function extractFailingPaths(suite: GateSuiteResult): string[] {
  const dir = suite.cwd && suite.cwd !== "." ? suite.cwd : "";
  const paths: string[] = [];
  const packages: string[] = [];
  // pytest short-summary failures: `FAILED tests/test_a.py::test_name ...`
  for (const m of suite.tail.matchAll(/^[ \t]*FAILED[ \t]+(\S+?)::/gm)) {
    const rel = normalizeToken(m[1] ?? "");
    if (rel) paths.push(posix.join(dir, rel));
  }
  // vitest `FAIL path > suite > test` and go `FAIL <pkg>` package refs.
  for (const m of suite.tail.matchAll(/^[ \t]*FAIL[ \t]+(\S+)/gm)) {
    const token = m[1] ?? "";
    if (!isRepoRelativeRef(token)) continue;
    const full = posix.join(dir, normalizeToken(token));
    paths.push(full);
    // A token without a file extension is a go package dir.
    if (!/\.[A-Za-z0-9]+$/.test(normalizeToken(token))) packages.push(full);
  }
  // go `--- FAIL:` blocks: indented `file:line:` detail refs after the header.
  let inBlock = false;
  for (const line of suite.tail.split("\n")) {
    if (/^--- FAIL:/.test(line)) {
      inBlock = true;
      continue;
    }
    if (/^(FAIL|ok)[ \t]/.test(line)) inBlock = false;
    if (!inBlock) continue;
    const ref = line.match(/^\s+(\S+?):\d+:/);
    if (!ref) continue;
    const file = ref[1] ?? "";
    if (!/\.[A-Za-z0-9]+$/.test(file)) continue;
    const target = file.includes("/")
      ? posix.join(dir, normalizeToken(file))
      : posix.join(packages[0] ?? dir, file);
    paths.push(target);
  }
  return [...new Set(paths)];
}

/**
 * Mark one failing path against the declared allowlist.
 *
 * An entry covers the path on an exact match, when the failing path is an
 * ancestor dir of a declared path (go package vs. declared test file), when
 * the failing path sits inside the declared path's directory (a subpackage
 * under a declared test file's package), or when the failing path sits
 * inside a declared dir; owners union across all covering entries.
 *
 * @param path     - Repo-relative failing path.
 * @param declared - The contract's declared allowlist entries.
 * @returns The marked entry (declared with owners, or undeclared).
 */
export function markFailingTest(path: string, declared: readonly DeclaredFile[]): FailingTestEntry {
  const owners: string[] = [];
  let isDeclared = false;
  for (const entry of declared) {
    const p = entry.path.replace(/^\.\//, "");
    // The declared path's dir also covers paths inside it (go subpackages
    // reported under a declared test file's package dir).
    const dir = posix.dirname(p);
    const covers =
      p === path ||
      p.startsWith(`${path}/`) ||
      path.startsWith(`${p}/`) ||
      (dir !== "." && path.startsWith(`${dir}/`));
    if (!covers) continue;
    isDeclared = true;
    for (const owner of ownersOf(entry)) {
      if (!owners.includes(owner)) owners.push(owner);
    }
  }
  return { path, declared: isDeclared, owners };
}

/**
 * Triage every red suite of one final-gate run.
 *
 * Failing paths are extracted per red suite, mapped to repo-relative form via
 * the suite cwd, deduplicated and marked declared/undeclared with owners. A red
 * suite that yields no failing path is reported unparseable.
 *
 * @param suites   - The final-gate per-suite verdicts (with suite cwds).
 * @param declared - The contract's declared allowlist entries.
 * @returns The deduplicated failing tests plus the unparseable red suite labels.
 */
export function triageFullGate(
  suites: readonly GateSuiteResult[],
  declared: readonly DeclaredFile[],
): FullGateTriage {
  const failing: FailingTestEntry[] = [];
  const unparseableSuites: string[] = [];
  for (const suite of suites) {
    if (suite.passed) continue;
    const paths = extractFailingPaths(suite);
    if (paths.length === 0) {
      unparseableSuites.push(suite.label);
      continue;
    }
    for (const path of paths) {
      if (failing.some((f) => f.path === path)) continue;
      failing.push(markFailingTest(path, declared));
    }
  }
  return { failing, unparseableSuites };
}

/**
 * Render one failing test as a report line.
 *
 * @param entry - The marked failing test.
 * @returns e.g. `src/app.test.ts — declared (owners: T1, T2)` or
 *          `secrets.py — undeclared`.
 */
export function formatFailingTest(entry: FailingTestEntry): string {
  if (!entry.declared) return `${entry.path} — undeclared`;
  const owners = entry.owners.length > 0 ? entry.owners.join(", ") : "none";
  return `${entry.path} — declared (owners: ${owners})`;
}

/**
 * Render the T7 halt for undeclared failing tests or unparseable red output.
 *
 * No fix round runs in this case: the halt lists every failing test with its
 * declared/undeclared marking and owners, names the unparseable red suites and
 * steers to /discuss -> /finalize -> /implement.
 *
 * @param triage - The triage verdict over the red final gate.
 * @returns The halt message text.
 */
export function renderFullGateHalt(triage: FullGateTriage): string {
  const parts = [
    "## Final gate triage — undeclared failing tests or unparseable output",
    "",
    "The orchestrator's final gate is red and the failures cannot be routed to " +
      "a fix round: at least one failing test is not declared in the contract's " +
      "allowlist, or a red suite yielded no parseable failing test path. No " +
      "FULL-GATE fix unit runs.",
    "",
    "Failing tests:",
  ];
  for (const entry of triage.failing) parts.push(`- ${formatFailingTest(entry)}`);
  if (triage.unparseableSuites.length > 0) {
    parts.push("", "Unparseable red suites (no failing test path found):");
    for (const label of triage.unparseableSuites) parts.push(`- ${label}`);
  }
  parts.push(
    "",
    "Every failing test must be declared in the contract's files with its " +
      "owning task ids. Steer the user to /discuss -> /finalize -> /implement: " +
      "re-declare the affected paths there (each with an A/M/D status and its " +
      "owning tasks), then /implement resumes.",
  );
  return parts.join("\n");
}
