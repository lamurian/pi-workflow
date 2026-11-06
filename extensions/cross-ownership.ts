// Path extraction and ownership matching over the RAW hook evidence of a
// rejected commit. The classifier scans only the hook output (never the
// investigation text, which embeds tree state that is not hook evidence) and
// verifies every candidate against two true tree snapshots: the staged index
// (`git diff --cached --name-only HEAD`) and the dirty set
// (`git status --porcelain --untracked-files=all`). A foreign path absent from
// both is a phantom (already committed or clean) and never blocks; a dirty
// unstaged/untracked foreign path blocks too, because the repo-wide hook
// checks the working tree.

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { deriveOwnership } from "./contract-derive.ts";
import type { ContractV2 } from "./state.ts";

/** One hook-named path owned by tasks other than the current unit. */
export interface CrossOwnershipBlock {
  /** The repo-relative path the hook output named. */
  path: string;
  /** The contract's owning task ids for the path (never empty). */
  owners: string[];
}

/** Path-candidate token: word chars plus `/ . _ - + ~ @` — colons split off. */
const PATH_TOKEN = /[\w./+~@-]+/g;

/**
 * Extract repo-relative path candidates from hook output text.
 *
 * Splits on anything outside the path charset (whitespace, quotes, brackets,
 * colons — so `file.go:42:1` yields `file.go`), normalizes a leading `./` and
 * a trailing dot, and drops letterless tokens. Over-extraction is safe:
 * candidates only ever match exactly against the contract's declared paths.
 *
 * @param text - Raw hook output text.
 * @returns Deduplicated path candidates in first-seen order.
 */
export function extractRepoPaths(text: string): string[] {
  const paths: string[] = [];
  const seen = new Set<string>();
  for (const raw of text.match(PATH_TOKEN) ?? []) {
    const path = raw.replace(/^\.\//, "").replace(/\.+$/, "");
    if (!path || !/[A-Za-z]/.test(path) || seen.has(path)) continue;
    seen.add(path);
    paths.push(path);
  }
  return paths;
}

/**
 * Find every declared path named in the text that the current unit does not own.
 *
 * @param text     - Hook output text of the rejected commit.
 * @param contract - The v2 contract supplying ownership refs.
 * @param taskId   - The current unit's task id.
 * @returns Foreign blocks in first-seen order (own/undeclared paths excluded).
 */
function foreignNamedPaths(
  text: string,
  contract: ContractV2,
  taskId: string,
): CrossOwnershipBlock[] {
  const ownership = deriveOwnership(contract);
  const blocks: CrossOwnershipBlock[] = [];
  for (const path of extractRepoPaths(text)) {
    const owners = ownership.get(path);
    if (owners && owners.length > 0 && !owners.includes(taskId)) blocks.push({ path, owners });
  }
  return blocks;
}

/**
 * Find the first hook-named foreign path present in the staged index or the
 * dirty working-tree set.
 *
 * A path owned by the unit itself, declared nowhere, or absent from BOTH
 * snapshots never blocks: the unit may fix its own files, undeclared paths keep
 * the normal fix-forward path, and a phantom (already committed or clean) path
 * is not part of this commit. A dirty unstaged/untracked foreign path blocks
 * because the repo-wide hook checks the working tree; a staged foreign path
 * blocks with precedence so the existing index-based message wins for a
 * partially staged path. Pure: exact membership of {@link extractRepoPaths}
 * candidates in the contract's ownership refs (sources ∪ tests) intersected
 * with the caller-supplied snapshots. The 4-arg staged-only call keeps working.
 *
 * @param text        - Hook output text of the rejected commit.
 * @param contract    - The v2 contract supplying ownership refs (absent on v1 sessions).
 * @param taskId      - The current unit's task id.
 * @param stagedPaths - Paths from `git diff --cached --name-only HEAD` (the true index).
 * @param dirtyPaths  - Paths from `git status --porcelain --untracked-files=all` (dirty set).
 * @returns The blocking path with its owning task ids, or undefined.
 */
export function findCrossOwnershipBlock(
  text: string,
  contract: ContractV2 | undefined,
  taskId: string,
  stagedPaths: readonly string[],
  dirtyPaths: readonly string[] = [],
): CrossOwnershipBlock | undefined {
  if (!contract) return undefined;
  const staged = new Set(stagedPaths);
  const dirty = new Set(dirtyPaths);
  const foreign = foreignNamedPaths(text, contract, taskId);
  return (
    foreign.find((block) => staged.has(block.path)) ??
    foreign.find((block) => dirty.has(block.path))
  );
}

/**
 * Build the early-halt error for a cross-ownership hook block (T4/T1/T3).
 *
 * Returns undefined when no other-task path is named in the staged index or
 * the dirty set, so hook rejections that name only the unit's own, undeclared,
 * or phantom (committed/clean) paths keep the normal fix-forward path. For a
 * staged block the error keeps the existing message: fix the file for the
 * owning task, or unstage/keep it out of this unit's commit. For a dirty-only
 * block (unstaged or untracked) the message states that the repo-wide hook
 * checks the working tree and names the fallbacks: commit the file for its
 * owning task, `git stash push -- <path>`, or re-finalize so the current task
 * owns it. When the hook also named declared paths that are neither staged nor
 * dirty, it advises running the hook locally to see the real failure.
 *
 * @param text        - Hook output text of the rejected commit.
 * @param contract    - The v2 contract (absent on v1 sessions → no block).
 * @param behaviorId  - The current behavior/unit id.
 * @param stagedPaths - Paths from `git diff --cached --name-only HEAD`.
 * @param dirtyPaths  - Paths from `git status --porcelain --untracked-files=all`.
 * @returns The halt error text, or undefined when nothing blocks.
 */
export function buildCrossOwnershipHaltText(
  text: string,
  contract: ContractV2 | undefined,
  behaviorId: string,
  stagedPaths: readonly string[],
  dirtyPaths: readonly string[] = [],
): string | undefined {
  if (!contract) return undefined;
  const staged = new Set(stagedPaths);
  const dirty = new Set(dirtyPaths);
  const block = findCrossOwnershipBlock(text, contract, behaviorId, stagedPaths, dirtyPaths);
  if (!block) return undefined;
  const declared = new Set([...contract.sources, ...contract.tests].map((entry) => entry.path));
  const committedOrClean = extractRepoPaths(text).filter(
    (path) => declared.has(path) && !staged.has(path) && !dirty.has(path),
  );
  const advice =
    committedOrClean.length > 0
      ? ` The hook also named ${committedOrClean.join(", ")}, already committed or clean ` +
        `(absent from the staged index and dirty set) — run the hook locally against the current tree ` +
        `to see the real failure.`
      : "";
  const head =
    `Cross-ownership hook block for ${behaviorId}: the pre-commit hook rejected the commit and named ` +
    `${block.path}, owned by task ${block.owners.join(", ")} — a path this unit does not own, so no ` +
    `fix-forward round can address it. `;
  if (staged.has(block.path)) {
    return (
      head +
      `Manual fallback: fix the file for the owning task, or ` +
      `unstage/keep it out of this unit's commit (the work stays on disk), then run /implement again to resume.` +
      advice
    );
  }
  return (
    head +
    `The repo-wide pre-commit hook checks the working tree, not only the staged index, so this ` +
    `dirty unstaged/untracked path blocks the commit too. Manual fallback: commit the file for its ` +
    `owning task, run \`git stash push -- ${block.path}\` to clear it from the working tree, or ` +
    `re-finalize so the current task owns it, then run /implement again to resume.` +
    advice
  );
}

/**
 * Read the true index: paths staged for commit relative to HEAD.
 *
 * @param pi  - ExtensionAPI reference.
 * @param cwd - Working directory.
 * @returns The staged paths, or an empty list when git fails (fail open: an
 *          unverifiable path never blocks).
 */
async function readStagedPaths(pi: ExtensionAPI, cwd: string): Promise<string[]> {
  try {
    const res = await pi.exec("git", ["diff", "--cached", "--name-only", "HEAD"], { cwd });
    if (res.code !== 0) return [];
    return (res.stdout ?? "")
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean);
  } catch {
    return [];
  }
}

/**
 * Read the dirty working-tree set: modified-unstaged and untracked paths.
 *
 * Parses `git status --porcelain --untracked-files=all` output where each line
 * is `XY <path>` (untracked files appear as `?? <path>`, renames as
 * `old -> new`, quoted paths keep their quotes — all normalized back to the
 * repo-relative path). Untracked files count too: the repo-wide hook checks
 * the working tree, not only what the unit staged.
 *
 * @param pi  - ExtensionAPI reference.
 * @param cwd - Working directory.
 * @returns The dirty paths, or an empty list when git fails (fail open: an
 *          unverifiable path never blocks).
 */
async function readDirtyPaths(pi: ExtensionAPI, cwd: string): Promise<string[]> {
  try {
    const res = await pi.exec("git", ["status", "--porcelain", "--untracked-files=all"], { cwd });
    if (res.code !== 0) return [];
    const paths: string[] = [];
    for (const line of (res.stdout ?? "").split("\n")) {
      if (line.length < 4) continue;
      let path = line.slice(3);
      const arrow = path.indexOf(" -> ");
      if (arrow >= 0) path = path.slice(arrow + 4);
      path = path.replace(/^"|"$/g, "").trim();
      if (path) paths.push(path);
    }
    return paths;
  } catch {
    return [];
  }
}

/**
 * Classify one hook rejection against ownership and the true tree state (T1/T3).
 *
 * Scans only the raw hook output (never the investigation text) and verifies
 * candidates against the staged index (`git diff --cached --name-only HEAD`)
 * AND the dirty set (`git status --porcelain --untracked-files=all`) before
 * halting: a foreign path staged, dirty-unstaged, or untracked blocks.
 *
 * @param pi         - ExtensionAPI reference.
 * @param cwd        - Working directory.
 * @param hookOutput - Raw hook output of the rejected commit.
 * @param contract   - The v2 contract (absent on v1 sessions → no I/O, no block).
 * @param behaviorId - The current behavior/unit id.
 * @returns The cross-ownership halt text, or undefined when nothing blocks.
 */
export async function crossOwnershipHalt(
  pi: ExtensionAPI,
  cwd: string,
  hookOutput: string,
  contract: ContractV2 | undefined,
  behaviorId: string,
): Promise<string | undefined> {
  if (!contract) return undefined;
  const stagedPaths = await readStagedPaths(pi, cwd);
  const dirtyPaths = await readDirtyPaths(pi, cwd);
  return buildCrossOwnershipHaltText(hookOutput, contract, behaviorId, stagedPaths, dirtyPaths);
}
