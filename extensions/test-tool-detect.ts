// Pure decision logic over INJECTED fs facts: manifest scanning is deterministic
// and testable without touching a real project. Commands are argv arrays —
// never shell strings — so the generated test extension can run them via
// pi.exec directly. Language labels reuse LANG_PROFILES (test-scan-profiles.ts),
// keeping detection in sync with the contract scan's profile table.

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { LANG_PROFILES } from "./test-scan-profiles.ts";
import type { WorkflowConfig } from "./paths.ts";

// ── Types ─────────────────────────────────────────────────────────────────────

/** One detected test suite: a human-readable label plus an argv command. */
export interface TestSuite {
  /** Human-readable label, e.g. "javascript (npm run test)". */
  label: string;
  /** Command as an argv array — never a shell string. */
  argv: string[];
}

/**
 * Where the suites came from: `config` (implement.testCommands override),
 * `existing` (a session tool named `test` already owns the name — set by the
 * ensure step, never by detection), `detected` (manifest scan), `none`.
 */
export type TestSuiteSource = "config" | "existing" | "detected" | "none";

/** Result of test-suite detection. */
export interface TestSuiteDetection {
  /** Origin of the suites. */
  source: TestSuiteSource;
  /** Every detected suite, in deterministic order. */
  suites: TestSuite[];
}

/** Injected filesystem facts for one project root (the pure test seam). */
export interface DetectionFacts {
  /** True when a file exists at the project root. */
  hasFile(name: string): boolean;
  /** File content at the project root, or null when absent/unreadable. */
  readFile(name: string): string | null;
}

// ── Data tables ───────────────────────────────────────────────────────────────

/** Lockfile → package-manager runner, checked in order (pnpm wins). */
const LOCKFILE_RUNNERS: ReadonlyArray<readonly [lockfile: string, runner: string]> = [
  ["pnpm-lock.yaml", "pnpm"],
  ["yarn.lock", "yarn"],
  ["bun.lockb", "bun"],
];

/** Manifest → LANG_PROFILES id (labels stay in sync with the profile table). */
const MANIFEST_PROFILES: ReadonlyArray<readonly [manifest: string, profileId: string]> = [
  ["package.json", "javascript"],
  ["go.mod", "go"],
  ["Cargo.toml", "rust"],
  ["pyproject.toml", "python"],
  ["pytest.ini", "python"],
];

// ── Helpers ───────────────────────────────────────────────────────────────────

/**
 * Build a suite whose label language prefix is a LANG_PROFILES id.
 *
 * Manifests without a language profile (the Makefile) fall back to "make".
 *
 * @param manifest - Manifest name the suite was derived from.
 * @param argv     - The suite command as an argv array.
 * @returns The labeled suite.
 */
function suiteFor(manifest: string, argv: string[]): TestSuite {
  const profileId = MANIFEST_PROFILES.find(([m]) => m === manifest)?.[1];
  const language =
    profileId && LANG_PROFILES.some((profile) => profile.id === profileId)
      ? profileId
      : "make";
  return { label: `${language} (${argv.join(" ")})`, argv };
}

/**
 * Extract validated argv suites from `implement.testCommands`.
 *
 * Non-array-conforming entries are dropped; when no entry survives (including
 * an empty array), the override is treated as unset and detection proceeds.
 *
 * @param config - Optional workflow config carrying `implement.testCommands`.
 * @returns The configured suites, or undefined when no override applies.
 */
function configSuites(
  config: Pick<WorkflowConfig, "implement"> | undefined,
): TestSuite[] | undefined {
  const raw = config?.implement?.testCommands;
  if (!Array.isArray(raw)) return undefined;
  const suites: TestSuite[] = [];
  for (const entry of raw) {
    if (!Array.isArray(entry) || entry.length === 0) continue;
    if (!entry.every((part) => typeof part === "string" && part.length > 0)) continue;
    const argv = [...entry];
    suites.push({ label: `config (${argv.join(" ")})`, argv });
  }
  return suites.length > 0 ? suites : undefined;
}

/**
 * Derive the package suite from package.json's scripts.test.
 *
 * The runner comes from the lockfile (pnpm/yarn/bun, else npm). Watch-mode
 * hazard: a bare `vitest` or `jest` script would attach to the TTY and watch
 * forever, so those map to the safe non-watch argv `vitest run` / `jest --ci`.
 *
 * @param facts - Injected filesystem facts.
 * @returns The javascript suite, or undefined when package.json has no test script.
 */
function packageSuite(facts: DetectionFacts): TestSuite | undefined {
  const raw = facts.readFile("package.json");
  if (raw === null) return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return undefined; // Broken manifest: no suite, never a throw.
  }
  const script = (parsed as { scripts?: Record<string, unknown> } | null)?.scripts?.test;
  if (typeof script !== "string" || !script.trim()) return undefined;
  const trimmed = script.trim();
  if (trimmed === "vitest") return suiteFor("package.json", ["vitest", "run"]);
  if (trimmed === "jest") return suiteFor("package.json", ["jest", "--ci"]);
  const runner = LOCKFILE_RUNNERS.find(([lockfile]) => facts.hasFile(lockfile))?.[1] ?? "npm";
  return suiteFor("package.json", [runner, "run", "test"]);
}

/**
 * Detect a `test:` target in the project Makefile.
 *
 * @param facts - Injected filesystem facts.
 * @returns The make suite, or undefined when no Makefile or no test target.
 */
function makeSuite(facts: DetectionFacts): TestSuite | undefined {
  if (!facts.hasFile("Makefile")) return undefined;
  const text = facts.readFile("Makefile");
  if (text === null || !/^test\s*:/m.test(text)) return undefined;
  return suiteFor("Makefile", ["make", "test"]);
}

// ── Detection ─────────────────────────────────────────────────────────────────

/**
 * Detect every test suite declared by the project's manifests.
 *
 * Scanning is total: every matching toolchain contributes one suite
 * (multi-language repos get one suite per toolchain) in a fixed order —
 * javascript, go, rust, python, make — so results are deterministic.
 *
 * Precedence: a non-empty `implement.testCommands` config overrides detection
 * entirely (source `config`, argv arrays used as-is, facts never consulted).
 * Otherwise manifests are scanned (source `detected`); a project without any
 * matching manifest yields `{ source: "none", suites: [] }`.
 *
 * @param facts  - Injected filesystem facts for the project root.
 * @param config - Optional workflow config carrying `implement.testCommands`.
 * @returns The suites plus where they came from.
 */
export function detectTestSuites(
  facts: DetectionFacts,
  config?: Pick<WorkflowConfig, "implement">,
): TestSuiteDetection {
  const configured = configSuites(config);
  if (configured) return { source: "config", suites: configured };

  const suites: TestSuite[] = [];
  const js = packageSuite(facts);
  if (js) suites.push(js);
  if (facts.hasFile("go.mod")) suites.push(suiteFor("go.mod", ["go", "test", "./..."]));
  if (facts.hasFile("Cargo.toml")) suites.push(suiteFor("Cargo.toml", ["cargo", "test"]));
  if (facts.hasFile("pyproject.toml") || facts.hasFile("pytest.ini")) {
    suites.push(suiteFor("pytest.ini", ["pytest"]));
  }
  const make = makeSuite(facts);
  if (make) suites.push(make);

  return { source: suites.length > 0 ? "detected" : "none", suites };
}

/**
 * Build real filesystem facts for one project root.
 *
 * @param cwd - Project root directory.
 * @returns Facts backed by node:fs, rooted at `cwd`.
 */
export function projectFacts(cwd: string): DetectionFacts {
  return {
    hasFile: (name) => existsSync(join(cwd, name)),
    readFile: (name) => {
      try {
        return readFileSync(join(cwd, name), "utf8");
      } catch {
        return null;
      }
    },
  };
}
