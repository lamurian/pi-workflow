// ─── Guard diff helpers ───────────────────────────────────────────────────────
// Staged-diff reads and cross-task contamination handling used by the commit
// gate (git-commit-gate.ts). Split out of git-ops.ts to keep every module
// within the line budget.

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
  formatDeclaredList,
  TEST_EXTENSION_PATH,
  type DeclaredFile,
} from "./contract-guard-core.ts";
import type { ContaminatedPath } from "./contract-guard-diff.ts";

/** A contract-guard halt produced while preparing the staged set. */
export interface GuardHalt {
  kind: "contract-guard";
  violations: string[];
  investigation: string;
}

/** Result of unstaging cross-task contamination: remediation lines or a halt. */
export type UnstageResult =
  | { ok: true; remediation: string[] }
  | { ok: false; halt: GuardHalt };

/**
 * Append the cross-task remediation note to a guard investigation.
 *
 * @param investigation - The base investigation text.
 * @param remediation   - Remediation-note lines (empty leaves the text as-is).
 * @returns The investigation with the remediation block appended.
 */
export function withRemediation(investigation: string, remediation: string[]): string {
  if (remediation.length === 0) return investigation;
  return (
    investigation +
    "\n\nCross-task contamination auto-unstaged before gating (work stays on disk):\n" +
    remediation.map((line) => `  - ${line}`).join("\n")
  );
}

/**
 * Read `git diff --cached --name-status --no-renames <ref>` for the allowlist
 * and test-guard checks. Falls back to HEAD output on a failed diff so a bad
 * baseline never bricks the gate (hooks still gate the commit).
 *
 * @param pi  - ExtensionAPI reference.
 * @param cwd - Working directory.
 * @param ref - Baseline ref (baselineHead or "HEAD").
 * @returns Raw name-status output, or "" when git fails.
 */
export async function runBaselineNameStatus(
  pi: ExtensionAPI,
  cwd: string,
  ref: string,
): Promise<string> {
  try {
    const res = await pi.exec(
      "git",
      ["diff", "--cached", "--name-status", "--no-renames", ref],
      { cwd },
    );
    if (res.code === 0) return res.stdout ?? "";
    if (ref !== "HEAD") {
      const fallback = await pi.exec(
        "git",
        ["diff", "--cached", "--name-status", "--no-renames", "HEAD"],
        { cwd },
      );
      if (fallback.code === 0) return fallback.stdout ?? "";
    }
    return "";
  } catch {
    return "";
  }
}

/**
 * Read the HEAD-relative staged set (`git diff --cached --name-status
 * --no-renames HEAD`): only paths whose index entry differs from HEAD are
 * actually staged. A file committed since the /implement baseline appears in
 * the baseline diff but not here, so it can never be contamination.
 *
 * @param pi  - ExtensionAPI reference.
 * @param cwd - Working directory.
 * @returns Raw name-status output of the staged set, or "" when git fails.
 */
export async function runHeadStagedNameStatus(
  pi: ExtensionAPI,
  cwd: string,
): Promise<string> {
  return runBaselineNameStatus(pi, cwd, "HEAD");
}

/**
 * Whether one name-status line names the orchestrator-owned test extension.
 *
 * @param line - One `<status>\t<path>` line (from --no-renames output).
 * @returns True when the line's path is TEST_EXTENSION_PATH.
 */
function isTestExtensionLine(line: string): boolean {
  const path = line.split("\t")[1]?.trim().replace(/^\.\//, "");
  return path === TEST_EXTENSION_PATH;
}

/**
 * Drop the orchestrator-owned test extension from a baseline name-status.
 *
 * The orchestrator commits `.pi/extensions/test.ts` itself (the start-of-run
 * chore commit), possibly AFTER the /implement baseline was recorded. A diff
 * against that baseline then shows the file as changed although no unit
 * touched it. The line is omitted unless the path is also staged with changes
 * relative to HEAD — a real unit change stays visible and stays a violation.
 * Every other line is kept verbatim. Pure.
 *
 * @param baselineNameStatus - Raw `git diff --cached --name-status <baseline>` output.
 * @param headStagedPaths    - Paths staged with changes relative to HEAD.
 * @returns The name-status output without the chore-only extension line.
 */
export function filterOrchestratorOwned(
  baselineNameStatus: string,
  headStagedPaths: readonly string[],
): string {
  if (headStagedPaths.includes(TEST_EXTENSION_PATH)) return baselineNameStatus;
  return baselineNameStatus
    .split("\n")
    .filter((line) => !isTestExtensionLine(line))
    .join("\n");
}

/**
 * Read the guard name-status: the baseline diff minus chore-only changes to
 * the orchestrator-owned test extension (bug 1).
 *
 * Only when the baseline diff lists the extension does it query
 * `git diff --cached --name-only HEAD -- .pi/extensions/test.ts`; the path
 * counts as changed only when that output lists it exactly. A failed query
 * keeps the line (fail closed: the guard still sees it).
 *
 * @param pi  - ExtensionAPI reference.
 * @param cwd - Working directory.
 * @param ref - Baseline ref (baselineHead or "HEAD").
 * @returns The filtered name-status output.
 */
export async function readGuardNameStatus(
  pi: ExtensionAPI,
  cwd: string,
  ref: string,
): Promise<string> {
  const raw = await runBaselineNameStatus(pi, cwd, ref);
  if (!raw.split("\n").some(isTestExtensionLine)) return raw;
  try {
    const res = await pi.exec(
      "git",
      ["diff", "--cached", "--name-only", "HEAD", "--", TEST_EXTENSION_PATH],
      { cwd },
    );
    if (res.code !== 0) return raw;
    const headStaged = (res.stdout ?? "")
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line === TEST_EXTENSION_PATH);
    return filterOrchestratorOwned(raw, headStaged);
  } catch {
    return raw;
  }
}

/**
 * Build the contract-guard halt for staged paths no task owns (T6).
 *
 * @param undeclared  - Staged paths with no owning task.
 * @param nameStatus  - Raw name-status output (rendered in the investigation).
 * @param declared    - The declared allowlist.
 * @param baselineRef - The baseline ref label.
 * @returns The halt carrying one violation per ownerless path.
 */
export function ownerlessHalt(
  undeclared: readonly string[],
  nameStatus: string,
  declared: readonly DeclaredFile[],
  baselineRef: string,
): GuardHalt {
  const violations = undeclared.map(
    (path) => `staged path with no owning task: ${path} — declared, but no task refs own it`,
  );
  const investigation = [
    `## Contract-guard: staged diff vs ${baselineRef}`,
    "",
    "Name-status:",
    ...nameStatus.split("\n").filter(Boolean).map((line) => `  ${line}`),
    "",
    `Declared files: ${formatDeclaredList(declared)}`,
    "",
    "Violations:",
    ...violations.map((v) => `  - ${v}`),
    "",
    "The contract's files list is authoritative — a contract change needs " +
      "/discuss -> /finalize.",
  ].join("\n");
  return { kind: "contract-guard", violations, investigation };
}

/**
 * Unstage cross-task contamination before gating (T6).
 *
 * Each contaminated path leaves the index via `git restore --staged -- <path>`
 * (the work stays on disk for its owning task). A failed restore halts: the
 * commit must never proceed with contamination still staged.
 *
 * @param pi            - ExtensionAPI reference.
 * @param cwd           - Working directory.
 * @param contamination - Paths owned by other tasks (from planUnstage).
 * @returns The remediation lines, or the halt for a failed restore.
 */
export async function unstageContamination(
  pi: ExtensionAPI,
  cwd: string,
  contamination: readonly ContaminatedPath[],
): Promise<UnstageResult> {
  const remediation: string[] = [];
  for (const contaminated of contamination) {
    const owners = contaminated.ownerTasks.join(", ");
    const res = await pi.exec("git", ["restore", "--staged", "--", contaminated.path], { cwd });
    if (res.code !== 0) {
      return {
        ok: false,
        halt: {
          kind: "contract-guard",
          violations: [
            `failed to unstage cross-task contamination: ${contaminated.path} ` +
              `(owned by task ${owners})`,
          ],
          investigation:
            `git restore --staged -- ${contaminated.path} failed (exit ${res.code}):\n` +
            (res.stderr || res.stdout || "(no output)"),
        },
      };
    }
    remediation.push(
      `unstaged ${contaminated.path} (owned by task ${owners}) — ` +
        `git restore --staged -- ${contaminated.path}; the work stays on disk for its owning task`,
    );
  }
  return { ok: true, remediation };
}
