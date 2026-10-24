/**
 * Pure contract-guard core (T2): the authoritative allowlist rules shared by
 * the child guard extension (`extensions/contract-guard/index.ts`) and the
 * orchestrator's commit gate (`commitAndGate` in git-ops.ts). No I/O, no
 * exec, no model calls — every function takes plain inputs and returns
 * plain results.
 */

import { isAbsolute, relative, resolve, sep } from "node:path";

/** One declared file in the contract's allowlist (v1 entries carry path+status only). */
export interface DeclaredFile {
  /** Repo-relative path. */
  path: string;
  /**
   * A = added, M = modified, D = deleted. Optional: v2 entries may omit it
   * (absent = write-authorized; A/M is a display qualifier, never enforced).
   */
  status?: "A" | "M" | "D";
  /** Owning task ids when the entry carries PathEntry-style `tasks` refs. */
  tasks?: readonly string[];
  /** Owning task ids when the entry carries derived-allowlist-style `refs`. */
  refs?: readonly string[];
}

/** Repo-relative path of the orchestrator-owned generated test extension. */
export const TEST_EXTENSION_PATH = ".pi/extensions/test.ts";

/**
 * Owning task ids of a declared entry.
 *
 * Accepts both ref shapes: PathEntry-style `tasks` (validated contracts) and
 * derived-allowlist-style `refs` (contract-derive output). v1 entries carry
 * neither and yield an empty owner list.
 *
 * @param entry - The declared path entry.
 * @returns The owning task ids (possibly empty).
 */
function ownersOf(entry: DeclaredFile): readonly string[] {
  return entry.tasks ?? entry.refs ?? [];
}

/** Mutating tool actions the allowlist governs. */
export type GuardAction = "write" | "edit" | "delete_file";

/** Result of a tool-action check against the allowlist. */
export type ToolCheckResult =
  | { allowed: true }
  | { allowed: false; reason: string };

/** Normalization result: repo-relative POSIX path, or a block reason. */
export type NormalizedPath =
  | { ok: true; path: string }
  | { ok: false; reason: string };

/** The guidance repeated in every actionable allowlist block reason. */
const CONTRACT_CHANGE_HINT =
  "The contract's files list is authoritative — a contract change needs " +
  "/discuss -> /finalize.";

/** Name-status statuses accepted from `git diff --name-status` output. */
const VALID_STATUSES = new Set(["A", "M", "D", "T", "U", "X", "R", "C"]);

/**
 * Render declared files as comma-separated "path (STATUS)" items.
 *
 * @param files - The contract's declared allowlist entries.
 * @returns e.g. `src/a.ts (M), tests/a.test.ts (A)`; an explicit placeholder
 *          when the allowlist is empty.
 */
export function formatDeclaredList(files: readonly DeclaredFile[]): string {
  if (files.length === 0) return "(no files declared)";
  return files
    .map((f) => (f.status ? `${f.path} (${f.status})` : f.path))
    .join(", ");
}

/**
 * Resolve a path against cwd into a repo-relative POSIX path.
 *
 * Blocks anything under `.git/` (version-control internals), the repository
 * root itself, and anything resolving outside the working tree.
 *
 * @param rawPath - Tool-provided path (absolute, relative, with `.`/`..`).
 * @param cwd     - Repository working directory.
 * @returns The normalized repo-relative path, or a block reason.
 */
export function normalizeRepoPath(rawPath: string, cwd: string): NormalizedPath {
  const root = resolve(cwd);
  const abs = resolve(root, rawPath);
  if (abs === root) {
    return {
      ok: false,
      reason: `Blocked: ${rawPath} resolves to the repository root, not a file.`,
    };
  }
  const rel = relative(root, abs).split(sep).join("/");
  if (rel === ".." || rel.startsWith("../") || isAbsolute(rel)) {
    return {
      ok: false,
      reason: `Blocked: ${rawPath} resolves outside the repository working tree.`,
    };
  }
  if (rel === ".git" || rel.startsWith(".git/")) {
    return {
      ok: false,
      reason:
        `Blocked: ${rawPath} is under .git/ — version-control internals ` +
        `are never editable.`,
    };
  }
  return { ok: true, path: rel };
}

/**
 * Check one mutating tool action against the contract's file allowlist.
 *
 * Rules: `write` is allowed for declared A or M paths; `edit` for declared
 * M or A paths; `delete_file` only for declared D paths. Undeclared paths,
 * write/edit on declared D paths, `.git/` paths, paths outside the repo and
 * unknown actions are blocked. Block reasons are actionable: they list the
 * declared paths with their statuses and point at /discuss -> /finalize.
 *
 * Strict per-task ownership (T4): when `taskId` is supplied, every mutating
 * action additionally requires the path's refs to include that task id.
 * Write/edit on `.pi/extensions/test.ts` is blocked unconditionally — the
 * generated test extension is orchestrator-owned, declared or not (T4).
 *
 * @param input - The action, the tool-provided path, cwd, declared files and
 *                (optionally) the unit's task id.
 * @returns `{ allowed: true }` or `{ allowed: false, reason }`.
 */
export function checkToolAction(input: {
  action: string;
  path: string;
  cwd: string;
  files: readonly DeclaredFile[];
  /** The unit's task id: when present, the path's refs must include it. */
  taskId?: string;
}): ToolCheckResult {
  if (input.action !== "write" && input.action !== "edit" && input.action !== "delete_file") {
    return {
      allowed: false,
      reason:
        `Blocked: tool action "${input.action}" is not permitted in this unit — ` +
        `only write, edit and delete_file may touch files. ${CONTRACT_CHANGE_HINT}`,
    };
  }
  const norm = normalizeRepoPath(input.path, input.cwd);
  if (!norm.ok) return { allowed: false, reason: norm.reason };
  // Orchestrator-owned generated test extension (T4): write/edit is never
  // allowed from a unit, declared or not — the orchestrator owns the file.
  if (norm.path === TEST_EXTENSION_PATH && input.action !== "delete_file") {
    return {
      allowed: false,
      reason:
        `Blocked: ${TEST_EXTENSION_PATH} is orchestrator-owned (the generated ` +
        `test extension) — ${input.action} is never allowed on it from a unit, ` +
        `declared or not. The orchestrator regenerates the file; no contract ` +
        `path grants access.`,
    };
  }
  const list = formatDeclaredList(input.files);
  let declared: DeclaredFile | undefined;
  for (const f of input.files) {
    const n = normalizeRepoPath(f.path, input.cwd);
    if (n.ok && n.path === norm.path) {
      declared = f;
      break;
    }
  }
  if (!declared) {
    return {
      allowed: false,
      reason:
        `Blocked: ${norm.path} is not declared for ${input.action} in the ` +
        `contract's file allowlist. Declared files: ${list}. ${CONTRACT_CHANGE_HINT}`,
    };
  }
  // Strict per-task ownership (T4): with a known unit task id, the path's
  // refs must include it for every mutating action.
  if (input.taskId !== undefined) {
    const owners = ownersOf(declared);
    if (!owners.includes(input.taskId)) {
      return {
        allowed: false,
        reason:
          `Blocked: ${norm.path} is not owned by task ${input.taskId} — its ` +
          `owning task(s): ${owners.length > 0 ? owners.join(", ") : "(none)"}. ` +
          `Declared files: ${list}. ${CONTRACT_CHANGE_HINT}`,
      };
    }
  }
  if (input.action === "delete_file") {
    if (declared.status !== "D") {
      return {
        allowed: false,
        reason:
          `Blocked: delete_file requires ${norm.path} to be declared with ` +
          `status D; it is declared as ${declared.status}. Declared files: ` +
          `${list}. ${CONTRACT_CHANGE_HINT}`,
      };
    }
    return { allowed: true };
  }
  if (declared.status === "D") {
    return {
      allowed: false,
      reason:
        `Blocked: ${norm.path} is declared as D (deleted) — ${input.action} ` +
        `is not allowed on a declared deletion. Declared files: ${list}. ` +
        `${CONTRACT_CHANGE_HINT}`,
    };
  }
  return { allowed: true };
}

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

/** Result of classifying one staged diff against the contract's allowlist. */
export interface BaselineDiffResult {
  /** Undeclared paths, unauthorized deletes and `.git/` paths; empty when clean. */
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
 * HARD violations (T4) — nothing else halts: (a) a staged path declared
 * nowhere in the contract, (b) a staged `D` on a path whose refs do not
 * include the committing task (`taskId`), and (c) any `.git/` path. Staged
 * A on a declared M path (and the reverse) is NEVER a violation — at most
 * an advisory line. v1 entries carry no refs: without a `taskId`, staged D
 * falls back to the declared D delete authority. Pure: the caller supplies
 * the raw output.
 *
 * @param input - Raw name-status output, declared files, baseline ref label
 *                and (optionally) the committing task id.
 * @returns The violations, the advisories and the investigation text
 *          (empty violations = clean).
 */
export function classifyBaselineDiff(input: {
  nameStatus: string;
  files: readonly DeclaredFile[];
  baselineRef?: string;
  /** Committing task id: staged D then requires ownership via the entry's refs. */
  taskId?: string;
}): BaselineDiffResult {
  const declaredByPath = new Map<string, DeclaredFile>();
  for (const f of input.files) declaredByPath.set(f.path.replace(/^\.\//, ""), f);
  const violations: string[] = [];
  const advisories: string[] = [];
  const lines: string[] = [];
  for (const entry of parseNameStatus(input.nameStatus)) {
    const path = entry.path.replace(/^\.\//, "");
    lines.push(`  ${entry.status}\t${path}`);
    if (path === ".git" || path.startsWith(".git/")) {
      violations.push(`path under .git/ staged: ${path}`);
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
  /** Staged paths declared nowhere (incl. `.git/` paths) — these halt the commit. */
  undeclared: string[];
  /** One exact `git restore --staged -- <path>` per contaminated path. */
  commands: string[];
}

/**
 * Plan the commit-time unstage of cross-task contamination (T4/T6).
 *
 * Classifies every staged path (from `git diff --cached --name-status`
 * output) against the contract's declared paths and the committing task's
 * ownership: owned paths proceed, paths owned by OTHER tasks become
 * cross-task contamination carrying the exact `git restore --staged --
 * <path>` remediation (the work stays on disk for its owning task), and
 * paths declared nowhere — including anything under `.git/` and declared
 * entries that name NO owning task — land in `undeclared` so the caller
 * halts instead of unstaging. Pure: no I/O.
 *
 * @param contract   - The contract's declared paths (sources ∪ tests), each
 *                     carrying its owning task ids (`tasks` or `refs`).
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
    const declared =
      path === ".git" || path.startsWith(".git/")
        ? undefined
        : declaredByPath.get(path);
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
