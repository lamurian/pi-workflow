import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdir, writeFile, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";

/**
 * TDD tests for plan cascade logic (onPlanImplemented).
 */

let tmpDir: string;

/** Helper: create an ADR file. */
async function createAdr(
  number: number,
  title: string,
  status = "proposed",
  remaining = 0,
): Promise<string> {
  const dir = join(tmpDir, "docs", "ADR");
  await mkdir(dir, { recursive: true });
  const slug = title.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
  const filePath = join(dir, `${String(number).padStart(3, "0")}-${slug}.md`);
  const content = [
    "---",
    `title: ${title}`,
    `description: ${title}`,
    `status: ${status}`,
    `remaining: ${remaining}`,
    `date: 2026-06-18`,
    "---",
    "",
    "# Context", "", "Test context.",
    "# Decision", "", "Test decision.",
    "# Impact", "", "Test impact.",
  ].join("\n");
  await writeFile(filePath, content, "utf-8");
  return filePath;
}

/** Helper: create a spec file referencing an ADR. */
async function createSpec(
  number: number,
  title: string,
  adrNumber: number,
  status = "proposed",
  remaining = 0,
): Promise<string> {
  const dir = join(tmpDir, "docs", "specs");
  await mkdir(dir, { recursive: true });
  const slug = title.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
  const filePath = join(dir, `${String(number).padStart(3, "0")}-${slug}.md`);
  const content = [
    "---",
    `title: ${title}`,
    `description: ${title}`,
    `status: ${status}`,
    `remaining: ${remaining}`,
    `date: 2026-06-18`,
    "---",
    "",
    "# Requirements Specification", "", "- Requirement 1",
    "# Design Principles", "", "- Principle 1",
    "# References",
    "",
    `This spec implements @docs/ADR/${String(adrNumber).padStart(3, "0")}-*.md`,
  ].join("\n");
  await writeFile(filePath, content, "utf-8");
  return filePath;
}

/** Helper: create a plan file referencing a spec. */
async function createPlan(
  number: number,
  title: string,
  specNumber: number,
): Promise<string> {
  const dir = join(tmpDir, "docs", "plans");
  await mkdir(dir, { recursive: true });
  const slug = title.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
  const filePath = join(dir, `${String(number).padStart(3, "0")}-${slug}.md`);
  const content = [
    "---",
    `title: ${title}`,
    `description: ${title}`,
    "status: proposed",
    `date: 2026-06-18`,
    "---",
    "",
    "# Overview", "", "Test overview.",
    "# Goals", "", "- Goal 1",
    "# Implementation Steps", "", "- [ ] Task 1",
    "# Risks",
    "| Risk | Likelihood | Impact | Mitigation |",
    "|------|-----------|--------|------------|",
    "| Risk 1 | Low | Medium | Mitigation 1 |",
    "# UAT", "", "1. Test step 1",
    "# References",
    "",
    `This plan implements @docs/specs/${String(specNumber).padStart(3, "0")}-*.md`,
  ].join("\n");
  await writeFile(filePath, content, "utf-8");
  return filePath;
}

describe("Plan reference extraction and numbering", () => {
  before(async () => {
    tmpDir = join(tmpdir(), `cascade-ref-${randomUUID()}`);
    await mkdir(tmpDir, { recursive: true });
  });

  after(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  it("nextPlanNumber scans both plans dir and archive dir", async () => {
    const { nextPlanNumber } = await import("../extensions/plan.ts");
    const testDir = join(tmpdir(), `nextplan-${randomUUID()}`);
    const plansDir = join(testDir, "docs", "plans");
    const archiveDir = join(testDir, "docs", "plans", ".archive");
    await mkdir(archiveDir, { recursive: true });

    // Plan 005 exists in main dir
    await writeFile(join(plansDir, "005-active-plan.md"), "---\ntitle: Active\n---\n", "utf-8");
    // Plan 011 exists in archive
    await writeFile(join(archiveDir, "011-archived-plan.md"), "---\ntitle: Archived\n---\n", "utf-8");

    const next = await nextPlanNumber("001", testDir);
    await rm(testDir, { recursive: true, force: true });
    assert.equal(next, 12, "nextPlanNumber should return max(plans, archive) + 1");
  });

  it("nextPlanNumber returns 1 when both dirs are empty", async () => {
    const { nextPlanNumber } = await import("../extensions/plan.ts");
    const testDir = join(tmpdir(), `nextplan-empty-${randomUUID()}`);
    await mkdir(join(testDir, "docs", "plans", ".archive"), { recursive: true });
    const next = await nextPlanNumber("001", testDir);
    await rm(testDir, { recursive: true, force: true });
    assert.equal(next, 1, "Empty dirs should return 1");
  });

  it("extractSpecRefFromPlan extracts spec number from plan file", async () => {
    const planPath = await createPlan(1, "Test Plan", 2);

    const { extractSpecRefFromPlan } = await import("../extensions/plan.ts");
    const specNum = await extractSpecRefFromPlan(planPath);

    assert.equal(specNum, "002");
  });

  it("extractAdrRefFromSpec extracts ADR number from spec file", async () => {
    const specPath = await createSpec(1, "Test Spec", 3);

    const { extractAdrRefFromSpec } = await import("../extensions/spec.ts");
    const adrNum = await extractAdrRefFromSpec(specPath);

    assert.equal(adrNum, 3);
  });
});

describe("Plan cascade logic", () => {
  before(async () => {
    tmpDir = join(tmpdir(), `cascade-logic-${randomUUID()}`);
    await mkdir(tmpDir, { recursive: true });
  });

  after(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  it("decrements spec remaining and handles multi-plan cascade", async () => {
    await createAdr(1, "Main Arch");
    const specPath = await createSpec(1, "Main Spec", 1, "progressed", 3);
    const planPath1 = await createPlan(1, "Plan One", 1);
    await createPlan(2, "Plan Two", 1);
    await createPlan(3, "Plan Three", 1);

    const { onPlanImplemented } = await import("../extensions/plan.ts");
    await onPlanImplemented(planPath1, tmpDir);

    let specContent = await readFile(specPath, "utf-8");
    assert.ok(specContent.includes("remaining: 2"));
    assert.ok(specContent.includes("status: progressed"));

    // Implement remaining plans
    const planPath2 = await createPlan(2, "Plan Two", 1);
    await onPlanImplemented(planPath2, tmpDir);
    specContent = await readFile(specPath, "utf-8");
    assert.ok(specContent.includes("remaining: 1"));

    const planPath3 = await createPlan(3, "Plan Three", 1);
    await onPlanImplemented(planPath3, tmpDir);
    specContent = await readFile(specPath, "utf-8");
    assert.ok(specContent.includes("remaining: 0"));
    assert.ok(specContent.includes("status: implemented"));
  });

  it("cascades to ADR when spec is fully implemented", async () => {
    const adrPath = await createAdr(4, "Cascade Arch", "progressed", 1);
    const specPath = await createSpec(4, "Cascade Spec", 4, "progressed", 1);
    const planPath = await createPlan(4, "Cascade Plan", 4);

    const { onPlanImplemented } = await import("../extensions/plan.ts");
    await onPlanImplemented(planPath, tmpDir);

    const specContent = await readFile(specPath, "utf-8");
    assert.ok(specContent.includes("remaining: 0"));
    assert.ok(specContent.includes("status: implemented"));

    const adrContent = await readFile(adrPath, "utf-8");
    assert.ok(adrContent.includes("remaining: 0"));
    assert.ok(adrContent.includes("status: implemented"));
  });

  it("does not cascade when spec still has remaining plans", async () => {
    const adrPath = await createAdr(5, "Partial Arch", "proposed", 1);
    const specPath = await createSpec(5, "Partial Spec", 5, "progressed", 2);
    const planPath5 = await createPlan(5, "Partial Plan 1", 5);
    await createPlan(6, "Partial Plan 2", 5);

    const { onPlanImplemented } = await import("../extensions/plan.ts");
    await onPlanImplemented(planPath5, tmpDir);

    const specContent = await readFile(specPath, "utf-8");
    assert.ok(specContent.includes("remaining: 1"));

    const adrContent = await readFile(adrPath, "utf-8");
    assert.ok(adrContent.includes("remaining: 1"));
    assert.ok(adrContent.includes("status: proposed"));
  });
});
