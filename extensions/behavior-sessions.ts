/**
 * Behavior resume sessions (T3): every spawn for one behavior targets the
 * same deterministic session id `<behaviorId>-<baselineHead first 8 chars>`
 * under `unitSessionDir`, so a halted `/implement` run resumes the
 * behavior's transcript instead of starting cold. Existence of that
 * session's `.jsonl` tells follow-up prompts whether the transcript
 * already holds the base task text.
 */

import { unitSessionDir, unitSessionFile, type UnitSessionSpec } from "./unit-session.ts";
import { chooseFixSession, type FixSessionPlan, type FixTrigger } from "./fix-session.ts";

export type { FixTrigger } from "./fix-session.ts";

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

/** Fix-round tracking for one behavior (T6): latest attempt context usage and fix index. */
export interface FixRoundTracker {
  /** Latest context usage percent reported by the behavior's attempts; undefined when unknown. */
  contextPercent: number | undefined;
  /** Fix rounds started so far (0 before the first). */
  fixIndex: number;
}

/**
 * Create an empty fix-round tracker for one behavior.
 *
 * @returns A tracker with unknown context and fix index 0.
 */
export function createFixRoundTracker(): FixRoundTracker {
  return { contextPercent: undefined, fixIndex: 0 };
}

/**
 * Record the latest attempt's context usage on the behavior's tracker.
 *
 * @param tracker       - The behavior's fix-round tracker.
 * @param contextPercent - Percent read from the attempt; undefined overwrites with "unknown".
 */
export function noteAttemptContext(tracker: FixRoundTracker, contextPercent: number | undefined): void {
  tracker.contextPercent = contextPercent;
}

/**
 * Choose the session for the behavior's next fix round.
 *
 * Advances the fix index, resolves the implementation transcript to its
 * absolute `.jsonl` path via `unitSessionFile`, and delegates to
 * `chooseFixSession` — the fork source is always the implementation session,
 * never an earlier fix session.
 *
 * @param tracker - The behavior's tracker (context percent + fix index, mutated in place).
 * @param session - The behavior's implementation session spec (dir + id).
 * @param trigger - What made this round fail.
 * @returns The fix session plan for a new child spawn.
 */
export function chooseBehaviorFixSession(
  tracker: FixRoundTracker,
  session: UnitSessionSpec,
  trigger: FixTrigger,
): FixSessionPlan {
  tracker.fixIndex += 1;
  const sourceFile = unitSessionFile(session.dir, session.id);
  return chooseFixSession({
    trigger,
    contextPercent: tracker.contextPercent,
    implSessionId: session.id,
    fixIndex: tracker.fixIndex,
    sourceFile,
  });
}
