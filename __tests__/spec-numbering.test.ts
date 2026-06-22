import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdir, writeFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";

/**
 * Tests for spec/plan numbering race condition fix.
 *
 * Spec (plan):
 * - nextSpecNumber accepts optional specNumSeed parameter
 * - When specNumSeed is provided, it returns that value without scanning
 * - When specNumSeed is omitted, it scans with a retry loop (up to 3 attempts, 50ms delay)
 * - Same fix applies to nextPlanNumber
 */

let tmpDir: string;

describe("nextSpecNumber", () => {
  before(async () => {
    tmpDir = join(tmpdir(), `spec-num-${randomUUID()}`);
    await mkdir(tmpDir, { recursive: true });
  });

  after(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  it("returns specNumSeed when provided, skipping directory scan", async () => {
    const { nextSpecNumber } = await import("../extensions/spec.ts");

    // No docs/specs dir exists yet — would return 1 without seed
    const result = await nextSpecNumber(1, tmpDir, 42);
    assert.equal(result, 42, "Should return the provided seed directly");
  });

  it("scans directory and returns max+1 when no seed provided", async () => {
    const { nextSpecNumber } = await import("../extensions/spec.ts");

    // Create existing spec files
    const specsDir = join(tmpDir, "docs", "specs");
    await mkdir(specsDir, { recursive: true });
    await writeFile(join(specsDir, "001-first.md"), "---\ntitle: First\n---\n", "utf-8");
    await writeFile(join(specsDir, "003-third.md"), "---\ntitle: Third\n---\n", "utf-8");

    const result = await nextSpecNumber(1, tmpDir);
    assert.equal(result, 4, "Should return max(001, 003) + 1 = 4");
  });

  it("returns 1 when specs dir does not exist and no seed", async () => {
    const { nextSpecNumber } = await import("../extensions/spec.ts");

    // Fresh tmp dir with no docs/specs
    const freshDir = join(tmpdir(), `fresh-spec-${randomUUID()}`);
    const result = await nextSpecNumber(1, freshDir);
    await rm(freshDir, { recursive: true, force: true });
    assert.equal(result, 1, "Should return 1 when no specs dir exists");
  });

  it("pre-computed seed prevents race condition in rapid batch creation", async () => {
    const { nextSpecNumber } = await import("../extensions/spec.ts");

    const batchDir = join(tmpdir(), `batch-race-${randomUUID()}`);
    await mkdir(join(batchDir, "docs", "specs"), { recursive: true });

    // Simulate batch creation: pre-compute seeds
    const seed = await nextSpecNumber(1, batchDir); // scans empty dir → 1
    assert.equal(seed, 1, "Seed should be 1 for empty dir");

    // Now simulate creating 3 specs rapidly, each using pre-computed seed + offset
    const results = await Promise.all([
      nextSpecNumber(1, batchDir, seed + 0), // should return 1
      nextSpecNumber(1, batchDir, seed + 1), // should return 2
      nextSpecNumber(1, batchDir, seed + 2), // should return 3
    ]);

    assert.deepEqual(results, [1, 2, 3],
      "Each call should return its pre-computed seed without file-system race");

    await rm(batchDir, { recursive: true, force: true });
  });

  it("retries scan with delay when directory is empty but exists", async () => {
    const { nextSpecNumber } = await import("../extensions/spec.ts");

    const emptyDir = join(tmpdir(), `empty-retry-${randomUUID()}`);
    // Create the dir but no files
    await mkdir(join(emptyDir, "docs", "specs"), { recursive: true });

    // Should retry and eventually return 1 (empty dir after retries)
    const result = await nextSpecNumber(1, emptyDir);
    assert.equal(result, 1, "Should return 1 after retries on empty dir");

    await rm(emptyDir, { recursive: true, force: true });
  });
});

describe("nextPlanNumber", () => {
  before(async () => {
    tmpDir = join(tmpdir(), `plan-num-${randomUUID()}`);
    await mkdir(tmpDir, { recursive: true });
  });

  after(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  it("returns planNumSeed when provided, skipping directory scan", async () => {
    const { nextPlanNumber } = await import("../extensions/plan.ts");

    const result = await nextPlanNumber("001", tmpDir, 7);
    assert.equal(result, 7, "Should return the provided seed directly");
  });

  it("scans both plans dir and archive dir when no seed provided", async () => {
    const { nextPlanNumber } = await import("../extensions/plan.ts");

    const testDir = join(tmpdir(), `plan-scan-${randomUUID()}`);
    const plansDir = join(testDir, "docs", "plans");
    const archiveDir = join(testDir, "docs", "plans", ".archive");
    await mkdir(archiveDir, { recursive: true });

    await writeFile(join(plansDir, "005-active.md"), "---\ntitle: Active\n---\n", "utf-8");
    await writeFile(join(archiveDir, "011-archived.md"), "---\ntitle: Archived\n---\n", "utf-8");

    const result = await nextPlanNumber("001", testDir);
    await rm(testDir, { recursive: true, force: true });
    assert.equal(result, 12, "Should return max(plans, archive) + 1 = 12");
  });

  it("returns 1 when plans dir does not exist and no seed", async () => {
    const { nextPlanNumber } = await import("../extensions/plan.ts");

    const freshDir = join(tmpdir(), `fresh-plan-${randomUUID()}`);
    const result = await nextPlanNumber("001", freshDir);
    await rm(freshDir, { recursive: true, force: true });
    assert.equal(result, 1, "Should return 1 when no plans dir exists");
  });
});
