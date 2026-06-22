import { access, readFile } from "node:fs/promises";
import { join } from "node:path";

/** Result of scanning a project for existing hook configurations. */
export interface DetectedHooks {
  /** Detected pre-commit hook configuration, if any. */
  preCommit: { framework: string; detail: string } | null;
  /** Detected pre-push hook configuration, if any. */
  prePush: { detail: string } | null;
}

/**
 * Check whether a file or directory exists at the given path.
 *
 * @param path - Absolute path to check.
 * @returns `true` if the path exists.
 */
async function exists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

/**
 * Scan a project directory for existing pre-commit and pre-push hook
 * configurations. Checks common locations:
 *
 * - `.husky/` (husky framework)
 * - `lefthook.yml` / `.lefthook.yml` (lefthook framework)
 * - `.pre-commit-config.yaml` (pre-commit Python framework)
 * - `.githooks/` (shared git hooks directory, e.g. for `core.hooksPath`)
 * - `.git/hooks/` (legacy local git hooks)
 *
 * @param cwd - Project root directory to scan.
 * @returns Detected hook configurations (both may be null).
 */
export async function detectExistingHooks(cwd: string): Promise<DetectedHooks> {
  const detected: DetectedHooks = { preCommit: null, prePush: null };

  // ── husky ──────────────────────────────────────────────────
  const huskyPreCommit = join(cwd, ".husky", "pre-commit");
  const huskyPrePush = join(cwd, ".husky", "pre-push");

  if (await exists(huskyPreCommit)) {
    detected.preCommit = {
      framework: "husky",
      detail: "husky (detected .husky/pre-commit)",
    };
  }
  if (await exists(huskyPrePush)) {
    detected.prePush = {
      detail: "husky pre-push (detected .husky/pre-push)",
    };
  }

  // ── lefthook ───────────────────────────────────────────────
  for (const fileName of ["lefthook.yml", ".lefthook.yml"]) {
    const lefthookPath = join(cwd, fileName);
    if (await exists(lefthookPath)) {
      try {
        const content = await readFile(lefthookPath, "utf-8");
        if (/^pre-commit:/m.test(content) && !detected.preCommit) {
          detected.preCommit = {
            framework: "lefthook",
            detail: `lefthook (detected ${fileName} with pre-commit)`,
          };
        }
        if (/^pre-push:/m.test(content) && !detected.prePush) {
          detected.prePush = {
            detail: `lefthook pre-push (detected ${fileName} with pre-push)`,
          };
        }
      } catch {
        // Ignore read errors silently
      }
    }
  }

  // ── pre-commit Python framework ────────────────────────────
  const preCommitConfig = join(cwd, ".pre-commit-config.yaml");
  if (await exists(preCommitConfig) && !detected.preCommit) {
    detected.preCommit = {
      framework: "pre-commit",
      detail: "pre-commit (detected .pre-commit-config.yaml)",
    };
  }

  // ── .githooks/ (shared hooks for core.hooksPath) ───────────
  const githooksPreCommit = join(cwd, ".githooks", "pre-commit");
  const githooksPrePush = join(cwd, ".githooks", "pre-push");

  if (await exists(githooksPreCommit) && !detected.preCommit) {
    detected.preCommit = {
      framework: "custom (.githooks)",
      detail: "custom (.githooks/pre-commit)",
    };
  }
  if (await exists(githooksPrePush) && !detected.prePush) {
    detected.prePush = {
      detail: "custom (.githooks/pre-push)",
    };
  }

  // ── .git/hooks/ (legacy local hooks) ───────────────────────
  const gitHooksPreCommit = join(cwd, ".git", "hooks", "pre-commit");
  const gitHooksPrePush = join(cwd, ".git", "hooks", "pre-push");

  if (await exists(gitHooksPreCommit) && !detected.preCommit) {
    detected.preCommit = {
      framework: "custom (.git/hooks)",
      detail: "custom (.git/hooks/pre-commit)",
    };
  }
  if (await exists(gitHooksPrePush) && !detected.prePush) {
    detected.prePush = {
      detail: "custom (.git/hooks/pre-push)",
    };
  }

  return detected;
}
