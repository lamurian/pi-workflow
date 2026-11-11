/**
 * Behavior resume sessions (T3): every spawn for one behavior targets the
 * same deterministic session id `<behaviorId>-<baselineHead first 8 chars>`
 * under `unitSessionDir`, so a halted `/implement` run resumes the
 * behavior's transcript instead of starting cold. Existence of that
 * session's `.jsonl` tells follow-up prompts whether the transcript
 * already holds the base task text.
 */

import { unitSessionDir, unitSessionFile, type UnitSessionSpec } from "./unit-session.ts";

/**
 * Derive the deterministic resume session id for one behavior.
 *
 * The id pairs the behavior with the task's baseline head so a re-finalized
 * contract (new baseline) starts a fresh transcript while a plain resume of
 * the same contract reuses it.
 *
 * @param behaviorId   - Behavior id, e.g. "T1".
 * @param baselineHead - Task baseline commit; falls back to "HEAD" when unset.
 * @returns The session id `<behaviorId>-<first 8 chars of baselineHead>`.
 */
export function behaviorSessionId(behaviorId: string, baselineHead?: string): string {
  const head = baselineHead ?? "HEAD";
  return `${behaviorId}-${head.slice(0, 8)}`;
}

/** A behavior's resume session: the spawn spec plus on-disk transcript state. */
export interface BehaviorSession {
  /** Spec forwarded to every spawn of this behavior (`unit.session`). */
  session: UnitSessionSpec;
  /** True when the session's `.jsonl` transcript already exists. */
  exists: boolean;
}

/**
 * Resolve the resume session for one behavior in the given working dir.
 *
 * Ensures the sessions dir exists (`unitSessionDir`), derives the
 * deterministic id, and reports whether its transcript file is already on
 * disk (suffix match `_<sessionId>.jsonl` via `unitSessionFile`).
 *
 * @param cwd          - Repository working directory.
 * @param behaviorId   - Behavior id, e.g. "T1".
 * @param baselineHead - Task baseline commit; falls back to "HEAD" when unset.
 * @returns The session spec and whether its transcript already exists.
 */
export function resolveBehaviorSession(
  cwd: string,
  behaviorId: string,
  baselineHead?: string,
): BehaviorSession {
  const dir = unitSessionDir(cwd);
  const id = behaviorSessionId(behaviorId, baselineHead);
  return { session: { dir, id }, exists: unitSessionFile(dir, id) !== undefined };
}
