// save_task operation 'split': replace one active parent task in place with
// children T<n>.1..k that partition its assertions and paths exactly.

import type { ContractV2, PathEntry, TaskUnit } from "./contract-types.ts";

/** One proposed child in a split payload. */
export interface SplitChild {
  description: string;
  expectedOutput: string[];
  /** Parent paths this child owns. */
  paths: string[];
  commands?: string[];
}

/** Result of buildSplitContract. */
export type SplitResult = { ok: true; contract: ContractV2 } | { ok: false; reason: string };

const SPLIT_CHILD_ID = /\.\d+$/;

function isStringArray(v: unknown): v is string[] {
  return Array.isArray(v) && v.every((x) => typeof x === "string");
}

function parseChildren(raw: unknown): SplitChild[] | string {
  if (!Array.isArray(raw) || raw.length < 2) return "split needs tasks with at least two children";
  const out: SplitChild[] = [];
  for (let i = 0; i < raw.length; i++) {
    const c = raw[i] as Record<string, unknown> | null;
    if (!c || typeof c !== "object") return `tasks[${i}] must be an object`;
    if (typeof c.description !== "string" || c.description.trim() === "") {
      return `tasks[${i}].description is required`;
    }
    if (!isStringArray(c.expectedOutput) || c.expectedOutput.length === 0) {
      return `tasks[${i}].expectedOutput must be a non-empty string array`;
    }
    if (!isStringArray(c.paths) || c.paths.length === 0) {
      return `tasks[${i}].paths must be a non-empty string array of parent paths`;
    }
    if (c.commands !== undefined && !isStringArray(c.commands)) {
      return `tasks[${i}].commands must be a string array`;
    }
    out.push({
      description: c.description,
      expectedOutput: c.expectedOutput,
      paths: c.paths,
      ...(c.commands ? { commands: c.commands as string[] } : {}),
    });
  }
  return out;
}

function checkPartition(parent: TaskUnit, parentPaths: Set<string>, kids: SplitChild[]): string | null {
  const remaining = new Map<string, number>();
  for (const a of parent.expectedOutput) remaining.set(a, (remaining.get(a) ?? 0) + 1);
  for (const k of kids) {
    for (const a of k.expectedOutput) {
      const n = remaining.get(a) ?? 0;
      if (n === 0) return `assertion "${a}" is not a parent assertion (reworded, added or duplicated)`;
      remaining.set(a, n - 1);
    }
  }
  for (const [a, n] of remaining) if (n > 0) return `parent assertion dropped: "${a}"`;
  const owned = new Set<string>();
  const parentCmds = new Set(parent.commands ?? []);
  for (const k of kids) {
    for (const p of k.paths) {
      if (!parentPaths.has(p)) return `path added: ${p} is not a path of ${parent.id}`;
      owned.add(p);
    }
    for (const c of k.commands ?? []) {
      if (!parentCmds.has(c)) return `command added: ${c} is not a command of ${parent.id}`;
    }
  }
  for (const p of parentPaths) if (!owned.has(p)) return `parent path left unowned: ${p}`;
  return null;
}

function rewrite(list: PathEntry[], parentId: string, ids: string[], kids: SplitChild[]): PathEntry[] {
  return list.map((e) => {
    if (!e.tasks.includes(parentId)) return e;
    const tasks: string[] = [];
    for (const t of e.tasks) {
      if (t !== parentId) tasks.push(t);
      else kids.forEach((k, i) => k.paths.includes(e.path) && tasks.push(ids[i]!));
    }
    return { ...e, tasks };
  });
}

/**
 * Build the full contract resulting from splitting one parent task.
 *
 * @param prior    - The current contract.
 * @param parentId - Id of the active, non-child task to split.
 * @param rawTasks - Proposed children { description, expectedOutput, paths, commands? }.
 * @returns The new contract or a rejection reason.
 */
export function buildSplitContract(prior: ContractV2, parentId: unknown, rawTasks: unknown): SplitResult {
  if (typeof parentId !== "string") return { ok: false, reason: "split needs a parentId" };
  const parent = prior.tasks.find((t) => t.id === parentId);
  if (!parent) return { ok: false, reason: `split parent ${parentId} not found` };
  if (parent.status !== "active") return { ok: false, reason: `split parent ${parentId} is not active` };
  if (SPLIT_CHILD_ID.test(parentId)) {
    return { ok: false, reason: `${parentId} is itself a split child and cannot be split again` };
  }
  const kids = parseChildren(rawTasks);
  if (typeof kids === "string") return { ok: false, reason: kids };
  const parentPaths = new Set(
    [...prior.sources, ...prior.tests].filter((e) => e.tasks.includes(parentId)).map((e) => e.path),
  );
  const bad = checkPartition(parent, parentPaths, kids);
  if (bad !== null) return { ok: false, reason: bad };
  const ids = kids.map((_, i) => `${parentId}.${i + 1}`);
  const children: TaskUnit[] = kids.map((k, i) => ({
    id: ids[i]!,
    description: k.description,
    expectedOutput: [...k.expectedOutput],
    status: "active",
    ...(k.commands && k.commands.length > 0 ? { commands: [...k.commands] } : {}),
  }));
  const tasks = prior.tasks.flatMap((t) => (t.id === parentId ? children : [t]));
  return {
    ok: true,
    contract: {
      ...prior,
      sources: rewrite(prior.sources, parentId, ids, kids),
      tests: rewrite(prior.tests, parentId, ids, kids),
      tasks,
    },
  };
}
