/**
 * Persistent session plumbing for implementer units (T1): the sessions
 * directory lives under the self-ignoring `.pi/workflow` runtime dir,
 * fork sources resolve to an explicit `.jsonl` path by suffix match
 * (`_<sessionId>.jsonl`), and the argv builder swaps `--no-session` for
 * `--session-dir`/`--session-id` (plus `--fork <path>` when forking).
 */

import { mkdirSync, readdirSync, unlinkSync, type Dirent } from "node:fs";
import { join, resolve } from "node:path";
import { ensureWorkflowRuntimeDir } from "./contract-guard-file.ts";
import { WORKFLOW_RUNTIME_DIR } from "./contract-guard-core.ts";

/**
 * Session selection for one implementer spawn.
 *
 * `dir` is passed verbatim as `--session-dir` and `id` as `--session-id`.
 * `forkFrom` names the SOURCE session; it is resolved to an explicit
 * `.jsonl` path via {@link unitSessionFile} because `--fork`'s id form
 * targets partial UUIDs — custom ids are never passed bare.
 */
export interface UnitSessionSpec {
  /** Sessions directory passed as `--session-dir`. */
  dir: string;
  /** Session id passed as `--session-id` (the new/current session). */
  id: string;
  /** Source session id (possibly a partial UUID) to fork from. */
  forkFrom?: string;
}

/**
 * Ensure the workflow runtime dir and the sessions dir exist.
 *
 * Calls `ensureWorkflowRuntimeDir(cwd)` (creates `.pi/workflow` with a
 * `.gitignore` containing exactly `*`) then creates
 * `<cwd>/.pi/workflow/sessions` recursively.
 *
 * @param cwd - Repository working directory.
 * @returns Absolute path of the sessions directory.
 */
export function unitSessionDir(cwd: string): string {
  ensureWorkflowRuntimeDir(cwd);
  const sessions = resolve(cwd, WORKFLOW_RUNTIME_DIR, "sessions");
  mkdirSync(sessions, { recursive: true });
  return sessions;
}

/**
 * Resolve a session id to its transcript file inside a sessions dir.
 *
 * Walks `dir` recursively looking for a file whose name ends with
 * `_<sessionId>.jsonl` (flat or nested layout); the first match wins.
 *
 * @param dir       - Sessions directory to scan (created by {@link unitSessionDir}).
 * @param sessionId - Full or partial session id (the `--fork` id form).
 * @returns Absolute path of the matching `.jsonl`, or undefined when the
 *          dir is missing or no file matches the suffix.
 */
export function unitSessionFile(dir: string, sessionId: string): string | undefined {
  if (!sessionId) return undefined;
  const suffix = `_${sessionId}.jsonl`;
  const root = resolve(dir);
  const walk = (current: string): string | undefined => {
    let entries: Dirent[];
    try {
      entries = readdirSync(current, { withFileTypes: true });
    } catch {
      return undefined;
    }
    for (const entry of entries) {
      const full = join(current, entry.name);
      if (entry.isDirectory()) {
        const hit = walk(full);
        if (hit) return hit;
      } else if (entry.isFile() && entry.name.endsWith(suffix)) {
        return full;
      }
    }
    return undefined;
  };
  return walk(root);
}

/**
 * Delete every session transcript belonging to one behavior.
 *
 * Walks `dir` recursively and unlinks each `.jsonl` whose session id starts
 * with `behaviorSessionId` — the behavior's implementation session plus any
 * fix sessions sharing the id stem (flat or nested layout). Other behaviors'
 * transcripts and non-`.jsonl` files are left untouched; a missing dir is a
 * no-op. Halts must NOT call this so /implement can resume the transcript.
 *
 * @param dir               - Sessions directory to clean (may be missing).
 * @param behaviorSessionId - Behavior session id prefix (`<behaviorId>-<head8>`).
 */
export function removeBehaviorSessions(dir: string, behaviorSessionId: string): void {
  if (!behaviorSessionId) return;
  const root = resolve(dir);
  const walk = (current: string): void => {
    let entries: Dirent[];
    try {
      entries = readdirSync(current, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = join(current, entry.name);
      if (entry.isDirectory()) {
        walk(full);
      } else if (entry.isFile() && entry.name.endsWith(".jsonl")) {
        const stem = entry.name.slice(0, -".jsonl".length);
        if (stem.startsWith(behaviorSessionId) || stem.includes(`_${behaviorSessionId}`)) {
          try {
            unlinkSync(full);
          } catch {
            // Already gone (concurrent cleanup) — treat as deleted.
          }
        }
      }
    }
  };
  walk(root);
}
