/**
 * Guard-file helpers (T3): the orchestrator writes the contract's
 * allowlist payload to `.git/pi-workflow/contract-guard.json` before every
 * unit spawn, and passes its path to the child via the internal
 * `PI_CONTRACT_GUARD_FILE` env var. The child contract-guard extension
 * (`extensions/contract-guard/index.ts`) reads the file to enforce the
 * allowlist in-turn. Writing under `.git/` keeps the payload out of the
 * staged diff, so it can never violate the allowlist it describes.
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { DeclaredFile } from "./contract-guard-core.ts";

/**
 * Absolute path of the guard payload file for a working directory.
 *
 * @param cwd - Repository working directory (the unit spawn cwd).
 * @returns `<cwd>/.git/pi-workflow/contract-guard.json`.
 */
export function contractGuardFilePath(cwd: string): string {
  return join(resolve(cwd), ".git", "pi-workflow", "contract-guard.json");
}

/**
 * Write the guard payload for one unit spawn.
 *
 * The payload carries `repoRoot`, `baselineHead`, the declared `files`
 * allowlist (path + status) and `baselineExisting`: the declared paths
 * that already existed at the baseline, queried from git via
 * `git ls-tree -r --name-only <baseline> -- <declared paths>` (paths in
 * declaration order). A failed or empty query degrades to an empty list —
 * the allowlist decisions themselves never depend on it.
 *
 * @param pi          - ExtensionAPI used for the baseline ls-tree query.
 * @param cwd         - Repository working directory (the unit spawn cwd).
 * @param files       - The contract's declared allowlist entries.
 * @param baselineHead - The /implement baseline ref (state.baselineHead).
 * @returns Absolute path of the written guard file.
 */
export async function writeContractGuardFile(
  pi: ExtensionAPI,
  cwd: string,
  files: readonly DeclaredFile[],
  baselineHead: string,
): Promise<string> {
  const filePath = contractGuardFilePath(cwd);
  mkdirSync(dirname(filePath), { recursive: true });

  let baselineExisting: string[] = [];
  try {
    const res = await pi.exec("git", [
      "ls-tree",
      "-r",
      "--name-only",
      baselineHead,
      "--",
      ...files.map((f) => f.path),
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

  const payload = {
    repoRoot: resolve(cwd),
    baselineHead,
    files,
    baselineExisting,
  };
  writeFileSync(filePath, JSON.stringify(payload, null, 2));
  return filePath;
}
