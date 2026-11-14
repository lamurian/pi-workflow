import { describe, it, expect, beforeEach, afterEach } from "vitest";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  claimOrchestration,
  peekOrchestrationClaim,
  ORCHESTRATION_CLAIM_KEY,
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
