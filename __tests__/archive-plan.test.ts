import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdir, writeFile, readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";

/**
 * TDD tests for archivePlan atomic rename.
 */

describe("archivePlan", () => {
  let tmpDir: string;
  let planPath: string;
  let plansDir: string;

  before(async () => {
    tmpDir = join(tmpdir(), `archive-plan-${randomUUID()}`);
    plansDir = join(tmpDir, "docs", "plans");
    await mkdir(plansDir, { recursive: true });

    // Create a test plan file
    planPath = join(plansDir, "001-test-plan.md");
    await writeFile(planPath, "---\ntitle: Test Plan\n---\n\n# Overview\n\nTest content.\n", "utf-8");
  });

  after(async () => {
    const { rm } = await import("node:fs/promises");
    await rm(tmpDir, { recursive: true, force: true });
  });

  it("moves a plan file to the archive directory", async () => {
    const { archivePlan } = await import("../extensions/plan.ts");

    const archivedPath = await archivePlan(planPath, tmpDir);

    // Original file should no longer exist
    assert.equal(existsSync(planPath), false, "Original plan file should be removed");

    // Archived file should exist under .archive/
    assert.ok(archivedPath.includes(".archive"), "Archived path should be inside .archive/");
    assert.equal(existsSync(archivedPath), true, "Archived file should exist");

    // Content should be preserved
    const content = await readFile(archivedPath, "utf-8");
    assert.ok(content.includes("title: Test Plan"), "Archived content should match original");
    assert.ok(content.includes("Test content"), "Archived content should match original body");
  });

  it("creates archive directory if it does not exist", async () => {
    const freshDir = join(tmpdir(), `archive-fresh-${randomUUID()}`);
    const freshPlansDir = join(freshDir, "docs", "plans");
    await mkdir(freshPlansDir, { recursive: true });

    const freshPlanPath = join(freshPlansDir, "002-fresh-plan.md");
    await writeFile(freshPlanPath, "---\ntitle: Fresh Plan\n---\n\nFresh content.\n", "utf-8");

    const { archivePlan } = await import("../extensions/plan.ts");
    const archivedPath = await archivePlan(freshPlanPath, freshDir);

    // Archive dir should have been created
    assert.equal(existsSync(archivedPath), true, "Archived file should exist in newly created archive dir");
    assert.ok(archivedPath.includes(".archive"), "Should be inside .archive/");

    // Clean up
    const { rm } = await import("node:fs/promises");
    await rm(freshDir, { recursive: true, force: true });
  });

  it("returns the path to the archived file", async () => {
    // Create another plan for this test
    const anotherPath = join(plansDir, "003-return-path.md");
    await writeFile(anotherPath, "---\ntitle: Path Test\n---\n\nReturn path content.\n", "utf-8");

    const { archivePlan } = await import("../extensions/plan.ts");
    const archivedPath = await archivePlan(anotherPath, tmpDir);

    // Should return absolute path
    assert.ok(archivedPath.startsWith("/"), "Returned path should be absolute");
    assert.equal(existsSync(archivedPath), true, "Returned path should point to existing file");
    assert.equal(existsSync(anotherPath), false, "Original should be gone");
  });
});
