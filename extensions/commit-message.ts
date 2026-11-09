// Per-task `commit` rules for contract v2: single line, <=75 chars,
// conventional "type(scope): description" form, no declared task id, and
// one unique message per non-removed task.

import type { TaskUnit } from "./contract-types.ts";

/** Maximum length of a task commit message. */
export const TASK_COMMIT_MAX_LENGTH = 75;

/** Conventional form: lowercase type, optional scope, colon + description. */
const CONVENTIONAL_COMMIT = /^[a-z]+(\([a-z0-9][a-z0-9-]*\))?: .+$/;

/** Characters that would make a task id part of a larger token. */
const TOKEN_CHAR = /[A-Za-z0-9.]/;

/**
 * Whether a commit mentions a declared task id as its own token
 * (delimited by non-token characters or string edges), e.g. "feat(T1): x".
 *
 * @param commit - The commit message to scan.
 * @param id     - The declared task id to look for.
 * @returns true when the id appears as a standalone token.
 */
function mentionsTaskId(commit: string, id: string): boolean {
  let at = commit.indexOf(id);
  while (at !== -1) {
    const before = at > 0 ? commit[at - 1]! : "";
    const after = at + id.length < commit.length ? commit[at + id.length]! : "";
    if (!TOKEN_CHAR.test(before) && !TOKEN_CHAR.test(after)) return true;
    at = commit.indexOf(id, at + 1);
  }
  return false;
}

/**
 * Validate one task's commit message format.
 *
 * @param taskId - The owning task id (named in rejections).
 * @param commit - The raw commit message.
 * @returns null when valid, otherwise the rejection naming the task and rule.
 */
export function validateTaskCommit(taskId: string, commit: string): string | null {
  if (commit.trim() === "") {
    return `task ${taskId} commit must be a non-empty string`;
  }
  if (commit.includes("\n") || commit.includes("\r")) {
    return `task ${taskId} commit must be a single line — multi-line commits are rejected`;
  }
  if (commit.length > TASK_COMMIT_MAX_LENGTH) {
    return (
      `task ${taskId} commit must be at most ${TASK_COMMIT_MAX_LENGTH} characters ` +
      `(got ${commit.length})`
    );
  }
  if (!CONVENTIONAL_COMMIT.test(commit)) {
    return (
      `task ${taskId} commit must match the conventional form ` +
      `"type(scope): description" (got ${JSON.stringify(commit)})`
    );
  }
  return null;
}

/**
 * Check every commit rule that spans a contract: per-commit format, no
 * declared task id inside a commit, and one unique message per non-removed
 * task (removed tasks may share or keep stale commits).
 *
 * @param tasks - All task units of the contract being saved.
 * @returns null when valid, otherwise the rejection naming the offending task(s).
 */
export function checkTaskCommitRules(tasks: readonly TaskUnit[]): string | null {
  const ids = tasks.map((t) => t.id);
  const seen = new Map<string, string>();
  for (const t of tasks) {
    const commit = t.commit;
    if (commit === undefined) continue;
    const bad = validateTaskCommit(t.id, commit);
    if (bad !== null) return bad;
    for (const id of ids) {
      if (mentionsTaskId(commit, id)) {
        return (
          `task ${t.id} commit ${JSON.stringify(commit)} contains the declared ` +
          `task id ${id} — task ids must not appear in commit messages`
        );
      }
    }
    if (t.status === "removed") continue;
    const prior = seen.get(commit);
    if (prior !== undefined) {
      return (
        `tasks ${prior} and ${t.id} share the same commit ` +
        `${JSON.stringify(commit)} — each non-removed task needs its own commit message`
      );
    }
    seen.set(commit, t.id);
  }
  return null;
}
