// Orchestration claim (T5): a process-wide registry slot on globalThis plus
// a lock file in the workflow runtime dir, so a later /implement can detect
// a run orphaned by /reload. PI_ORCHESTRATION_LOCK=off disables the whole
// mechanism (no slot, no lock I/O); every claim call is best-effort and
// never blocks the launch.

import { renameSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { WORKFLOW_RUNTIME_DIR } from "./contract-guard-core.ts";
import { ensureWorkflowRuntimeDir } from "./contract-guard-file.ts";

/** Lock-file heartbeat refresh interval, in milliseconds (one minute). */
export const HEARTBEAT_INTERVAL_MS = 60_000;

/** A lock heartbeat older than this is stale, in milliseconds (three minutes). */
export const STALE_THRESHOLD_MS = 180_000;

/** Key of the orchestration claim slot on globalThis. */
export const ORCHESTRATION_CLAIM_KEY = "__piWorkflowOrchestrationClaim";

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
  (globalThis as Record<string, unknown>)[ORCHESTRATION_CLAIM_KEY] = claim;
  try {
    const dir = ensureWorkflowRuntimeDir(cwd);
    const file = resolve(dir, LOCK_FILE_NAME);
    const now = Date.now();
    const lock: LockFile = {
      id: claim.id,
      pid: process.pid,
      startedAt: now,
      heartbeatAt: now,
    };
    const tmp = `${file}.${process.pid}.tmp`;
    writeFileSync(tmp, JSON.stringify(lock, null, 2));
    renameSync(tmp, file);
  } catch {
    // Best-effort: a lock write failure must never block the claim.
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
