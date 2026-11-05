// Path extraction and ownership matching over the RAW hook evidence of a
// rejected commit. The classifier scans only the hook output (never the
// investigation text, which embeds tree state that is not hook evidence) and
// verifies every candidate against the true index
// (`git diff --cached --name-only HEAD`): a foreign path absent from the index
// is a phantom (already committed or clean) and never blocks.

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
 * Find the first hook-named foreign path that is present in the true index.
 *
 * A path owned by the unit itself, declared nowhere, or absent from the staged
 * index never blocks: the unit may fix its own files, undeclared paths keep the
 * normal fix-forward path, and a phantom (already committed or clean) path is
 * not part of this commit. Pure: exact membership of
 * {@link extractRepoPaths} candidates in the contract's ownership refs
 * (sources ∪ tests) intersected with the caller-supplied index snapshot.
 *
 * @param text       - Hook output text of the rejected commit.
 * @param contract   - The v2 contract supplying ownership refs (absent on v1 sessions).
 * @param taskId     - The current unit's task id.
 * @param stagedPaths - Paths from `git diff --cached --name-only HEAD` (the true index).
 * @returns The blocking path with its owning task ids, or undefined.
 */
export function findCrossOwnershipBlock(
  text: string,
  contract: ContractV2 | undefined,
  taskId: string,
  stagedPaths: readonly string[],
): CrossOwnershipBlock | undefined {
  if (!contract) return undefined;
  const staged = new Set(stagedPaths);
  return foreignNamedPaths(text, contract, taskId).find((block) => staged.has(block.path));
}

/**
 * Build the early-halt error for a cross-ownership hook block (T4/T1).
 *
 * Returns undefined when no other-task path is named in the true index, so
 * hook rejections that name only the unit's own, undeclared, or phantom
 * (committed/clean) paths keep the normal fix-forward path. The error names
 * the blocking path, its owning task ids and the manual fallback: fix the file
 * for the owning task, or unstage/keep it out of this unit's commit. When the
 * hook also named declared paths that are already committed or clean (absent
 * from the index), it advises running the hook locally to see the real failure.
 *
 * @param text        - Hook output text of the rejected commit.
 * @param contract    - The v2 contract (absent on v1 sessions → no block).
 * @param behaviorId  - The current behavior/unit id.
 * @param stagedPaths - Paths from `git diff --cached --name-only HEAD`.
 * @returns The halt error text, or undefined when nothing blocks.
 */
export function buildCrossOwnershipHaltText(
  text: string,
  contract: ContractV2 | undefined,
  behaviorId: string,
  stagedPaths: readonly string[],
): string | undefined {
  if (!contract) return undefined;
  const staged = new Set(stagedPaths);
  const block = findCrossOwnershipBlock(text, contract, behaviorId, stagedPaths);
  if (!block) return undefined;
  const declared = new Set([...contract.sources, ...contract.tests].map((entry) => entry.path));
  const committedOrClean = extractRepoPaths(text).filter(
    (path) => declared.has(path) && !staged.has(path),
  );
  const advice =
    committedOrClean.length > 0
      ? ` The hook also named ${committedOrClean.join(", ")}, already committed or clean ` +
        `(absent from the staged index) — run the hook locally against the current tree ` +
        `to see the real failure.`
      : "";
  return (
    `Cross-ownership hook block for ${behaviorId}: the pre-commit hook rejected the commit and named ` +
    `${block.path}, owned by task ${block.owners.join(", ")} — a path this unit does not own, so no ` +
    `fix-forward round can address it. Manual fallback: fix the file for the owning task, or ` +
    `unstage/keep it out of this unit's commit (the work stays on disk), then run /implement again to resume.` +
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
 * Classify one hook rejection against ownership and the true index (T1).
 *
 * Scans only the raw hook output (never the investigation text) and verifies
 * candidates against `git diff --cached --name-only HEAD` before halting.
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
  return buildCrossOwnershipHaltText(hookOutput, contract, behaviorId, stagedPaths);
}
