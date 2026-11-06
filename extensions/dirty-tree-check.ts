// T6: dirty-tree preflight classification. Pure decision logic over
// `git status --porcelain --untracked-files=all` output, the v2 contract's
// ownership refs and the first active task id: a dirty path owned by the
// first active task is fine, a declared dirty path owned only by later tasks
// blocks the run (cross-ownership hazard), an undeclared dirty path is
// advisory, and the orchestrator-owned .pi/extensions/test.ts is ignored.
// One thin async wrapper runs the git read (fail-open: git failure yields an
// empty classification, never a false block).

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { deriveOwnership } from "./contract-derive.ts";
import type { ContractV2 } from "./state.ts";

/** The orchestrator-owned generated test extension: never a preflight concern. */
export const IGNORED_DIRTY_PATH = ".pi/extensions/test.ts";

/** One blocking dirty path with its contract-owning task ids. */
export interface DirtyPathBlock {
  /** Repo-relative dirty path. */
  path: string;
  /** Contract owners of the path (never empty for a block). */
  owners: string[];
}

/** Result of classifying the dirty working-tree set. */
export interface DirtyTreeClassification {
  /** Declared dirty paths not owned by the first active task: halt. */
  blocking: DirtyPathBlock[];
  /** Undeclared dirty paths: advisory notify only. */
  advisory: string[];
}

/**
 * Parse `git status --porcelain --untracked-files=all` output into dirty paths.
 *
 * Each line is `XY <path>` (untracked files are `?? <path>`, renames carry
 * ` -> `, quoted paths keep their quotes) — all normalized back to the
 * repo-relative path. Short lines are skipped.
 *
 * @param output - Raw porcelain stdout (may be "" when clean or git failed).
 * @returns Dirty paths in first-seen order, deduplicated.
 */
export function parsePorcelainPaths(output: string): string[] {
  const paths: string[] = [];
  const seen = new Set<string>();
  for (const line of output.split("\n")) {
    if (line.length < 4) continue;
    let path = line.slice(3);
    const arrow = path.indexOf(" -> ");
    if (arrow >= 0) path = path.slice(arrow + 4);
    path = path.replace(/^"|"$/g, "").trim();
    if (!path || seen.has(path)) continue;
    seen.add(path);
    paths.push(path);
  }
  return paths;
}

/**
 * Classify the dirty working-tree set against the contract and first active task.
 *
 * Rules per dirty path: `.pi/extensions/test.ts` is ignored; a declared path
 * whose owners include the first active task (or that names no owner at all —
 * a shared contract path, matching the cross-ownership module's
 * `owners.length > 0` guard) is fine; a declared path owned only by other
 * tasks blocks with its owner ids; an undeclared path is advisory.
 *
 * @param statusOutput     - Raw `git status --porcelain --untracked-files=all` stdout.
 * @param contract         - The v2 contract supplying ownership refs.
 * @param firstActiveTaskId - The first active task id (undefined: nothing to protect).
 * @returns Blocking blocks plus advisory paths.
 */
export function classifyDirtyTree(
  statusOutput: string,
  contract: ContractV2,
  firstActiveTaskId: string | undefined,
): DirtyTreeClassification {
  const ownership = deriveOwnership(contract);
  const blocking: DirtyPathBlock[] = [];
  const advisory: string[] = [];
  for (const path of parsePorcelainPaths(statusOutput)) {
    if (path === IGNORED_DIRTY_PATH) continue;
    const owners = ownership.get(path);
    if (!owners) {
      advisory.push(path);
    } else if (
      owners.length > 0 &&
      firstActiveTaskId !== undefined &&
      !owners.includes(firstActiveTaskId)
    ) {
      blocking.push({ path, owners: [...owners] });
    }
  }
  return { blocking, advisory };
}

/**
 * Read the dirty working-tree set and classify it (T6 preflight).
 *
 * Runs `git status --porcelain --untracked-files=all`; a failed exec yields
 * an empty classification (fail open — an unverifiable tree never blocks).
 *
 * @param pi               - ExtensionAPI reference (for exec access).
 * @param cwd              - Repository working directory.
 * @param contract         - The v2 contract (v2 sessions only).
 * @param firstActiveTaskId - The first active task id.
 * @returns The classification of the current dirty set.
 */
export async function dirtyTreePreflight(
  pi: ExtensionAPI,
  cwd: string,
  contract: ContractV2,
  firstActiveTaskId: string | undefined,
): Promise<DirtyTreeClassification> {
  try {
    const res = await pi.exec("git", ["status", "--porcelain", "--untracked-files=all"], {
      cwd,
      timeout: 5000,
    });
    if (res.code !== 0) return { blocking: [], advisory: [] };
    return classifyDirtyTree(res.stdout ?? "", contract, firstActiveTaskId);
  } catch {
    return { blocking: [], advisory: [] };
  }
}

/**
 * Build the /implement halt text for blocking dirty paths.
 *
 * Lists every blocking path with its owner ids and the manual fallbacks:
 * commit as a checkpoint, `git stash push -- <paths>`, or re-finalize so the
 * first active task owns them.
 *
 * @param classification   - Classification carrying the blocking paths.
 * @param firstActiveTaskId - The first active task id the run would start with.
 * @returns The halt error text.
 */
export function buildDirtyTreeHaltText(
  classification: DirtyTreeClassification,
  firstActiveTaskId: string,
): string {
  const lines = classification.blocking
    .map((b) => `- ${b.path} (owners: ${b.owners.join(", ")})`)
    .join("\n");
  const paths = classification.blocking.map((b) => b.path).join(" ");
  return (
    `Dirty-tree preflight blocked /implement before any unit spawned: declared dirty ` +
    `path(s) are not owned by the first active task ${firstActiveTaskId}:\n${lines}\n` +
    `Manual fallback: commit the path(s) as a checkpoint for their owning tasks, ` +
    `run \`git stash push -- ${paths}\` to clear them from the working tree, or ` +
    `re-finalize the contract so ${firstActiveTaskId} owns them, then run /implement again to resume.`
  );
}

/**
 * Build the advisory notify text for undeclared dirty paths.
 *
 * @param classification - Classification carrying the advisory paths.
 * @returns The notify text (empty when nothing is advisory).
 */
export function buildDirtyTreeAdvisoryText(classification: DirtyTreeClassification): string {
  if (classification.advisory.length === 0) return "";
  return (
    `Dirty-tree preflight (advisory): undeclared dirty path(s) present — ` +
    `review them before they get swept into a commit: ${classification.advisory.join(", ")}`
  );
}

/**
 * Build save_task's advisory warning lines for blocking dirty paths (T6).
 *
 * Never rejects: the caller folds these into its advisory warnings list.
 *
 * @param pi      - ExtensionAPI reference (for exec access).
 * @param cwd     - Repository working directory.
 * @param contract - The contract being saved (supplies tasks and ownership).
 * @returns One warning line per run when blocking paths exist, else [].
 */
export async function dirtyTreeSaveWarnings(
  pi: ExtensionAPI,
  cwd: string,
  contract: ContractV2,
): Promise<string[]> {
  const firstActiveTaskId = contract.tasks.find((t) => t.status === "active")?.id;
  const classification = await dirtyTreePreflight(pi, cwd, contract, firstActiveTaskId);
  if (classification.blocking.length === 0) return [];
  const detail = classification.blocking
    .map((b) => `${b.path} (owners: ${b.owners.join(", ")})`)
    .join("; ");
  return [
    `dirty-tree: declared dirty path(s) not owned by the first active task ` +
      `${firstActiveTaskId ?? "(none)"} — ${detail}; commit them as a checkpoint, ` +
      `stash them (\`git stash push -- ${classification.blocking.map((b) => b.path).join(" ")}\`), ` +
      `or re-finalize so the first active task owns them before /implement`,
  ];
}
