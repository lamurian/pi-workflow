// Orchestration claim (T5): a process-wide registry slot on globalThis plus
// a lock file in the workflow runtime dir, so a later /implement can detect
// a run orphaned by /reload. PI_ORCHESTRATION_LOCK=off disables the whole
// mechanism (no slot, no lock I/O); every claim call is best-effort and
// never blocks the launch.

import { readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { WORKFLOW_RUNTIME_DIR } from "./contract-guard-core.ts";
import { ensureWorkflowRuntimeDir } from "./contract-guard-file.ts";

/** Lock-file heartbeat refresh interval, in milliseconds (one minute). */
export const HEARTBEAT_INTERVAL_MS = 60_000;

/** A lock heartbeat older than this is stale, in milliseconds (three minutes). */
export const STALE_THRESHOLD_MS = 180_000;

/** Key of the orchestration claim slot on globalThis. */
export const ORCHESTRATION_CLAIM_KEY = "__piWorkflowOrchestrationClaim";

/** Timer handle that works whether setInterval yields a Node Timeout or a DOM number. */
type HeartbeatHandle = ReturnType<typeof setInterval> & { unref?: () => void };

/**
 * Heartbeat timer of the active claim, if any. Cleared when the claim is
 * released (the registry slot no longer holds it), when the mechanism is
 * switched off, and when a new claim supersedes the old one, so the timer
 * never outlives its claim.
 */
let heartbeat: HeartbeatHandle | undefined;

/** Name of the lock file inside the workflow runtime dir. */
const LOCK_FILE_NAME = "orchestration-lock.json";

/**
 * The in-process orchestration claim stored on globalThis. Later
 * /implement runs use `cancel` to take over an orphaned run and `settle`
 * to wait (boundedly, caller-side) until it has stopped.
 */
export interface Claim {
  /** Unique claim id; also written to the lock file. */
  id: string;
  /** Cancel the claimed run (used to take over an orphan). */
  cancel: () => void;
  /** Resolve once the claimed run has settled. */
  settle: () => Promise<void>;
}

/** Payload written to the orchestration lock file. */
interface LockFile {
  id: string;
  pid: number;
  startedAt: number;
  heartbeatAt: number;
}

/**
 * Whether the orchestration claim mechanism is enabled.
 *
 * @param env - Environment map (defaults to process.env).
 * @returns True unless `PI_ORCHESTRATION_LOCK` is exactly `off`.
 */
export function claimEnabled(
  env: Record<string, string | undefined> = process.env,
): boolean {
  return env.PI_ORCHESTRATION_LOCK !== "off";
}

/**
 * Absolute path of the orchestration lock file for a working directory.
 *
 * @param cwd - Repository working directory.
 * @returns `<cwd>/.pi/workflow/orchestration-lock.json`.
 */
export function orchestrationLockFilePath(cwd: string): string {
  return resolve(cwd, WORKFLOW_RUNTIME_DIR, LOCK_FILE_NAME);
}

/** Clear the active heartbeat timer, if one is running. */
function clearHeartbeat(): void {
  if (heartbeat !== undefined) {
    clearInterval(heartbeat);
    heartbeat = undefined;
  }
}

/**
 * Atomically write the lock payload (temp file, then rename). Best-effort:
 * a failure never blocks the claim or the heartbeat.
 *
 * @param file - Absolute path of the lock file.
 * @param lock - Payload to write.
 */
function writeLockFile(file: string, lock: LockFile): void {
  try {
    const tmp = `${file}.${process.pid}.tmp`;
    writeFileSync(tmp, JSON.stringify(lock, null, 2));
    renameSync(tmp, file);
  } catch {
    // Best-effort: a lock write failure must never block the claim.
  }
}

/**
 * Store the orchestration claim on globalThis and atomically write the
 * lock file (write to a temp path, then rename) carrying `id`, `pid`,
 * `startedAt` and `heartbeatAt`. The runtime dir is created on demand via
 * `ensureWorkflowRuntimeDir`.
 *
 * No-op when `PI_ORCHESTRATION_LOCK=off` (no slot, no lock I/O). The lock
 * write is best-effort: a failure never blocks the claim.
 *
 * @param cwd   - Repository working directory.
 * @param claim - The `{id, cancel, settle}` claim to store.
 */
export function claimOrchestration(cwd: string, claim: Claim): void {
  if (!claimEnabled()) return;
  // A new claim supersedes any previous one: release its heartbeat first.
  clearHeartbeat();
  (globalThis as Record<string, unknown>)[ORCHESTRATION_CLAIM_KEY] = claim;
  let file: string;
  const startedAt = Date.now();
  try {
    const dir = ensureWorkflowRuntimeDir(cwd);
    file = resolve(dir, LOCK_FILE_NAME);
    writeLockFile(file, {
      id: claim.id,
      pid: process.pid,
      startedAt,
      heartbeatAt: startedAt,
    });
  } catch {
    // Best-effort: a lock write failure must never block the claim.
    return;
  }
  // T5.2: while claimed, rewrite heartbeatAt every minute so a later
  // /implement can tell a live run from an orphan. The timer is unref'd so
  // it can never hold the process open, and it clears itself once the claim
  // is released (registry slot replaced or removed) or the mechanism is off.
  heartbeat = setInterval(() => {
    if (
      !claimEnabled() ||
      (globalThis as Record<string, unknown>)[ORCHESTRATION_CLAIM_KEY] !== claim
    ) {
      clearHeartbeat();
      return;
    }
    writeLockFile(file, {
      id: claim.id,
      pid: process.pid,
      startedAt,
      heartbeatAt: Date.now(),
    });
  }, HEARTBEAT_INTERVAL_MS) as HeartbeatHandle;
  heartbeat.unref?.();
}

/**
 * Release the orchestration claim carried by `id`.
 *
 * Stops the heartbeat and clears the globalThis slot only when the stored
 * claim id matches, and deletes the lock file only when its stored id
 * matches, so a foreign run's claim, heartbeat and lock are left untouched.
 * No-op when `PI_ORCHESTRATION_LOCK=off`. Best-effort: a missing,
 * unreadable or already-removed lock file never throws.
 *
 * @param cwd - Repository working directory.
 * @param id  - Claim id being released.
 */
export function releaseOrchestration(cwd: string, id: string): void {
  if (!claimEnabled()) return;
  // Registry slot: stop the heartbeat and clear the slot only on id match.
  const raw = (globalThis as Record<string, unknown>)[ORCHESTRATION_CLAIM_KEY];
  if (typeof raw === "object" && raw !== null) {
    const stored = raw as Partial<Claim>;
    if (stored.id === id) {
      clearHeartbeat();
      delete (globalThis as Record<string, unknown>)[ORCHESTRATION_CLAIM_KEY];
    }
  }
  // Lock file: delete only when the stored payload carries this id.
  try {
    const file = orchestrationLockFilePath(cwd);
    const lock = JSON.parse(readFileSync(file, "utf8")) as Partial<LockFile>;
    if (lock.id === id) {
      try {
        unlinkSync(file);
      } catch {
        // Best-effort: a failed delete must never block the caller.
      }
    }
  } catch {
    // Missing or unreadable lock file: nothing to delete.
  }
}

/**
 * Read the orchestration claim stored on globalThis, if any.
 *
 * Returns undefined when `PI_ORCHESTRATION_LOCK=off`, when no claim was
 * stored, or when the slot does not carry the `{id, cancel, settle}` shape.
 *
 * @returns The stored claim, or undefined.
 */
export function peekOrchestrationClaim(): Claim | undefined {
  if (!claimEnabled()) return undefined;
  const raw = (globalThis as Record<string, unknown>)[ORCHESTRATION_CLAIM_KEY];
  if (typeof raw !== "object" || raw === null) return undefined;
  const candidate = raw as Partial<Claim>;
  if (
    typeof candidate.id !== "string" ||
    typeof candidate.cancel !== "function" ||
    typeof candidate.settle !== "function"
  ) {
    return undefined;
  }
  return candidate as Claim;
}
