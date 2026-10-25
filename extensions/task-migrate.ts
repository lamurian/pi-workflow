/**
 * Contract v1 → v2 migration normalizer (T2).
 *
 * `migrateV1` converts a persisted v1 contract (`files[]` + `behaviors[]`)
 * into a normalized `ContractV2`:
 *
 * - each behavior becomes a task unit (id and status preserved, the
 *   `expectedOutput` string split into per-assertion entries on "; ");
 * - the behavior's `sourceFile` seeds a sources entry with taskRef `[id]`
 *   (the declared v1 status carries over when the path is in `files`);
 * - `kind: "test"` behaviors seed tests refs from the optional scan-evidence
 *   argument (`entry -> testPath [method, confidence]` lines); `kind: "manual"`
 *   behaviors never get tests refs, and with no evidence the tests refs stay
 *   empty (finalize fills them later);
 * - v1 `files` entries not owned by any behavior become shared PathEntry refs
 *   (empty `tasks`) listed in the migration summary.
 *
 * The migrated contract is validated with `validateContract`; any hard-
 * invariant violation makes `migrateV1` throw with the failing invariant
 * named. Pure: no I/O — the `state.ts` resume path calls it on load.
 */

import type {
  Behavior,
  ContractV2,
  FileEntry,
  FileStatus,
  TaskContract,
  TaskUnit,
} from "./state.ts";
import { validateContract } from "./contract-v2-validate.ts";
import { isTestPath } from "./test-scan-profiles.ts";

/** Result of migrating one persisted v1 contract to the v2 format. */
export interface MigrationResult {
  /** The normalized contract — guaranteed to pass `validateContract`. */
  contract: ContractV2;
  /** v1 `files` entries with no owning behavior (carried with empty task refs). */
  sharedPaths: string[];
  /** Migration summary lines: a header plus one line per shared path. */
  summary: string[];
}

/** Mutable PathEntry accumulator (insertion-ordered, merged per path). */
interface EntryDraft {
  path: string;
  status?: FileStatus;
  tasks: string[];
}

/**
 * Split a v1 `expectedOutput` string into per-assertion entries.
 *
 * @param expectedOutput - The v1 behavior's expectedOutput string.
 * @returns Trimmed, non-empty assertion entries (empty when the string holds
 *          no assertion — surfaced later as a loud validation failure).
 */
function splitAssertions(expectedOutput: string): string[] {
  return expectedOutput
    .split(";")
    .map((segment) => segment.trim())
    .filter((segment) => segment.length > 0);
}

/**
 * Index scan-evidence lines by their declared entry path.
 *
 * Only `entry -> testPath [method, confidence]` lines carry a test path;
 * note/unverified lines (`entry: …`) are skipped.
 *
 * @param evidence - Evidence lines from the deterministic contract scan.
 * @returns Map of entry path to its deduplicated matched test paths (ordered).
 */
function indexEvidence(
  evidence: readonly string[] | undefined,
): Map<string, string[]> {
  const byEntry = new Map<string, string[]>();
  for (const line of evidence ?? []) {
    const arrow = line.indexOf(" -> ");
    if (arrow < 0) continue;
    const entry = line.slice(0, arrow).trim();
    const testPath = line
      .slice(arrow + 4)
      .replace(/\s+\[[^\]]*\]\s*$/, "")
      .trim();
    if (!entry || !testPath) continue;
    const list = byEntry.get(entry);
    if (list) {
      if (!list.includes(testPath)) list.push(testPath);
    } else {
      byEntry.set(entry, [testPath]);
    }
  }
  return byEntry;
}

/**
 * Migrate a persisted v1 contract to a normalized ContractV2.
 *
 * Deterministic and pure: behaviors map to task units in order, path refs
 * merge per path (shared files collect several taskRefs), unowned `files`
 * entries become shared refs classified into `tests` vs `sources` by
 * `isTestPath`. The result is validated with `validateContract` before it is
 * returned — an invalid migration throws with the failing invariant named.
 *
 * @param v1      - The persisted v1 contract (files + behaviors).
 * @param evidence - Optional scan evidence lines (`entry -> testPath […]`)
 *                   seeding tests refs for `kind: "test"` behaviors; omitted
 *                   means empty tests refs (finalize fills them).
 * @returns The migrated contract plus the shared paths and summary lines.
 * @throws When the migrated contract fails v2 validation; the error message
 *         carries the failing invariant from `validateContract`.
 */
export function migrateV1(
  v1: TaskContract,
  evidence?: readonly string[],
): MigrationResult {
  const filesByPath = new Map<string, FileEntry>(
    v1.files.map((f) => [f.path, f] as const),
  );
  const evidenceByEntry = indexEvidence(evidence);
  const sources = new Map<string, EntryDraft>();
  const tests = new Map<string, EntryDraft>();
  const claimed = new Set<string>();

  /**
   * Add a path to one list, merging taskRefs on repeat (shared files) and
   * seeding the declared v1 status from `files` when first seen.
   */
  const add = (list: Map<string, EntryDraft>, path: string, taskId?: string): void => {
    let draft = list.get(path);
    if (!draft) {
      const declared = filesByPath.get(path);
      draft = declared?.status
        ? { path, status: declared.status, tasks: [] }
        : { path, tasks: [] };
      list.set(path, draft);
    }
    if (taskId && !draft.tasks.includes(taskId)) draft.tasks.push(taskId);
    claimed.add(path);
  };

  const tasks: TaskUnit[] = v1.behaviors.map((b: Behavior) => {
    if (b.sourceFile) add(sources, b.sourceFile, b.id);
    if (b.kind === "test" && b.sourceFile) {
      for (const testPath of evidenceByEntry.get(b.sourceFile) ?? []) {
        add(tests, testPath, b.id);
      }
    }
    return {
      id: b.id,
      description: b.description,
      expectedOutput: splitAssertions(b.expectedOutput),
      status: b.status,
    };
  });

  // v1 files entries not owned by any behavior: shared contract-level refs.
  const sharedPaths: string[] = [];
  for (const f of v1.files) {
    if (claimed.has(f.path)) continue;
    sharedPaths.push(f.path);
    add(isTestPath(f.path) ? tests : sources, f.path);
  }

  const candidate: ContractV2 = {
    title: v1.title,
    instruction: v1.instruction,
    done: v1.done,
    sources: [...sources.values()],
    tests: [...tests.values()],
    tasks,
  };

  const validation = validateContract(candidate);
  if (!validation.ok) {
    throw new Error(
      `migrateV1: migrated contract failed v2 validation — ${validation.reason}`,
    );
  }

  const summary = [
    `migrated ${v1.behaviors.length} behavior(s) into ${tasks.length} task(s): ` +
      `${sources.size} source path(s), ${tests.size} test path(s)`,
    ...sharedPaths.map((path) => {
      const status = filesByPath.get(path)?.status;
      return `shared (no owning behavior): ${path}${status ? ` (${status})` : ""}`;
    }),
    ...(sharedPaths.length === 0
      ? ["shared (no owning behavior): (none)"]
      : []),
  ];

  return { contract: validation.contract, sharedPaths, summary };
}
