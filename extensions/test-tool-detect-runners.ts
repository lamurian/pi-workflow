// Task-runner and package-manager detection over injected facts: pixi/mise/make
// full suites, lockfile runners and exec prefixes, and the pixi env wrapper.

import type { DetectionFacts } from "./test-tool-detect.ts";

/** Lockfile → [runner, exec prefix], checked in order (pnpm wins). */
const LOCKFILE_RUNNERS: ReadonlyArray<readonly [string, string, string[]]> = [
  ["pnpm-lock.yaml", "pnpm", ["pnpm", "exec"]],
  ["yarn.lock", "yarn", ["yarn"]],
  ["bun.lockb", "bun", ["bunx"]],
];

/** Vitest config filenames recognized at a suite root. */
export const VITEST_CONFIGS = [
  "vitest.config.ts",
  "vitest.config.mts",
  "vitest.config.cts",
  "vitest.config.js",
  "vitest.config.mjs",
  "vitest.config.cjs",
];

/** Jest config filenames recognized at a suite root. */
export const JEST_CONFIGS = [
  "jest.config.ts",
  "jest.config.js",
  "jest.config.mjs",
  "jest.config.cjs",
  "jest.config.json",
];

/**
 * Package-manager runner and exec prefix derived from the root lockfile.
 *
 * @param facts - Injected filesystem facts (root).
 * @returns The runner (npm/pnpm/yarn/bun) and exec argv prefix.
 */
export function lockfileRunner(facts: DetectionFacts): { runner: string; exec: string[] } {
  const hit = LOCKFILE_RUNNERS.find(([lock]) => facts.hasFile(lock));
  return hit ? { runner: hit[1], exec: [...hit[2]] } : { runner: "npm", exec: ["npx"] };
}

/** True when a `test` key is defined inside the TOML table `table`. */
function tomlHasTestTask(text: string, table: string): boolean {
  const lines = text.split(/\r?\n/);
  const header = `[${table}]`;
  if (lines.some((l) => l.trim() === `[${table}.test]`)) return true;
  let inside = false;
  for (const raw of lines) {
    const line = raw.trim();
    if (line.startsWith("[")) {
      inside = line === header;
      continue;
    }
    if (inside && /^"?test"?\s*=/.test(line)) return true;
  }
  return false;
}

/**
 * True when pixi manages the project environment.
 *
 * @param facts - Injected filesystem facts.
 * @returns Whether pixi.toml exists or pyproject.toml has a [tool.pixi] table.
 */
export function hasPixi(facts: DetectionFacts): boolean {
  if (facts.hasFile("pixi.toml")) return true;
  const py = facts.readFile("pyproject.toml");
  return py !== null && /^\[tool\.pixi[.\]]/m.test(py);
}

/**
 * Detect task-runner full suites: pixi, mise, make (in that order).
 *
 * @param facts - Injected filesystem facts.
 * @returns The argv of every detected task-runner test command.
 */
export function taskRunnerArgvs(facts: DetectionFacts): string[][] {
  const out: string[][] = [];
  const pixi = facts.readFile("pixi.toml");
  const py = facts.readFile("pyproject.toml");
  if (
    (pixi !== null && tomlHasTestTask(pixi, "tasks")) ||
    (py !== null && tomlHasTestTask(py, "tool.pixi.tasks"))
  ) {
    out.push(["pixi", "run", "test"]);
  }
  for (const name of ["mise.toml", ".mise.toml"]) {
    const text = facts.readFile(name);
    if (text !== null && tomlHasTestTask(text, "tasks")) {
      out.push(["mise", "run", "test"]);
      break;
    }
  }
  const make = facts.readFile("Makefile");
  if (make !== null && /^test\s*:/m.test(make)) out.push(["make", "test"]);
  return out;
}
