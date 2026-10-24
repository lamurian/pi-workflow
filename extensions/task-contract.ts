import type {
  WorkflowState,
  TaskContract,
  Behavior,
  FileEntry,
  FileStatus,
  ContractV2,
  PathEntry,
  TaskUnit,
} from "./state.ts";

/** Normalized, validated task contract produced by validateTask. */
export type TaskValidation =
  | { ok: true; task: TaskContract; warnings: string[] }
  | { ok: false; reason: string };

/** Test-artifact phrasing: expectedOutput talks about test files/cases only. */
const TEST_ARTIFACT_PATTERN = /test (file|files|cases?|scenarios?)\b/i;

/** Observable-behavior markers that make a test-kind expectedOutput valid. */
const OBSERVABLE_MARKER_PATTERN = /\b(returns?|raises?|emits?|rejects?|persists?|validates?)\b/i;

/**
 * Deterministically collect contract-quality warnings for one behavior.
 *
 * Two advisory rules, both test-kind only:
 * 1. Test-artifact-only expectedOutput (mentions test files/cases/scenarios
 *    with no observable-behavior marker) — such a commit is red by
 *    construction: a test without its implementation.
 * 2. Test-deletion expectedOutput — deletion is not test-verified behavior;
 *    the behavior should be kind: "manual".
 *
 * @param b - Behavior to inspect (already shape-validated).
 * @returns Zero or two warning strings (never both rules for one behavior:
 *          deletion is checked first and wins).
 */
function collectBehaviorWarnings(b: Behavior): string[] {
  if (b.kind !== "test") return [];
  if (/\b(deletes?|removes?)\b/i.test(b.expectedOutput) && /\btests?\b/i.test(b.expectedOutput)) {
    return [
      `${b.id}: expectedOutput describes test deletion — test deletion is not ` +
        `test-verified behavior; set kind: manual for removal behaviors.`,
    ];
  }
  if (
    TEST_ARTIFACT_PATTERN.test(b.expectedOutput) &&
    !OBSERVABLE_MARKER_PATTERN.test(b.expectedOutput)
  ) {
    return [
      `${b.id}: expectedOutput describes test artifacts only — the commit ` +
        `would be red by construction (test without implementation). ` +
        `Merge the test and its implementation into one behavior.`,
    ];
  }
  return [];
}

/**
 * Validate one declared file entry of the contract's allowlist.
 *
 * @param raw - Unvalidated entry from the files array.
 * @param i   - Index of the entry (for reason messages).
 * @returns The normalized entry, or a rejection reason.
 */
function validateFileEntry(raw: unknown, i: number):
  | { ok: true; entry: FileEntry }
  | { ok: false; reason: string } {
  if (typeof raw === "string") {
    return {
      ok: false,
      reason:
        `files[${i}] must be an object { path, status } with status A, M or D ` +
        `(got the plain string "${raw}") — every file must declare whether it is ` +
        `added (A), modified (M) or deleted (D)`,
    };
  }
  if (raw === null || typeof raw !== "object") {
    return { ok: false, reason: `files[${i}] must be an object { path, status }` };
  }
  const entry = raw as Record<string, unknown>;
  if (typeof entry.path !== "string" || entry.path.trim() === "") {
    return { ok: false, reason: `files[${i}].path must be a non-empty string` };
  }
  if (entry.status !== "A" && entry.status !== "M" && entry.status !== "D") {
    return {
      ok: false,
      reason:
        `files[${i}].status must be A, M or D (got ${JSON.stringify(entry.status)}) ` +
        `— A = added, M = modified, D = deleted`,
    };
  }
  return { ok: true, entry: { path: entry.path, status: entry.status } };
}

/**
 * Deterministically validate a raw save_task payload.
 *
 * Checks every field of the contract. On success returns a normalized
 * TaskContract with each behavior defaulted to status "active" when the
 * caller omitted it, plus advisory contract-quality warnings (never
 * blocking). On failure returns the first offending field.
 *
 * @param raw - Unvalidated payload (from the save_task tool call).
 * @returns A normalized task with warnings, or a rejection reason.
 */
export function validateTask(raw: unknown): TaskValidation {
  if (raw === null || typeof raw !== "object") {
    return { ok: false, reason: "payload must be an object" };
  }
  const t = raw as Record<string, unknown>;
  if (typeof t.title !== "string" || t.title.trim() === "") {
    return { ok: false, reason: "title is required" };
  }
  if (typeof t.instruction !== "string" || t.instruction.trim() === "") {
    return { ok: false, reason: "instruction is required" };
  }
  if (typeof t.done !== "string" || t.done.trim() === "") {
    return { ok: false, reason: "done is required" };
  }
  if (!Array.isArray(t.files)) {
    return {
      ok: false,
      reason: "files must be an array of { path, status } entries (status A, M or D)",
    };
  }
  const files: FileEntry[] = [];
  const seenPaths = new Set<string>();
  for (let i = 0; i < t.files.length; i++) {
    const parsed = validateFileEntry(t.files[i], i);
    if (!parsed.ok) return parsed;
    if (seenPaths.has(parsed.entry.path)) {
      return {
        ok: false,
        reason: `files[${i}].path duplicates an earlier entry: ${parsed.entry.path}`,
      };
    }
    seenPaths.add(parsed.entry.path);
    files.push(parsed.entry);
  }
  if (!Array.isArray(t.behaviors)) {
    return { ok: false, reason: "behaviors must be an array" };
  }
  const behaviors: Behavior[] = [];
  for (let i = 0; i < t.behaviors.length; i++) {
    const b = t.behaviors[i] as Record<string, unknown>;
    if (b === null || typeof b !== "object") {
      return { ok: false, reason: `behaviors[${i}] must be an object` };
    }
    if (typeof b.id !== "string" || b.id.trim() === "") {
      return { ok: false, reason: `behaviors[${i}].id is required` };
    }
    if (typeof b.description !== "string" || b.description.trim() === "") {
      return { ok: false, reason: `behaviors[${i}].description is required` };
    }
    if (typeof b.expectedOutput !== "string" || b.expectedOutput.trim() === "") {
      return { ok: false, reason: `behaviors[${i}].expectedOutput is required` };
    }
    if (b.kind !== "test" && b.kind !== "manual") {
      return { ok: false, reason: `behaviors[${i}].kind must be test or manual` };
    }
    const status =
      b.status === "removed" || b.status === "done"
        ? b.status
        : "active";
    behaviors.push({
      id: b.id,
      description: b.description,
      expectedOutput: b.expectedOutput,
      kind: b.kind,
      status,
      ...(typeof b.sourceFile === "string" ? { sourceFile: b.sourceFile } : {}),
    });
  }
  return {
    ok: true,
    task: {
      title: t.title,
      instruction: t.instruction,
      files,
      done: t.done,
      behaviors,
    },
    warnings: behaviors.flatMap(collectBehaviorWarnings),
  };
}

// ─── Contract v2 validation (T1) ───────────────────────────────────────────

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
 * Deterministically validate one raw v2 task unit (shape only).
 *
 * @param raw - Unvalidated element of the tasks array.
 * @param i   - Index of the task (for reason messages).
 * @returns The normalized task (status defaults to "active"), or a reason.
 */
function validateTaskUnit(
  raw: unknown,
  i: number,
): { ok: true; task: TaskUnit } | { ok: false; reason: string } {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    return {
      ok: false,
      reason: `tasks[${i}] must be an object { id, description, expectedOutput, status }`,
    };
  }
  const t = raw as Record<string, unknown>;
  if (typeof t.id !== "string" || t.id.trim() === "") {
    return { ok: false, reason: `tasks[${i}].id is required` };
  }
  if (typeof t.description !== "string" || t.description.trim() === "") {
    return { ok: false, reason: `tasks[${i}].description is required` };
  }
  if (!Array.isArray(t.expectedOutput)) {
    return {
      ok: false,
      reason: `tasks[${i}].expectedOutput must be an array — one entry per assertion`,
    };
  }
  const expected = t.expectedOutput as unknown[];
  if (expected.length === 0) {
    return {
      ok: false,
      reason: `task with empty expectedOutput: ${t.id} must list at least one assertion`,
    };
  }
  if (!expected.every((e) => typeof e === "string" && e.trim() !== "")) {
    return {
      ok: false,
      reason:
        `tasks[${i}].expectedOutput entries must be non-empty strings ` +
        `(one per assertion)`,
    };
  }
  const status = t.status === "done" || t.status === "removed" ? t.status : "active";
  return {
    ok: true,
    task: {
      id: t.id,
      description: t.description,
      expectedOutput: [...(expected as string[])],
      status,
    },
  };
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
 * Carry over "done" status from a prior contract into a revised draft.
 *
 * A draft behavior gets status "done" when the prior contract has a
 * behavior with the same id whose status is "done" and whose description
 * and expectedOutput are byte-identical to the draft's. Any text change
 * leaves the draft's own status untouched (the behavior must be redone).
 * Pure: neither input is mutated.
 *
 * @param prior - The previously saved contract, if any.
 * @param draft - The freshly validated draft contract.
 * @returns The draft with preserved statuses, plus the ids (in draft order)
 *          whose done status was carried over.
 */
export function preserveDoneStatuses(
  prior: TaskContract | undefined,
  draft: TaskContract,
): { task: TaskContract; preserved: string[] } {
  if (!prior) return { task: draft, preserved: [] };
  const priorDone = new Map(
    prior.behaviors
      .filter((b) => b.status === "done")
      .map((b) => [b.id, b]),
  );
  const preserved: string[] = [];
  const behaviors = draft.behaviors.map((b) => {
    const p = priorDone.get(b.id);
    if (
      p &&
      p.description === b.description &&
      p.expectedOutput === b.expectedOutput
    ) {
      preserved.push(b.id);
      return { ...b, status: "done" as const };
    }
    return b;
  });
  return { task: { ...draft, behaviors }, preserved };
}

/** Parsed results from a test run. */
export interface ParsedTest {
  passed: number;
  failed: number;
  coveragePercent?: number;
}

/**
 * Parse a test-run result from exit code and stdout.
 *
 * The exit code is the primary signal: a non-zero exit means failed. The
 * passed/failed counts and coverage are best-effort regex extractions used
 * only for display, never for gating.
 *
 * @param exitCode - Process exit code from the test command.
 * @param stdout   - Combined test output.
 * @returns Parsed pass/fail counts.
 */
export function parseTestOutput(exitCode: number, stdout: string): ParsedTest {
  // Match both the classic TAP/Vitest forms (`# pass 2`, `2 passing`) and
  // the Node.js core test-runner summary lines (`ℹ pass 2`, `ℹ fail 0`).
  const failedMatch =
    stdout.match(/(\d+)\s+(?:failed|failing)\b/i) ??
    stdout.match(/\bfail\s+(\d+)/i);
  const passedMatch =
    stdout.match(/(\d+)\s+(?:passed|passing)\b/i) ??
    stdout.match(/\bpass\s+(\d+)/i);

  // Best-effort coverage: istanbul "All files" row (take last column),
  // else a "Lines: N%" / "Statements: N%" style percentage.
  let coveragePercent: number | undefined;
  const allFilesLine = stdout.match(/All files[^\n]*/i);
  if (allFilesLine) {
    const nums = allFilesLine[0].match(/\d+(?:\.\d+)?/g);
    if (nums && nums.length > 0) {
      coveragePercent = parseFloat(nums[nums.length - 1]);
    }
  } else {
    const pct = stdout.match(/(?:Lines|Statements)[^\d]*?(\d+(?:\.\d+)?)\s*%/i);
    if (pct) coveragePercent = parseFloat(pct[1]);
  }

  const failed = failedMatch ? parseInt(failedMatch[1], 10) : 0;
  const passed = passedMatch ? parseInt(passedMatch[1], 10) : 0;
  return {
    passed,
    // A non-zero exit with no parseable "failed" count still counts as a failure.
    failed: exitCode !== 0 && failed === 0 ? 1 : failed,
    ...(coveragePercent !== undefined ? { coveragePercent } : {}),
  };
}

/**
 * Deterministically evaluate the complete_implementation gate.
 *
 * Refuses completion while any active behavior remains, or when no task
 * contract is present. Test outcomes are not consulted: verification is
 * owned by the project (per-behavior commits pass the project's own
 * pre-commit hooks; some projects have no hooks at all).
 *
 * @param state - Current workflow state.
 * @returns null when the gate passes, otherwise a refusal reason.
 */
export function evaluateCompletionGate(state: WorkflowState): string | null {
  const task = state.task;
  if (!task) {
    return "no task contract in state";
  }
  const active = task.behaviors.filter((b) => b.status === "active");
  if (active.length > 0) {
    return `${active.length} behavior(s) still active`;
  }
  return null;
}

/**
 * Render declared file entries as a comma list of "path (STATUS)" items.
 *
 * @param files - The contract's declared file entries.
 * @returns e.g. `src/a.ts (M), tests/a.test.ts (A)`; empty string for no files.
 */
export function formatFiles(files: readonly FileEntry[]): string {
  return files.map((f) => `${f.path} (${f.status})`).join(", ");
}

/**
 * Render a task contract as markdown for prompts, widgets, and compaction.
 * Declared files render as "path (STATUS)" so the D/M/A allowlist is visible.
 *
 * @param task - The task contract to render.
 * @returns Markdown string listing title, files, done, and behaviors.
 */
export function formatTask(task: TaskContract): string {
  const lines: string[] = [];
  lines.push(`### ${task.title}`);
  lines.push(`Files: ${formatFiles(task.files)}`);
  lines.push(`Instruction: ${task.instruction}`);
  lines.push(`Done: ${task.done}`);
  lines.push("Behaviors:");
  for (const b of task.behaviors) {
    const flag = b.status === "removed" ? " [removed]" : "";
    lines.push(
      `- [${b.kind}] ${b.id}: ${b.description} → ${b.expectedOutput}${flag}`,
    );
  }
  return lines.join("\n");
}
