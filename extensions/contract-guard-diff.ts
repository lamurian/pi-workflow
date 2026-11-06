// Name-status parsing, baseline-diff classification and the commit-time
// cross-task contamination plan (T4/T6), split out of contract-guard-core.ts.
// Pure: no I/O, no exec, no model calls — callers supply raw git output.

import {
  CONTRACT_CHANGE_HINT,
  formatDeclaredList,
  ownersOf,
  WORKFLOW_RUNTIME_DIR,
  type DeclaredFile,
} from "./contract-guard-core.ts";

/** Name-status statuses accepted from `git diff --name-status` output. */
const VALID_STATUSES = new Set(["A", "M", "D", "T", "U", "X", "R", "C"]);

/** One parsed `git diff --name-status` entry. */
interface NameStatusEntry {
  status: string;
  path: string;
}

/**
 * Parse `git diff --name-status` lines; renames/copies split into
 * D(old) + A(new) so each path is checked against its own declaration.
 *
 * @param nameStatus - Raw name-status output.
 * @returns The parsed entries (malformed lines are skipped).
 */
function parseNameStatus(nameStatus: string): NameStatusEntry[] {
  const entries: NameStatusEntry[] = [];
  for (const line of nameStatus.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const fields = trimmed.split("\t");
    const status = fields[0]?.[0] ?? "";
    if (!VALID_STATUSES.has(status)) continue;
    if ((status === "R" || status === "C") && fields[1] && fields[2]) {
      entries.push({ status: "D", path: fields[1] });
      entries.push({ status: "A", path: fields[2] });
    } else if (fields[1]) {
      entries.push({ status, path: fields[1] });
    }
  }
  return entries;
}

/** Staged `.git/` and `.pi/workflow` paths bypass the allowlist entirely (T3). */
function isBlockedPath(path: string): boolean {
  return [".git", WORKFLOW_RUNTIME_DIR].some(
    (dir) => path === dir || path.startsWith(`${dir}/`),
  );
}

/** Result of classifying one staged diff against the contract's allowlist. */
export interface BaselineDiffResult {
  /** Undeclared paths, unauthorized deletes, `.git/` and `.pi/workflow` runtime paths; empty when clean. */
  violations: string[];
  /** Non-blocking notes: A/M status drift, owned deletes on non-D declarations. */
  advisories: string[];
  /** Name-status lines, declared list, advisories and violations for the halt/steer text. */
  investigation: string;
}

/**
 * Deterministically classify a staged diff against the contract's allowlist.
 *
 * The name-status must be measured against the /implement baseline
 * (`git diff --cached --name-status --no-renames <baselineHead>`), so files
 * landed by earlier behaviors of the same run are still checked.
 *
 * HARD violations (T4) — nothing else halts: (a) an undeclared staged path,
 * (b) a staged `D` on a path whose refs lack the committing task (`taskId`)
 * — skipped when `pendingVsHead` lacks the path (it already landed) — and
 * (c) any `.git/` or `.pi/workflow` path (T3), declared or not. A/M status
 * drift on a declared path is NEVER a violation — at most an advisory line.
 * v1 entries carry no refs: without a `taskId`, staged D falls back to the
 * declared D delete authority. Pure: the caller supplies the raw output.
 *
 * @param input - Raw name-status output, declared files, baseline ref label,
 *                (optionally) the committing task id and (optionally) the
 *                paths still pending versus HEAD (`pendingVsHead`).
 * @returns Violations, advisories and investigation text (empty = clean).
 */
export function classifyBaselineDiff(input: {
  nameStatus: string;
  files: readonly DeclaredFile[];
  baselineRef?: string;
  /** Committing task id: staged D then requires ownership via the entry's refs. */
  taskId?: string;
  /** Paths still pending versus HEAD: a `D` absent from this set already landed. */
  pendingVsHead?: ReadonlySet<string>;
}): BaselineDiffResult {
  const declaredByPath = new Map<string, DeclaredFile>();
  for (const f of input.files) declaredByPath.set(f.path.replace(/^\.\//, ""), f);
  const violations: string[] = [];
  const advisories: string[] = [];
  const lines: string[] = [];
  for (const entry of parseNameStatus(input.nameStatus)) {
    const path = entry.path.replace(/^\.\//, "");
    lines.push(`  ${entry.status}\t${path}`);
    // T3: force-staged runtime state bypasses the allowlist entirely.
    if (isBlockedPath(path)) {
      violations.push(`path under .git/ or ${WORKFLOW_RUNTIME_DIR}/ staged: ${path}`);
      continue;
    }
    const declared = declaredByPath.get(path);
    if (!declared) {
      violations.push(
        `undeclared path staged as ${entry.status}: ${path} — not in the contract's file allowlist`,
      );
      continue;
    }
    if (entry.status === "D") {
      // T2: absent from pendingVsHead ⇒ already landed — skip the ownership check.
      if (input.pendingVsHead !== undefined && !input.pendingVsHead.has(path)) continue;
      if (input.taskId !== undefined) {
        const owners = ownersOf(declared);
        if (!owners.includes(input.taskId)) {
          violations.push(
            `unauthorized delete: ${path} is staged D but owned by ` +
              `${owners.length > 0 ? owners.join(", ") : "no task"} — not by ` +
              `the committing task ${input.taskId}`,
          );
          continue;
        }
        if (declared.status !== undefined && declared.status !== "D") {
          advisories.push(
            `${path} staged D although declared ${declared.status} — allowed: ` +
              `task ${input.taskId} owns the path (status is display-only)`,
          );
        }
        continue;
      }
      // v1 entries carry no refs: fall back to the declared D delete authority.
      if (declared.status !== "D") {
        violations.push(
          `status mismatch: ${path} staged as D but declared ${declared.status ?? "(no status)"}`,
        );
      }
      continue;
    }
    // A/M (and any other status): staged drift on a declared path never halts.
    if (declared.status !== undefined && declared.status !== entry.status) {
      advisories.push(
        `${path} staged as ${entry.status} but declared ${declared.status} — ` +
          `status drift is advisory only (write access is ownership-based)`,
      );
    }
  }
  const parts = [
    `## Contract-guard: staged diff vs ${input.baselineRef ?? "baseline"}`,
    "",
    "Name-status:",
    lines.length > 0 ? lines.join("\n") : "  (none)",
    "",
    `Declared files: ${formatDeclaredList(input.files)}`,
  ];
  if (advisories.length > 0) {
    parts.push("", "Advisories (non-blocking):", ...advisories.map((a) => `  - ${a}`));
  }
  if (violations.length > 0) {
    parts.push("", "Violations:", ...violations.map((v) => `  - ${v}`), "", CONTRACT_CHANGE_HINT);
  }
  return { violations, advisories, investigation: parts.join("\n") };
}

/** One staged path owned by another task: unstage it, keep the work on disk. */
export interface ContaminatedPath {
  /** Repo-relative staged path. */
  path: string;
  /** The staged name-status letter (A/M/D/...). */
  status: string;
  /** Task ids that own the path (empty when the entry carries no refs). */
  ownerTasks: string[];
  /** The exact remediation command for this path. */
  command: string;
}

/** Result of planUnstage: owned subset, cross-task contamination, undeclared paths. */
export interface UnstagePlan {
  /** Staged paths owned by the committing task — proceed with these. */
  owned: string[];
  /** Staged paths declared but owned by OTHER tasks — auto-unstage each. */
  contamination: ContaminatedPath[];
  /** Staged paths declared nowhere (incl. `.git/` and `.pi/workflow` paths) — these halt the commit. */
  undeclared: string[];
  /** One exact `git restore --staged -- <path>` per contaminated path. */
  commands: string[];
}

/**
 * Plan the commit-time unstage of cross-task contamination (T4/T6).
 *
 * Every staged path is classified against the declared paths and ownership:
 * owned paths proceed, OTHER-task paths become contamination with the exact
 * `git restore --staged -- <path>` remediation (the work stays on disk for
 * its owning task), and undeclared paths — including `.git/`, the
 * `.pi/workflow` runtime dir (T3) and entries naming NO owning task — land
 * in `undeclared` so the caller halts instead of unstaging. Pure: no I/O.
 *
 * @param contract   - Declared paths (sources ∪ tests) with owning task ids.
 * @param nameStatus - Raw `git diff --cached --name-status` output.
 * @param taskId     - The committing task's id.
 * @returns The owned subset, the contamination plan and the undeclared paths.
 */
export function planUnstage(
  contract: readonly DeclaredFile[],
  nameStatus: string,
  taskId: string,
): UnstagePlan {
  const declaredByPath = new Map<string, DeclaredFile>();
  for (const f of contract) declaredByPath.set(f.path.replace(/^\.\//, ""), f);
  const owned: string[] = [];
  const contamination: ContaminatedPath[] = [];
  const undeclared: string[] = [];
  for (const entry of parseNameStatus(nameStatus)) {
    const path = entry.path.replace(/^\.\//, "");
    // `.git/` and `.pi/workflow` bypass the allowlist: never owned (T3).
    const declared = isBlockedPath(path) ? undefined : declaredByPath.get(path);
    if (!declared) {
      undeclared.push(path);
      continue;
    }
    const owners = ownersOf(declared);
    if (owners.includes(taskId)) {
      owned.push(path);
      continue;
    }
    if (owners.length === 0) {
      // Declared but owned by no task: nobody may commit it — halt-worthy,
      // never contamination (there is no owning task to keep the work for).
      undeclared.push(path);
      continue;
    }
    contamination.push({
      path,
      status: entry.status,
      ownerTasks: [...owners],
      command: `git restore --staged -- ${path}`,
    });
  }
  return {
    owned,
    contamination,
    undeclared,
    commands: contamination.map((c) => c.command),
  };
}
