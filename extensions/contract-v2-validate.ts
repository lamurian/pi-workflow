// ─── Contract v2 validation (T1) ─────────────────────────────────────────
// Contract-v2 payload validation (self-naming hard invariants) and the v2 done-status preservation T10 uses on re-save.

import type { ContractV2, FileStatus, PathEntry, TaskUnit } from "./state.ts";
import { validateTaskUnit } from "./task-contract.ts";

/** Normalized, validated v2 contract produced by validateContract. */
export type ContractV2Validation =
  | { ok: true; contract: ContractV2; warnings: string[] }
  | { ok: false; reason: string };

/** Valid per-path statuses for a v2 PathEntry (absent = write-authorized). */
const PATH_STATUSES = new Set(["A", "M", "D"]);

/**
 * Deterministically validate one raw v2 path entry (sources/tests element).
 *
 * Shape only: non-empty path, optional A/M/D status, and a tasks array of
 * non-empty task ids (an empty array is legal here — only D entries require
 * an owner, checked by validateContract).
 *
 * @param raw  - Unvalidated entry from a sources/tests array.
 * @param list - The list name ("sources" | "tests") for reason messages.
 * @param i    - Index of the entry (for reason messages).
 * @returns The normalized entry, or a rejection reason.
 */
function validatePathEntry(
  raw: unknown,
  list: string,
  i: number,
): { ok: true; entry: PathEntry } | { ok: false; reason: string } {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    return {
      ok: false,
      reason: `${list}[${i}] must be an object { path, status?, tasks }`,
    };
  }
  const e = raw as Record<string, unknown>;
  if (typeof e.path !== "string" || e.path.trim() === "") {
    return { ok: false, reason: `${list}[${i}].path must be a non-empty string` };
  }
  if (e.status !== undefined && !PATH_STATUSES.has(String(e.status))) {
    return {
      ok: false,
      reason:
        `${list}[${i}].status must be A, M or D when present ` +
        `(got ${JSON.stringify(e.status)})`,
    };
  }
  if (
    !Array.isArray(e.tasks) ||
    !e.tasks.every((t) => typeof t === "string" && t.trim() !== "")
  ) {
    return { ok: false, reason: `${list}[${i}].tasks must be an array of task ids` };
  }
  return {
    ok: true,
    entry: {
      path: e.path,
      ...(e.status !== undefined ? { status: e.status as FileStatus } : {}),
      tasks: [...(e.tasks as string[])],
    },
  };
}

/**
 * Validate one raw v2 path list (sources or tests) including the
 * no-duplicate-path hard invariant within the list.
 *
 * @param raw  - Unvalidated array of path entries.
 * @param list - The list name ("sources" | "tests") for reason messages.
 * @returns The normalized entries, or a rejection reason.
 */
function validatePathList(
  raw: unknown,
  list: string,
): { ok: true; entries: PathEntry[] } | { ok: false; reason: string } {
  if (!Array.isArray(raw)) {
    return {
      ok: false,
      reason: `${list} must be an array of { path, status?, tasks } entries`,
    };
  }
  const entries: PathEntry[] = [];
  const seen = new Set<string>();
  for (let i = 0; i < raw.length; i++) {
    const parsed = validatePathEntry(raw[i], list, i);
    if (!parsed.ok) return parsed;
    if (seen.has(parsed.entry.path)) {
      return {
        ok: false,
        reason:
          `duplicate path: ${list}[${i}].path ${parsed.entry.path} appears ` +
          `more than once in ${list}`,
      };
    }
    seen.add(parsed.entry.path);
    entries.push(parsed.entry);
  }
  return { ok: true, entries };
}

/**
 * Deterministically validate a raw contract-v2 payload.
 *
 * Hard invariants (blocking, each rejection names the invariant): every
 * `tasks[]` ref resolves to a declared task id (no dangling taskRef); no
 * duplicate path within an array; no path in both sources and tests; every
 * `D` entry names at least one owning task; every task has at least one
 * expectedOutput entry; task ids are unique. Advisory only, never blocking:
 * a task with no path refs (pure-manual) and shared files referenced by
 * multiple tasks — both legal and first-class.
 *
 * @param raw - Unvalidated payload (save_task v2 call or migrateV1 output).
 * @returns A normalized ContractV2 with warnings, or a rejection reason.
 */
export function validateContract(raw: unknown): ContractV2Validation {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    return { ok: false, reason: "payload must be an object" };
  }
  const c = raw as Record<string, unknown>;
  for (const field of ["title", "instruction", "done"] as const) {
    if (typeof c[field] !== "string" || c[field].trim() === "") {
      return { ok: false, reason: `${field} is required` };
    }
  }
  const sources = validatePathList(c.sources, "sources");
  if (!sources.ok) return sources;
  const tests = validatePathList(c.tests, "tests");
  if (!tests.ok) return tests;

  // No path in both sources and tests: each path belongs to exactly one list.
  const sourcePaths = new Set(sources.entries.map((e) => e.path));
  for (const t of tests.entries) {
    if (sourcePaths.has(t.path)) {
      return {
        ok: false,
        reason:
          `path declared in both sources and tests: ${t.path} — each path ` +
          `belongs to exactly one list`,
      };
    }
  }

  // Every D entry is delete authority for at least one owning task.
  for (const [list, entries] of [
    ["sources", sources.entries],
    ["tests", tests.entries],
  ] as const) {
    for (const e of entries) {
      if (e.status === "D" && e.tasks.length === 0) {
        return {
          ok: false,
          reason:
            `D entry with empty tasks: ${list} entry ${e.path} is declared D ` +
            `but names no owning task`,
        };
      }
    }
  }

  if (!Array.isArray(c.tasks)) {
    return { ok: false, reason: "tasks must be an array of task units" };
  }
  const tasks: TaskUnit[] = [];
  const seenIds = new Set<string>();
  for (let i = 0; i < c.tasks.length; i++) {
    const parsed = validateTaskUnit(c.tasks[i], i);
    if (!parsed.ok) return parsed;
    if (seenIds.has(parsed.task.id)) {
      return {
        ok: false,
        reason: `duplicate task id: ${parsed.task.id} is declared more than once`,
      };
    }
    seenIds.add(parsed.task.id);
    tasks.push(parsed.task);
  }

  // Every taskRef resolves to a declared task id.
  for (const [list, entries] of [
    ["sources", sources.entries],
    ["tests", tests.entries],
  ] as const) {
    for (let i = 0; i < entries.length; i++) {
      for (const ref of entries[i].tasks) {
        if (!seenIds.has(ref)) {
          return {
            ok: false,
            reason:
              `dangling taskRef: ${list}[${i}].tasks references unknown task ` +
              `id "${ref}" — every taskRef must resolve to a declared task`,
          };
        }
      }
    }
  }

  return {
    ok: true,
    contract: {
      title: c.title as string,
      instruction: c.instruction as string,
      done: c.done as string,
      sources: sources.entries,
      tests: tests.entries,
      tasks,
    },
    warnings: [],
  };
}

/**
 * Carry over "done" status from a prior v2 contract into a revised draft.
 *
 * A draft task gets status "done" when the prior contract has a task with
 * the same id whose status is "done" and whose description and
 * expectedOutput entries are byte-identical to the draft's. Any text change
 * leaves the draft's own status untouched (the task must be redone). Pure:
 * neither input is mutated.
 *
 * @param prior - The previously saved v2 contract, if any.
 * @param draft - The freshly validated draft contract.
 * @returns The draft with preserved statuses, plus the ids (in draft order)
 *          whose done status was carried over.
 */
export function preserveContractDoneStatuses(
  prior: ContractV2 | undefined,
  draft: ContractV2,
): { contract: ContractV2; preserved: string[] } {
  if (!prior) return { contract: draft, preserved: [] };
  const priorDone = new Map(
    prior.tasks.filter((t) => t.status === "done").map((t) => [t.id, t]),
  );
  const preserved: string[] = [];
  const tasks = draft.tasks.map((t) => {
    const p = priorDone.get(t.id);
    if (
      p &&
      p.description === t.description &&
      JSON.stringify(p.expectedOutput) === JSON.stringify(t.expectedOutput)
    ) {
      preserved.push(t.id);
      return { ...t, status: "done" as const };
    }
    return t;
  });
  return { contract: { ...draft, tasks }, preserved };
}
