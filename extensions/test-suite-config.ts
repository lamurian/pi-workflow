// Parses implement.tests.{scoped,full} and legacy implement.testCommands into
// scoped + full suite lists. Pure over an injected existence check.

import type { TestSuite } from "./test-tool-detect.ts";

/** Parsed suite configuration. */
export interface ParsedTestsConfig {
  /** Suites the unit-scoped test tool runs. */
  scoped: TestSuite[];
  /** Suites the full gate runs. */
  full: TestSuite[];
  /** Human-readable warnings for dropped entries. */
  warnings: string[];
}

const SCOPES = new Set(["files", "packages", "full"]);

function validArgv(raw: unknown): string[] | undefined {
  if (!Array.isArray(raw) || raw.length === 0) return undefined;
  if (!raw.every((p) => typeof p === "string" && p.length > 0)) return undefined;
  return [...(raw as string[])];
}

function cwdProblem(cwd: string, dirExists: (rel: string) => boolean): string | undefined {
  if (cwd.startsWith("/") || /^[A-Za-z]:[\\/]/.test(cwd)) return "is absolute";
  if (cwd.split(/[\\/]/).includes("..")) return "contains '..'";
  if (!dirExists(cwd)) return "does not exist under the repo root";
  return undefined;
}

function parseEntry(
  entry: unknown,
  allowScope: boolean,
  dirExists: (rel: string) => boolean,
  warnings: string[],
): TestSuite | undefined {
  const obj = !Array.isArray(entry) && entry && typeof entry === "object"
    ? (entry as Record<string, unknown>)
    : undefined;
  const argv = validArgv(obj ? obj.argv : entry);
  if (!argv) return undefined;
  const label = `config (${argv.join(" ")})`;
  const suite: TestSuite = { label, argv };
  if (obj) {
    if (allowScope && typeof obj.scope === "string" && SCOPES.has(obj.scope)) {
      suite.scope = obj.scope as TestSuite["scope"];
    }
    if (typeof obj.cwd === "string" && obj.cwd !== "" && obj.cwd !== ".") {
      const problem = cwdProblem(obj.cwd, dirExists);
      if (problem) {
        warnings.push(`suite '${label}' dropped: cwd '${obj.cwd}' ${problem}`);
        return undefined;
      }
      suite.cwd = obj.cwd;
    }
  }
  return suite;
}

/**
 * Parse implement.tests / implement.testCommands into scoped and full lists.
 *
 * @param implement - The raw implement config section.
 * @param dirExists - Existence check for a repo-relative path.
 * @returns The parsed lists, or undefined when no entry survives (no override).
 */
export function parseTestsConfig(
  implement: { tests?: unknown; testCommands?: unknown } | undefined,
  dirExists: (rel: string) => boolean,
): ParsedTestsConfig | undefined {
  const warnings: string[] = [];
  const tests = implement?.tests as { scoped?: unknown; full?: unknown } | undefined;
  if (tests && typeof tests === "object") {
    const scoped: TestSuite[] = [];
    const full: TestSuite[] = [];
    if (Array.isArray(tests.scoped)) {
      for (const e of tests.scoped) {
        const s = parseEntry(e, true, dirExists, warnings);
        if (s) scoped.push(s);
      }
    }
    if (Array.isArray(tests.full)) {
      for (const e of tests.full) {
        const s = parseEntry(e, false, dirExists, warnings);
        if (s) full.push(s);
      }
    }
    if (scoped.length > 0 || full.length > 0) return { scoped, full, warnings };
  }
  const raw = implement?.testCommands;
  if (!Array.isArray(raw)) return undefined;
  const scoped: TestSuite[] = [];
  const full: TestSuite[] = [];
  for (const entry of raw) {
    const argv = validArgv(entry);
    if (!argv) continue;
    const label = `config (${argv.join(" ")})`;
    const scope = argv[0] === "go" && argv[1] === "test" ? "packages" : "full";
    scoped.push({ label, argv, scope });
    full.push({ label, argv: [...argv] });
  }
  return scoped.length > 0 ? { scoped, full, warnings } : undefined;
}
