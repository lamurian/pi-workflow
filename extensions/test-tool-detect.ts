// Pure decision logic over INJECTED fs facts: manifest scanning is deterministic
// and testable without touching a real project. Commands are argv arrays —
// never shell strings — so the generated test extension can run them via
// pi.exec directly. Language labels reuse LANG_PROFILES (test-scan-profiles.ts),
// keeping detection in sync with the contract scan's profile table.

import { existsSync, readdirSync, readFileSync } from "node:fs";
import {
  hasPixi,
  JEST_CONFIGS,
  lockfileRunner,
  taskRunnerArgvs,
  VITEST_CONFIGS,
} from "./test-tool-detect-runners.ts";
import { nestedGoModules, walkDirs, workspacePackages } from "./test-tool-detect-nested.ts";
import { join } from "node:path";
import { LANG_PROFILES } from "./test-scan-profiles.ts";
import type { WorkflowConfig } from "./paths.ts";
import { parseTestsConfig, type ParsedTestsConfig } from "./test-suite-config.ts";

// ── Types ─────────────────────────────────────────────────────────────────────

/** One detected test suite: a human-readable label plus an argv command. */
export interface TestSuite {
  /** Human-readable label, e.g. "javascript (npm run test)". */
  label: string;
  /** Command as an argv array — never a shell string. */
  argv: string[];
  /** Routing scope: files, packages, or full (default derived from argv). */
  scope?: "files" | "packages" | "full";
  /** Repo-relative working directory of the suite (default "."). */
  cwd?: string;
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
  /** Suites the full gate runs. */
  full: TestSuite[];
  /** Config warnings (dropped suites), when any. */
  warnings?: string[];
}

/** Injected filesystem facts for one project root (the pure test seam). */
export interface DetectionFacts {
  /** True when a file exists at the project root. */
  hasFile(name: string): boolean;
  /** File content at the project root, or null when absent/unreadable. */
  readFile(name: string): string | null;
  /** Directory entries of a repo-relative dir (optional: enables the nested walk). */
  listDir?(rel: string): Array<{ name: string; dir: boolean }>;
}

// ── Data tables ───────────────────────────────────────────────────────────────

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
function suiteFor(
  manifest: string,
  argv: string[],
  scope: TestSuite["scope"],
  cwd?: string,
): TestSuite {
  const profileId = MANIFEST_PROFILES.find(([m]) => m === manifest)?.[1];
  const language =
    profileId && LANG_PROFILES.some((profile) => profile.id === profileId)
      ? profileId
      : manifest;
  const where = cwd ? ` @ ${cwd}` : "";
  const suite: TestSuite = { label: `${language} (${argv.join(" ")})${where}`, argv };
  if (scope !== "full") suite.scope = scope; // full is the derived default.
  if (cwd) suite.cwd = cwd;
  return suite;
}

/** Prefix a relative path with a package dir ("" = root). */
function under(dir: string, name: string): string {
  return dir ? `${dir}/${name}` : name;
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
  facts: DetectionFacts,
): ParsedTestsConfig | undefined {
  return parseTestsConfig(config?.implement, (rel) => facts.hasFile(rel));
}

/**
 * Derive the JS suite of one package dir ("" = root).
 *
 * Bare `vitest`/`jest` scripts (and vitest/jest configs) become scoped files
 * suites run through the lockfile exec prefix in non-watch mode; any other
 * test script becomes a full `<runner> run test` suite.
 *
 * @param facts - Injected filesystem facts.
 * @param dir   - Package directory relative to the root.
 * @returns The javascript suite, or undefined.
 */
function packageSuite(facts: DetectionFacts, dir: string): TestSuite | undefined {
  const raw = facts.readFile(under(dir, "package.json"));
  let script = "";
  if (raw !== null) {
    try {
      const parsed = JSON.parse(raw) as { scripts?: Record<string, unknown> } | null;
      const t = parsed?.scripts?.test;
      if (typeof t === "string") script = t.trim();
    } catch {
      // Broken manifest: treat as no script, never a throw.
    }
  }
  const { runner, exec } = lockfileRunner(facts);
  const cwd = dir || undefined;
  const hasVitestCfg = VITEST_CONFIGS.some((c) => facts.hasFile(under(dir, c)));
  const hasJestCfg = JEST_CONFIGS.some((c) => facts.hasFile(under(dir, c)));
  const vitest = (): TestSuite =>
    suiteFor("package.json", [...exec, "vitest", "run", "{tests}"], "files", cwd);
  const jest = (): TestSuite =>
    suiteFor("package.json", [...exec, "jest", "--ci", "{tests}"], "files", cwd);
  if (script === "vitest") return vitest();
  if (script === "jest") return jest();
  if (script) return suiteFor("package.json", [runner, "run", "test"], "full", cwd);
  if (hasVitestCfg) return vitest();
  if (hasJestCfg) return jest();
  return undefined;
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
  const configured = configSuites(config, facts);
  if (configured) {
    const out: TestSuiteDetection = {
      source: "config",
      suites: configured.scoped,
      full: configured.full,
    };
    if (configured.warnings.length > 0) out.warnings = configured.warnings;
    return out;
  }

  const suites: TestSuite[] = [];
  const dirs = walkDirs(facts);
  const js = packageSuite(facts, "");
  if (js) suites.push(js);
  for (const dir of workspacePackages(facts, dirs)) {
    const ws = packageSuite(facts, dir);
    if (ws) suites.push(ws);
  }
  const goArgv = (): string[] => ["go", "test", "{pkgs}"];
  if (facts.hasFile("go.mod")) suites.push(suiteFor("go.mod", goArgv(), "packages"));
  for (const dir of nestedGoModules(facts, dirs)) {
    suites.push(suiteFor("go.mod", goArgv(), "packages", dir));
  }
  if (facts.hasFile("Cargo.toml")) {
    suites.push(suiteFor("Cargo.toml", ["cargo", "test"], "full"));
  }
  if (facts.hasFile("pyproject.toml") || facts.hasFile("pytest.ini")) {
    const argv = hasPixi(facts)
      ? ["pixi", "run", "python", "-m", "pytest", "{tests}"]
      : ["pytest", "{tests}"];
    suites.push(suiteFor("pytest.ini", argv, "files"));
  }
  const runners = taskRunnerArgvs(facts).map(
    (argv): TestSuite => ({ label: `${argv[0]} (${argv.join(" ")})`, argv }),
  );
  const full = runners.length > 0 ? runners : suites.map((s) => ({ ...s, argv: [...s.argv] }));

  return {
    source: suites.length > 0 || full.length > 0 ? "detected" : "none",
    suites,
    full,
  };
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
    listDir: (rel) => {
      try {
        return readdirSync(join(cwd, rel), { withFileTypes: true }).map((e) => ({
          name: e.name,
          dir: e.isDirectory(),
        }));
      } catch {
        return [];
      }
    },
  };
}
