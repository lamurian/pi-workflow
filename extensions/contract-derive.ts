/**
 * Contract derivation module (T3): the single source for every contract
 * view — allowlist, unit scope and ownership. Pure functions over a
 * validated `ContractV2`: no I/O, no exec, no model calls. Consumers
 * (prompt renderer, unit payload, in-turn guard, commit gate, scope gate)
 * derive their views from here so no view can diverge.
 */

import { posix } from "node:path";
import type { ContractV2, FileStatus, PathEntry } from "./state.ts";

/** One entry of the derived allowlist (the union of sources and tests). */
export interface AllowlistEntry {
  /** Repo-relative path. */
  path: string;
  /**
   * Optional per-path FACT: absent = write-authorized (A/M is a derived
   * display qualifier, never enforced); D = delete authority for `refs`.
   */
  status?: FileStatus;
  /** Task ids owning the path (shared files name several). */
  refs: string[];
}

/** The derived unit scope for one task: its slice of the contract. */
export interface UnitScope {
  /** Sources entries whose `tasks` include the task id. */
  sources: PathEntry[];
  /** Tests entries whose `tasks` include the task id. */
  tests: PathEntry[];
  /**
   * Unique repo-relative dirs of the owned TEST paths (first-seen order).
   * A task with no `tests` refs yields empty packages ⇒ no test gate
   * (manual-ness is derived, no `kind` field).
   */
  packages: string[];
}

/**
 * Copy one PathEntry so derived views never alias the contract's arrays.
 *
 * @param entry - The contract entry to copy.
 * @returns A fresh entry with a fresh `tasks` array.
 */
function copyEntry(entry: PathEntry): PathEntry {
  return { ...entry, tasks: [...entry.tasks] };
}

/**
 * Repo-relative dir of a repo-relative POSIX path ("./" stripped first).
 *
 * @param path - Repo-relative POSIX path of a contract entry.
 * @returns The dir portion, "." for a root-level path.
 */
function dirOf(path: string): string {
  return posix.dirname(path.replace(/^\.\//, ""));
}

/**
 * Derive the authoritative allowlist: the union of sources and tests.
 *
 * Sources come first in contract order, then tests; each entry carries its
 * path, the optional per-path status FACT (absent stays absent — never
 * defaulted) and the owning task ids as `refs`. Validation guarantees no
 * path appears in both lists, so the union needs no dedup.
 *
 * @param contract - A validated v2 contract.
 * @returns One allowlist entry per declared path.
 */
export function deriveAllowlist(contract: ContractV2): AllowlistEntry[] {
  return [...contract.sources, ...contract.tests].map((entry) => ({
    path: entry.path,
    ...(entry.status !== undefined ? { status: entry.status } : {}),
    refs: [...entry.tasks],
  }));
}

/**
 * Derive one task's scope: its slice of the contract.
 *
 * `sources`/`tests` keep only the entries whose `tasks` include the task id
 * (full refs retained — a filter view, not a rewrite). `packages` is the
 * unique repo-relative dirs of the task's owned TEST paths: scoping a test
 * run belongs to test paths, so a task with no `tests` refs (e.g. a manual
 * task that owns only a source) always yields empty packages ⇒ no test gate.
 *
 * @param contract - A validated v2 contract.
 * @param taskId   - The task id to derive the scope for.
 * @returns The task's filtered sources/tests plus its package dirs.
 */
export function deriveUnitScope(contract: ContractV2, taskId: string): UnitScope {
  const sources = contract.sources
    .filter((entry) => entry.tasks.includes(taskId))
    .map(copyEntry);
  const tests = contract.tests
    .filter((entry) => entry.tasks.includes(taskId))
    .map(copyEntry);
  const packages: string[] = [];
  const seen = new Set<string>();
  for (const entry of tests) {
    const dir = dirOf(entry.path);
    if (!seen.has(dir)) {
      seen.add(dir);
      packages.push(dir);
    }
  }
  return { sources, tests, packages };
}

/**
 * Derive the ownership map: path → owning task ids.
 *
 * @param contract - A validated v2 contract.
 * @returns A Map from every declared path (sources and tests) to a fresh
 *          array of its owning task ids; shared files name several.
 */
export function deriveOwnership(contract: ContractV2): Map<string, string[]> {
  const ownership = new Map<string, string[]>();
  for (const entry of [...contract.sources, ...contract.tests]) {
    ownership.set(entry.path, [...entry.tasks]);
  }
  return ownership;
}
