// ── Slop gate runner (T4) ────────────────────────────────────────────────────
// runSlopGate drives the staged git/scanner commands through pi.exec and hands
// the parsed facts to classifySlop; resolveSlopGate loads workflow.json and
// returns a runner bound to the resolved config, or undefined when mode is off.

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { SlopConfig, SlopMode } from "./slop-config.ts";
import { resolveSlopConfig } from "./slop-config.ts";
import { loadWorkflowConfig } from "./paths.ts";
import { partitionStagedPaths, resolveSlopTool } from "./slop-detect.ts";
import {
  classifySlop,
  parseAddedLines,
  parseAislopJson,
  parseWritingScore,
} from "./slop-scan.ts";
import type { AislopReport, ProseScore, SlopVerdict } from "./slop-scan.ts";

// ── Types ─────────────────────────────────────────────────────────────────────

/** Gate runner bound to a resolved config: its mode plus the run function. */
export interface SlopGateRunner {
  /** Resolved gate mode (never "off"). */
  mode: SlopMode;
  /** Run the gate against the staged state of the bound working directory. */
  run(pi: ExtensionAPI): Promise<SlopVerdict>;
}

/** Subprocess answer the gate needs: exit code plus stdout. */
interface ToolRun {
  code: number;
  stdout: string;
}

// ── Verdict helpers ───────────────────────────────────────────────────────────

/** Build the clean verdict (no notes, no violations, no investigation). */
function clean(): SlopVerdict {
  return { kind: "clean", notes: [], violations: [], investigation: "" };
}

/**
 * Build the never-blocking unavailable verdict.
 *
 * @param reason - Why the gate could not run (tool missing, bad output, …).
 * @returns An annotate verdict carrying one `slop gate unavailable:` note.
 */
function unavailable(reason: string): SlopVerdict {
  return {
    kind: "annotate",
    notes: [`slop gate unavailable: ${reason}`],
    violations: [],
    investigation: "",
  };
}

// ── git readers ───────────────────────────────────────────────────────────────

/**
 * List staged paths with a changed (non-deleted) entry.
 *
 * @param pi  - ExtensionAPI reference (for exec access).
 * @param cwd - Working directory of the repository.
 * @returns Staged paths, or [] when git fails (treated as nothing to gate).
 */
async function readStagedPaths(
  pi: ExtensionAPI,
  cwd: string,
): Promise<string[]> {
  try {
    const res = await pi.exec(
      "git",
      ["diff", "--cached", "--name-only", "--diff-filter=d"],
      { cwd },
    );
    if (res.code !== 0) return [];
    return (res.stdout ?? "")
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line !== "");
  } catch {
    return [];
  }
}

/**
 * Read the staged diff with zero context (baseline mode added-line facts).
 *
 * @param pi  - ExtensionAPI reference (for exec access).
 * @param cwd - Working directory of the repository.
 * @returns Added line numbers per path; empty when git fails.
 */
async function readAddedLines(
  pi: ExtensionAPI,
  cwd: string,
): Promise<Map<string, number[]>> {
  try {
    const res = await pi.exec("git", ["diff", "--cached", "-U0"], { cwd });
    if (res.code !== 0) return new Map();
    return parseAddedLines(res.stdout ?? "");
  } catch {
    return new Map();
  }
}

// ── Tool runners ──────────────────────────────────────────────────────────────

/**
 * Run a resolved tool argv with extra arguments appended.
 *
 * @param pi    - ExtensionAPI reference (for exec access).
 * @param argv  - Resolved tool argv (executable first, e.g. from resolveSlopTool).
 * @param args  - Arguments to append (e.g. `["scan", "--staged", "--json"]`).
 * @param cwd   - Working directory for the run.
 * @returns The run's code and stdout, or null when the tool could not run.
 */
async function runTool(
  pi: ExtensionAPI,
  argv: string[],
  args: string[],
  cwd: string,
): Promise<ToolRun | null> {
  const [cmd = "", ...prefix] = argv;
  try {
    const res = await pi.exec(cmd, [...prefix, ...args], { cwd });
    if (res.code !== 0) return null;
    return { code: res.code, stdout: res.stdout ?? "" };
  } catch {
    return null;
  }
}

/**
 * Score one target file with the prose tool.
 *
 * @param pi     - ExtensionAPI reference (for exec access).
 * @param argv   - Resolved zero-slop argv.
 * @param cwd    - Working directory for the run.
 * @param target - File to score (staged path or temp copy of the HEAD version).
 * @returns The score, or null when the run failed or the output is unparseable.
 */
async function scoreTarget(
  pi: ExtensionAPI,
  argv: string[],
  cwd: string,
  target: string,
): Promise<number | null> {
  const run = await runTool(pi, argv, ["score", target], cwd);
  if (run === null) return null;
  return parseWritingScore(run.stdout);
}

/**
 * Score the HEAD version of a staged prose path (baseline mode).
 *
 * `git show HEAD:<path>` is written to a temp file that keeps the original
 * basename (so the tool sees the right extension), scored, then removed.
 *
 * @param pi   - ExtensionAPI reference (for exec access).
 * @param argv - Resolved zero-slop argv.
 * @param cwd  - Working directory of the repository.
 * @param path - Staged prose path (git style, `/` separators).
 * @returns The HEAD score, or null when the path is absent at HEAD or the
 *          score cannot be obtained (the path is then treated as new).
 */
async function headScore(
  pi: ExtensionAPI,
  argv: string[],
  cwd: string,
  path: string,
): Promise<number | null> {
  let content: string;
  try {
    const res = await pi.exec("git", ["show", `HEAD:${path}`], { cwd });
    if (res.code !== 0) return null;
    content = res.stdout ?? "";
  } catch {
    return null;
  }

  let dir: string | null = null;
  try {
    dir = mkdtempSync(join(tmpdir(), "slop-head-"));
    const file = join(dir, basename(path));
    writeFileSync(file, content, "utf-8");
    return await scoreTarget(pi, argv, cwd, file);
  } catch {
    return null;
  } finally {
    if (dir !== null) rmSync(dir, { recursive: true, force: true });
  }
}

// ── Gate runner ───────────────────────────────────────────────────────────────

/**
 * Run the slop gate against the staged state and classify the result.
 *
 * Flow:
 * 1. Mode `off` → clean verdict with zero exec calls.
 * 2. `git diff --cached --name-only --diff-filter=d` → partition into code and
 *    prose; both buckets empty → clean without resolving any tool.
 * 3. Baseline mode reads `git diff --cached -U0` for added-line facts.
 * 4. Code staged → resolve aislop, run `<argv> scan --staged --json`, parse.
 * 5. Prose staged → resolve zero-slop, run `<argv> score <path>` once per path;
 *    baseline additionally scores the HEAD version from a temp file written
 *    from `git show HEAD:<path>` (skipped when the path is absent at HEAD).
 * 6. An unresolvable tool or unparseable output yields a never-blocking
 *    `slop gate unavailable:` note; otherwise classifySlop decides.
 *
 * @param pi     - ExtensionAPI reference (for exec access).
 * @param cwd    - Working directory of the repository.
 * @param config - Resolved slop gate configuration.
 * @returns The gate verdict: `clean`, `annotate` (notes) or `block`.
 */
export async function runSlopGate(
  pi: ExtensionAPI,
  cwd: string,
  config: SlopConfig,
): Promise<SlopVerdict> {
  if (config.mode === "off") return clean();

  const staged = await readStagedPaths(pi, cwd);
  const { code, prose } = partitionStagedPaths(staged);
  if (code.length === 0 && prose.length === 0) return clean();

  const addedLines =
    config.mode === "baseline"
      ? await readAddedLines(pi, cwd)
      : new Map<string, number[]>();

  let report: AislopReport | null = null;
  if (code.length > 0) {
    const argv = await resolveSlopTool(pi, cwd, "aislop", config.fetchFallback);
    if (argv === null) return unavailable("aislop could not be resolved");
    const run = await runTool(pi, argv, ["scan", "--staged", "--json"], cwd);
    if (run === null) return unavailable("aislop failed to run");
    report = parseAislopJson(run.stdout);
    if (report === null) return unavailable("aislop output could not be parsed");
  }

  const proseScores: ProseScore[] = [];
  if (prose.length > 0) {
    const argv = await resolveSlopTool(
      pi,
      cwd,
      "zero-slop",
      config.fetchFallback,
    );
    if (argv === null) return unavailable("zero-slop could not be resolved");
    for (const path of prose) {
      const stagedScore = await scoreTarget(pi, argv, cwd, path);
      if (stagedScore === null) {
        return unavailable(`zero-slop could not score ${path}`);
      }
      const head =
        config.mode === "baseline"
          ? await headScore(pi, argv, cwd, path)
          : null;
      proseScores.push({ path, staged: stagedScore, head });
    }
  }

  return classifySlop({ aislop: report, prose: proseScores, addedLines }, config);
}

// ── Config resolution ─────────────────────────────────────────────────────────

/**
 * Resolve the slop gate runner for a working directory.
 *
 * Loads workflow.json (defaults ← global ← project-local), resolves the slop
 * config against `env` (`PI_SLOP_GATE` overrides the configured mode), and
 * returns a runner bound to that config. Mode `off` yields undefined so
 * callers can skip the gate entirely.
 *
 * @param cwd - Project working directory.
 * @param env - Environment map read for `PI_SLOP_GATE`. Defaults to process.env.
 * @returns The runner, or undefined when the resolved mode is `off`.
 */
export async function resolveSlopGate(
  cwd: string,
  env: Record<string, string | undefined> = process.env,
): Promise<SlopGateRunner | undefined> {
  const workflow = await loadWorkflowConfig(cwd);
  const config = resolveSlopConfig(workflow.implement?.slop, env);
  if (config.mode === "off") return undefined;
  return {
    mode: config.mode,
    run: (pi: ExtensionAPI) => runSlopGate(pi, cwd, config),
  };
}
