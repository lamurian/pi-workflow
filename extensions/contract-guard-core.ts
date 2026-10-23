/**
 * Pure contract-guard core (T2): the authoritative allowlist rules shared by
 * the child guard extension (`extensions/contract-guard/index.ts`) and the
 * orchestrator's commit gate (`commitAndGate` in git-ops.ts). No I/O, no
 * exec, no model calls — every function takes plain inputs and returns
 * plain results.
 */

import { isAbsolute, relative, resolve, sep } from "node:path";

/** One declared file in the contract's allowlist (structurally FileEntry). */
export interface DeclaredFile {
  /** Repo-relative path. */
  path: string;
  /** A = added, M = modified, D = deleted. */
  status: "A" | "M" | "D";
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
  return files.map((f) => `${f.path} (${f.status})`).join(", ");
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
 * @param input - The action, the tool-provided path, cwd and declared files.
 * @returns `{ allowed: true }` or `{ allowed: false, reason }`.
 */
export function checkToolAction(input: {
  action: string;
  path: string;
  cwd: string;
  files: readonly DeclaredFile[];
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
  /** Undeclared paths, status mismatches and `.git/` paths; empty when clean. */
  violations: string[];
  /** Name-status lines, declared list and violations for the halt/steer text. */
  investigation: string;
}

/**
 * Deterministically classify a staged diff against the contract's allowlist.
 *
 * The name-status must be measured against the /implement baseline
 * (`git diff --cached --name-status --no-renames <baselineHead>`), so files
 * landed by earlier behaviors of the same run are still checked. Every
 * changed path must be declared with exactly the staged status; anything
 * else is a violation. Pure: the caller supplies the raw output.
 *
 * @param input - Raw name-status output, declared files, baseline ref label.
 * @returns The violations and the investigation text (empty violations = clean).
 */
export function classifyBaselineDiff(input: {
  nameStatus: string;
  files: readonly DeclaredFile[];
  baselineRef?: string;
}): BaselineDiffResult {
  const declaredByPath = new Map<string, DeclaredFile>();
  for (const f of input.files) declaredByPath.set(f.path.replace(/^\.\//, ""), f);
  const violations: string[] = [];
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
    if (declared.status !== entry.status) {
      violations.push(
        `status mismatch: ${path} staged as ${entry.status} but declared ${declared.status}`,
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
  if (violations.length > 0) {
    parts.push("", "Violations:", ...violations.map((v) => `  - ${v}`), "", CONTRACT_CHANGE_HINT);
  }
  return { violations, investigation: parts.join("\n") };
}
