/**
 * Pure contract-guard core (T2): the authoritative allowlist rules shared by
 * the child guard extension (`extensions/contract-guard/index.ts`) and the
 * orchestrator's commit gate (`commitAndGate` in git-commit-gate.ts). No I/O,
 * no exec, no model calls — every function takes plain inputs and returns
 * plain results. The staged-diff half lives in contract-guard-diff.ts.
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
 * Repo-relative runtime dir for the per-spawn payload. The folder carries its
 * own `.gitignore` (`*`), so the payload never reaches the staged diff.
 */
export const WORKFLOW_RUNTIME_DIR = ".pi/workflow";

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
export function ownersOf(entry: DeclaredFile): readonly string[] {
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
export const CONTRACT_CHANGE_HINT =
  "The contract's files list is authoritative — a contract change needs " +
  "/discuss -> /finalize.";

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
 * All three actions on `.pi/workflow` or anything under it are blocked
 * unconditionally — the runtime folder holds orchestrator-owned payload
 * files, declared or not (T2).
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
  // Orchestrator-owned workflow runtime (T2): `.pi/workflow` and everything
  // under it holds the per-spawn payload — write/edit/delete_file is never
  // allowed from a unit, declared or not.
  if (
    norm.path === WORKFLOW_RUNTIME_DIR ||
    norm.path.startsWith(`${WORKFLOW_RUNTIME_DIR}/`)
  ) {
    return {
      allowed: false,
      reason:
        `Blocked: ${norm.path} is under ${WORKFLOW_RUNTIME_DIR}/ — ` +
        `orchestrator-owned runtime files (the per-spawn payload lives ` +
        `there). ${input.action} is never allowed on them from a unit, ` +
        `declared or not.`,
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
