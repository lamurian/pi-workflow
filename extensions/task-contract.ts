import type {
  TaskContract,
  Behavior,
  FileEntry,
  TaskUnit,
} from "./state.ts";
import { collectBehaviorWarnings } from "./contract-v1-view.ts";

/** Normalized, validated task contract produced by validateTask. */
export type TaskValidation =
  | { ok: true; task: TaskContract; warnings: string[] }
  | { ok: false; reason: string };

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

/**
 * Deterministically validate one raw v2 task unit (shape only).
 *
 * @param raw - Unvalidated element of the tasks array.
 * @param i   - Index of the task (for reason messages).
 * @returns The normalized task (status defaults to "active"), or a reason.
 */
export function validateTaskUnit(
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
  if (t.commit !== undefined && (typeof t.commit !== "string" || t.commit.trim() === "")) {
    return { ok: false, reason: `tasks[${i}].commit must be a non-empty string when present` };
  }
  const status = t.status === "done" || t.status === "removed" ? t.status : "active";
  return {
    ok: true,
    task: {
      id: t.id,
      description: t.description,
      expectedOutput: [...(expected as string[])],
      status,
      ...(typeof t.commit === "string" ? { commit: t.commit } : {}),
    },
  };
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
