/**
 * Fix-round session selection (T6): a fix-forward round always spawns a fresh
 * child on a session chosen here — forked from the behavior's IMPLEMENTATION
 * transcript for semantic triggers (red scope gate, no-changes) with context
 * headroom, fresh otherwise. Mechanical triggers (hook-rejected, slop-guard)
 * and unknown/over-limit context never fork, and an earlier fix session is
 * never a fork source.
 */

/** Fix triggers: semantic rounds may fork the implementation transcript; mechanical rounds never do. */
export type FixTrigger = "scope-gate" | "no-changes" | "hook-rejected" | "slop-guard";

/** Semantic (fork-capable) fix triggers. */
const SEMANTIC_TRIGGERS: readonly FixTrigger[] = ["scope-gate", "no-changes"];

/** Context usage percent at or below which a semantic fix round may fork the implementation session. */
export const FIX_FORK_CONTEXT_LIMIT = 50;

/** Inputs for one fix-round session decision. */
export interface ChooseFixSessionInput {
  /** What made this round fail (semantic rounds fork; mechanical rounds never do). */
  trigger: FixTrigger;
  /** The implementation attempt's latest context usage percent; undefined when unknown. */
  contextPercent?: number;
  /** The behavior's implementation session id (never a fix session id). */
  implSessionId: string;
  /** 1-based index of this fix round for the behavior. */
  fixIndex: number;
  /** Absolute `.jsonl` path of the implementation transcript (via `unitSessionFile`), or undefined when absent. */
  sourceFile?: string;
}

/** Session selection for one fix round: a new session id plus an optional fork source id. */
export interface FixSessionPlan {
  /** New session id `<implSessionId>-fix<fixIndex>` (both fork and fresh rounds). */
  id: string;
  /** Implementation session id to fork from; absent for a fresh session. */
  forkFrom?: string;
}

/**
 * Choose the session one fix-forward round spawns on.
 *
 * Semantic triggers (red scope gate, no-changes) fork the implementation
 * session — resolved by `unitSessionFile` to its absolute `.jsonl` — when the
 * implementation context usage is known and at most 50%; a missing transcript
 * falls back to a fresh session. Mechanical triggers (hook-rejected,
 * slop-guard), context above 50%, or unknown context always return a fresh
 * spec. Both variants carry the new id `<implSessionId>-fix<fixIndex>`, so a
 * fix session is never a fork source.
 *
 * @param input - Trigger, context percent, implementation session id, fix index, transcript path.
 * @returns The fix session plan: `forkFrom` set only for a forkable round.
 */
export function chooseFixSession(input: ChooseFixSessionInput): FixSessionPlan {
  const { trigger, contextPercent, implSessionId, fixIndex, sourceFile } = input;
  const id = `${implSessionId}-fix${fixIndex}`;
  const canFork =
    SEMANTIC_TRIGGERS.includes(trigger) &&
    contextPercent !== undefined &&
    contextPercent <= FIX_FORK_CONTEXT_LIMIT &&
    sourceFile !== undefined;
  return canFork ? { id, forkFrom: implSessionId } : { id };
}
