import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  claimOrchestration,
  releaseOrchestration,
  peekOrchestrationClaim,
  ORCHESTRATION_CLAIM_KEY,
  HEARTBEAT_INTERVAL_MS,
} from "../extensions/orchestration-lock.ts";
import type { Claim } from "../extensions/orchestration-lock.ts";

/** Temp project roots removed after each test (lock files live inside them). */
const tmpDirs: string[] = [];

/** Prior PI_ORCHESTRATION_LOCK value, restored after each test. */
let prevLockEnv: string | undefined;

/** Fresh temp project root, removed after the test. */
function tmpCwd(): string {
  const dir = mkdtempSync(join(tmpdir(), "pi-orch-lock-"));
  tmpDirs.push(dir);
  return dir;
}

/** A claim with the {id, cancel, settle} shape. */
function claim(id: string): Claim {
  return { id, cancel: () => {}, settle: async () => {} };
}

beforeEach(() => {
  prevLockEnv = process.env.PI_ORCHESTRATION_LOCK;
  // Pin the mechanism on for these tests (the suite default may be off).
  process.env.PI_ORCHESTRATION_LOCK = "on";
});

afterEach(() => {
  if (prevLockEnv === undefined) delete process.env.PI_ORCHESTRATION_LOCK;
  else process.env.PI_ORCHESTRATION_LOCK = prevLockEnv;
  delete (globalThis as Record<string, unknown>)[ORCHESTRATION_CLAIM_KEY];
  while (tmpDirs.length) rmSync(tmpDirs.pop()!, { recursive: true, force: true });
});

describe("orchestration lock (T5.1)", () => {
  it("claimOrchestration stores the claim {id, cancel, settle} on globalThis and writes the lock file containing id, pid, startedAt and heartbeatAt", () => {
    const cwd = tmpCwd();
    const c = claim("claim-abc");
    claimOrchestration(cwd, c);

    // Registry slot: the exact claim object under the globalThis key.
    expect(peekOrchestrationClaim()).toBe(c);
    const stored = (globalThis as Record<string, unknown>)[ORCHESTRATION_CLAIM_KEY];
    assert.deepEqual(Object.keys(stored as object).sort(), ["cancel", "id", "settle"]);

    // Lock file: id, pid, startedAt, heartbeatAt.
    const file = join(cwd, ".pi/workflow/orchestration-lock.json");
    assert.ok(existsSync(file), `lock file missing at ${file}`);
    const lock = JSON.parse(readFileSync(file, "utf8")) as Record<string, unknown>;
    expect(lock.id).toBe("claim-abc");
    expect(lock.pid).toBe(process.pid);
    expect(typeof lock.startedAt).toBe("number");
    expect(typeof lock.heartbeatAt).toBe("number");
    expect(lock.heartbeatAt as number).toBeGreaterThanOrEqual(lock.startedAt as number);
  });

  it("peekOrchestrationClaim returns undefined when no claim is stored", () => {
    expect(peekOrchestrationClaim()).toBeUndefined();
  });

  it("PI_ORCHESTRATION_LOCK=off stores no claim and writes no lock file", () => {
    process.env.PI_ORCHESTRATION_LOCK = "off";
    const cwd = tmpCwd();
    claimOrchestration(cwd, claim("claim-off"));
    expect((globalThis as Record<string, unknown>)[ORCHESTRATION_CLAIM_KEY]).toBeUndefined();
    expect(peekOrchestrationClaim()).toBeUndefined();
    assert.ok(!existsSync(join(cwd, ".pi/workflow/orchestration-lock.json")));
  });
});

describe("orchestration lock heartbeat (T5.2)", () => {
  it("while claimed, an unref'd 60-second timer refreshes heartbeatAt in the lock file", () => {
    vi.useFakeTimers();
    try {
      const cwd = tmpCwd();
      // Capture the interval handle the claim starts, to observe the unref'd timer.
      const originalSetInterval = globalThis.setInterval;
      let captured: { unref?: () => void; hasRef?: () => boolean } | undefined;
      globalThis.setInterval = ((...args: unknown[]) => {
        const handle = (
          originalSetInterval as (...a: unknown[]) => unknown
        )(...args);
        captured = handle as typeof captured;
        return handle;
      }) as unknown as typeof setInterval;
      try {
        claimOrchestration(cwd, claim("claim-hb"));
      } finally {
        globalThis.setInterval = originalSetInterval;
      }

      const file = join(cwd, ".pi/workflow/orchestration-lock.json");
      const readLock = () => JSON.parse(readFileSync(file, "utf8")) as Record<string, number>;
      const initial = readLock();

      // The heartbeat timer is unref'd: it never keeps the process alive.
      assert.ok(captured, "claimOrchestration must start the heartbeat interval");
      assert.equal(typeof captured.hasRef, "function", "fake timer handle exposes hasRef");
      assert.equal(captured.hasRef!(), false, "heartbeat timer is unref'd");

      // No refresh before the 60-second mark, then heartbeatAt advances.
      vi.advanceTimersByTime(HEARTBEAT_INTERVAL_MS - 1);
      assert.equal(readLock().heartbeatAt, initial.heartbeatAt, "no refresh before 60s");
      vi.advanceTimersByTime(1);
      const refreshed = readLock();
      assert.ok(
        refreshed.heartbeatAt >= initial.heartbeatAt + HEARTBEAT_INTERVAL_MS,
        `heartbeatAt refreshed after 60s (was ${initial.heartbeatAt}, now ${refreshed.heartbeatAt})`,
      );
      // Same claim: only heartbeatAt moves.
      assert.equal(refreshed.id, "claim-hb", "lock still carries the claim id");
      assert.equal(refreshed.pid, process.pid, "lock still carries this pid");
      assert.equal(refreshed.startedAt, initial.startedAt, "startedAt is preserved");
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("orchestration release (T5.3)", () => {
  it("matching-id release stops the heartbeat, deletes the lock and clears the globalThis claim", () => {
    vi.useFakeTimers();
    try {
      const cwd = tmpCwd();
      claimOrchestration(cwd, claim("claim-rel"));
      const file = join(cwd, ".pi/workflow/orchestration-lock.json");
      assert.ok(existsSync(file), "lock file written by the claim");
      // The claim started exactly one heartbeat timer.
      expect(vi.getTimerCount()).toBe(1);

      releaseOrchestration(cwd, "claim-rel");

      // Heartbeat stopped.
      expect(vi.getTimerCount()).toBe(0);
      // Lock deleted.
      assert.ok(!existsSync(file), "lock deleted on matching id");
      // Claim cleared from the registry slot.
      expect(peekOrchestrationClaim()).toBeUndefined();
      expect(
        (globalThis as Record<string, unknown>)[ORCHESTRATION_CLAIM_KEY],
      ).toBeUndefined();
      // Nothing reschedules: advancing a full interval stays clean.
      vi.advanceTimersByTime(HEARTBEAT_INTERVAL_MS * 2);
      expect(vi.getTimerCount()).toBe(0);
      assert.ok(!existsSync(file), "no lock recreated after release");
    } finally {
      vi.useRealTimers();
    }
  });

  it("foreign-id release leaves the lock and claim untouched", () => {
    const cwd = tmpCwd();
    const owner = claim("claim-owner");
    claimOrchestration(cwd, owner);
    const file = join(cwd, ".pi/workflow/orchestration-lock.json");
    assert.ok(existsSync(file), "lock file written by the claim");

    releaseOrchestration(cwd, "someone-else");

    // Claim left in place: still the exact stored object.
    expect(peekOrchestrationClaim()).toBe(owner);
    // Lock left in place, still carrying the owner's id.
    assert.ok(existsSync(file), "foreign lock left in place");
    const lock = JSON.parse(readFileSync(file, "utf8")) as Record<string, unknown>;
    expect(lock.id).toBe("claim-owner");
    expect(lock.pid).toBe(process.pid);
  });
});
