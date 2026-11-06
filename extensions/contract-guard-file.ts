/**
 * Unit payload helpers (T3/T5): the orchestrator writes the per-spawn
 * payload to `.pi/workflow/contract-guard.json` before every unit spawn
 * and passes its path to the child via `PI_UNIT_FILE`
 * (`PI_CONTRACT_GUARD_FILE` stays as the child guard's read-fallback for
 * one release). With a v2 contract the payload carries the derived
 * `allowlist` and the unit's slice `unit { id, sources, tests, testFiles,
 * packages, testSuites }` (both derived via contract-derive); v1 sessions
 * keep writing the plain `files` allowlist. The payload stays out of the
 * staged diff because the `.pi/workflow` folder self-ignores (its own
 * `.gitignore` holds `*`), not because it lives under `.git/` — so it can
 * never violate the allowlist it describes.
 */

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { WORKFLOW_RUNTIME_DIR, type DeclaredFile } from "./contract-guard-core.ts";
import { deriveAllowlist, deriveUnitScope } from "./contract-derive.ts";
import type { ContractV2 } from "./state.ts";
import type { TestSuite } from "./test-tool-detect.ts";

/** v2 slice options for one unit spawn (T5). */
export interface UnitPayloadOptions {
  /** The v2 contract: the allowlist and unit scope derive from it. */
  contract?: ContractV2;
  /** The unit's task id (the unit slice key). */
  taskId?: string;
  /** Test suites recorded in state.testTool (payload `unit.testSuites`). */
  testSuites?: readonly TestSuite[];
  /**
   * T7: grant the FULL-GATE fix unit write/edit on EVERY declared path
   * regardless of task ownership. Written as payload `ownsAll: true`; the
   * child guard then skips the per-task ownership check (undeclared paths
   * and D-status rules still block).
   */
  ownsAll?: boolean;
}

/**
 * Absolute path of the payload file for a working directory.
 *
 * @param cwd - Repository working directory (the unit spawn cwd).
 * @returns `<cwd>/.pi/workflow/contract-guard.json`.
 */
export function contractGuardFilePath(cwd: string): string {
  return resolve(cwd, WORKFLOW_RUNTIME_DIR, "contract-guard.json");
}

/**
 * Ensure the per-spawn runtime dir exists and self-ignores.
 *
 * Creates `<cwd>/.pi/workflow` (recursive) and writes a `.gitignore`
 * containing `*` whenever it is missing or differs, so the payload folder
 * never shows up in `git status` or the staged diff.
 *
 * @param cwd - Repository working directory (the unit spawn cwd).
 * @returns Absolute path of the runtime directory.
 */
export function ensureWorkflowRuntimeDir(cwd: string): string {
  const dir = resolve(cwd, WORKFLOW_RUNTIME_DIR);
  mkdirSync(dir, { recursive: true });
  const gitignore = resolve(dir, ".gitignore");
  let existing: string | undefined;
  try {
    existing = readFileSync(gitignore, "utf8");
  } catch {
    existing = undefined;
  }
  if (existing !== "*") writeFileSync(gitignore, "*");
  return dir;
}

/**
 * Write the per-spawn payload for one unit.
 *
 * v2 mode (`options.contract` + `options.taskId`): the payload carries
 * `repoRoot`, `baselineHead`, the derived `allowlist` (contract-derive
 * union of sources+tests) and `unit { id, sources, tests, testFiles,
 * packages, testSuites }` (the unit's derived slice). v1 mode: the payload
 * keeps the plain `files` allowlist. Both modes also carry `baselineExisting`: the
 * declared paths present at the baseline, queried via
 * `git ls-tree -r --name-only <baseline> -- <paths>`; a failed or empty
 * query degrades to an empty list — the allowlist decisions never depend
 * on it.
 *
 * @param pi          - ExtensionAPI used for the baseline ls-tree query.
 * @param cwd         - Repository working directory (the unit spawn cwd).
 * @param files       - The declared allowlist entries (v1: the contract's
 *                      files; v2: the derived allowlist, used for ls-tree).
 * @param baselineHead - The /implement baseline ref (state.baselineHead).
 * @param options     - v2 slice options (contract, taskId, testSuites).
 * @returns Absolute path of the written payload file.
 */
export async function writeContractGuardFile(
  pi: ExtensionAPI,
  cwd: string,
  files: readonly DeclaredFile[],
  baselineHead: string,
  options: UnitPayloadOptions = {},
): Promise<string> {
  const filePath = contractGuardFilePath(cwd);
  ensureWorkflowRuntimeDir(cwd);

  const contract = options.contract;
  const taskId = options.taskId;
  const slice = contract && taskId !== undefined ? deriveUnitScope(contract, taskId) : undefined;
  const declaredPaths = contract ? deriveAllowlist(contract).map((e) => e.path) : files.map((f) => f.path);

  let baselineExisting: string[] = [];
  try {
    const res = await pi.exec("git", [
      "ls-tree",
      "-r",
      "--name-only",
      baselineHead,
      "--",
      ...declaredPaths,
    ]);
    if (res.code === 0) {
      baselineExisting = res.stdout
        .split("\n")
        .map((line) => line.trim())
        .filter((line) => line.length > 0);
    }
  } catch {
    // Baseline unavailable — the payload still carries the allowlist.
  }

  const base = {
    repoRoot: resolve(cwd),
    baselineHead,
    baselineExisting,
    ...(options.ownsAll ? { ownsAll: true } : {}),
  };
  const payload =
    contract && taskId !== undefined && slice
      ? {
          ...base,
          allowlist: deriveAllowlist(contract),
          unit: {
            id: taskId,
            sources: slice.sources,
            tests: slice.tests,
            testFiles: slice.testFiles,
            packages: slice.packages,
            testSuites: [...(options.testSuites ?? [])],
          },
        }
      : { ...base, files };
  writeFileSync(filePath, JSON.stringify(payload, null, 2));
  return filePath;
}
