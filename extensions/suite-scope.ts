// Pure suite routing: decides which changed paths each test suite receives
// and builds the resulting argv. No fs access — all inputs are injected.

import { posix } from "node:path";
import type { TestSuite } from "./test-tool-detect.ts";

/** A contract path with its status letter (e.g. A, M, D). */
export interface RoutedPath {
  /** Repo-relative path. */
  path: string;
  /** Contract status; D paths are never routed. */
  status?: string;
}

/** Routing outcome for one suite. */
export interface SuiteRun {
  /** The suite being run. */
  suite: TestSuite;
  /** True when the suite received no paths and must not run. */
  skipped: boolean;
  /** Argv to execute (empty when skipped). */
  argv: string[];
}

type Lang = "python" | "js" | "go" | null;

const JS_EXT = /\.(ts|tsx|js|jsx)$/;

/**
 * Resolve the effective scope of a suite.
 *
 * @param suite - The suite.
 * @returns Explicit scope, else packages for `go test`, else full.
 */
export function effectiveScope(suite: TestSuite): "files" | "packages" | "full" {
  if (suite.scope) return suite.scope;
  return suite.argv[0] === "go" && suite.argv[1] === "test" ? "packages" : "full";
}

function suiteLang(suite: TestSuite): Lang {
  const a = suite.argv;
  if (a.some((p) => p === "pytest" || p.endsWith("/pytest"))) return "python";
  if (a.some((p) => p === "vitest" || p === "jest")) return "js";
  if (a[0] === "go") return "go";
  return null;
}

function pathLang(path: string): Lang {
  if (path.endsWith(".py")) return "python";
  if (path.endsWith(".go")) return "go";
  if (JS_EXT.test(path)) return "js";
  return null;
}

function normCwd(cwd: string | undefined): string {
  const n = posix.normalize(cwd ?? ".").replace(/\/+$/, "");
  return n === "" ? "." : n;
}

function contains(cwd: string, path: string): boolean {
  return cwd === "." || path === cwd || path.startsWith(`${cwd}/`);
}

function depth(cwd: string): number {
  return cwd === "." ? 0 : cwd.split("/").length;
}

/**
 * Build the unfiltered (final-gate) argv: drop {tests}, map {pkgs} to ./...
 *
 * @param suite - The suite.
 * @returns The argv for a full run.
 */
export function unfilteredArgv(suite: TestSuite): string[] {
  return suite.argv.filter((p) => p !== "{tests}").map((p) => (p === "{pkgs}" ? "./..." : p));
}

function stripPlaceholders(argv: string[]): string[] {
  return argv.filter((p) => p !== "{tests}" && p !== "{pkgs}");
}

function filesArgv(argv: string[], files: string[]): string[] {
  const i = argv.indexOf("{tests}");
  if (i < 0) return [...argv, ...files];
  return [...argv.slice(0, i), ...files, ...argv.slice(i + 1)];
}

function pkgsArgv(argv: string[], pkgs: string[]): string[] {
  let i = argv.indexOf("{pkgs}");
  if (i < 0) i = argv.indexOf("./...");
  if (i < 0) return [...stripPlaceholders(argv), ...pkgs];
  return stripPlaceholders([...argv.slice(0, i), ...pkgs, ...argv.slice(i + 1)]);
}

/**
 * Route paths to suites and build each suite's argv.
 *
 * A path goes only to the matching-language suite whose cwd is the deepest
 * ancestor of it. D-status paths are dropped. Files/packages suites with no
 * routed paths are skipped; full suites always run with placeholders removed.
 *
 * @param suites - Suites in order.
 * @param paths  - Candidate paths with contract status.
 * @returns One run per suite, in input order.
 */
export function routeSuites(suites: TestSuite[], paths: RoutedPath[]): SuiteRun[] {
  const routed = new Map<number, string[]>();
  for (const { path, status } of paths) {
    if (status === "D") continue;
    const p = posix.normalize(path);
    const lang = pathLang(p);
    if (!lang) continue;
    let best = -1;
    suites.forEach((s, idx) => {
      if (effectiveScope(s) === "full" || suiteLang(s) !== lang) return;
      const cwd = normCwd(s.cwd);
      if (!contains(cwd, p)) return;
      if (best < 0 || depth(cwd) > depth(normCwd(suites[best].cwd))) best = idx;
    });
    if (best < 0) continue;
    if (lang === "go" && !p.endsWith("_test.go")) continue;
    routed.set(best, [...(routed.get(best) ?? []), p]);
  }
  return suites.map((suite, idx) => {
    const scope = effectiveScope(suite);
    if (scope === "full") return { suite, skipped: false, argv: stripPlaceholders(suite.argv) };
    const list = routed.get(idx) ?? [];
    if (list.length === 0) return { suite, skipped: true, argv: [] };
    const cwd = normCwd(suite.cwd);
    const rel = list.map((p) => (cwd === "." ? p : posix.relative(cwd, p)));
    if (scope === "files") return { suite, skipped: false, argv: filesArgv(suite.argv, rel) };
    const dirs = [...new Set(rel.map((p) => posix.dirname(p)))];
    const pkgs = dirs.map((d) => (d === "." ? "./..." : `./${d}/...`));
    return { suite, skipped: false, argv: pkgsArgv(suite.argv, pkgs) };
  });
}
