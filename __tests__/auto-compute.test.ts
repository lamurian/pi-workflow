import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdir, writeFile, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";

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
    `date: 2026-06-19`,
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
    `date: 2026-06-19`,
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
    `date: 2026-06-19`,
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

describe("autoUpdateRemaining", () => {
  before(async () => {
    tmpDir = join(tmpdir(), `auto-compute-${randomUUID()}`);
    await mkdir(tmpDir, { recursive: true });
  });

  after(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  it("updates spec remaining count from active plans", async () => {
    await createAdr(1, "Test ADR");
    const specPath = await createSpec(1, "Test Spec", 1, "proposed", 0);
    await createPlan(1, "Plan One", 1);
    await createPlan(2, "Plan Two", 1);
    await createPlan(3, "Plan Three", 1);

    const { autoUpdateRemaining } = await import("../extensions/workflow-transition.ts");
    await autoUpdateRemaining(tmpDir);

    const content = await readFile(specPath, "utf-8");
    assert.ok(
      content.includes("remaining: 3"),
      `Expected remaining: 3, got:\n${content}`,
    );
  });

  it("skips implemented specs", async () => {
    await createAdr(2, "Skip ADR");
    const specPath = await createSpec(2, "Implemented Spec", 2, "implemented", 999);
    await createPlan(4, "Plan Four", 2);

    const { autoUpdateRemaining } = await import("../extensions/workflow-transition.ts");
    await autoUpdateRemaining(tmpDir);

    const content = await readFile(specPath, "utf-8");
    assert.ok(
      content.includes("remaining: 999"),
      "Implemented spec should not have remaining updated",
    );
  });

  it("updates ADR remaining count from active specs", async () => {
    const adrPath = await createAdr(3, "ADR Three", "proposed", 0);
    await createSpec(3, "Spec Three", 3, "proposed", 0);
    await createPlan(5, "Plan Five", 3);

    const { autoUpdateRemaining } = await import("../extensions/workflow-transition.ts");
    await autoUpdateRemaining(tmpDir);

    const content = await readFile(adrPath, "utf-8");
    assert.ok(
      content.includes("remaining: 1"),
      `Expected remaining: 1 for ADR, got:\n${content}`,
    );
  });

  it("skips implemented ADRs", async () => {
    const adrPath = await createAdr(4, "ADR Four", "implemented", 42);
    await createSpec(4, "Spec Four", 4, "proposed", 0);
    await createPlan(6, "Plan Six", 4);

    const { autoUpdateRemaining } = await import("../extensions/workflow-transition.ts");
    await autoUpdateRemaining(tmpDir);

    const content = await readFile(adrPath, "utf-8");
    assert.ok(
      content.includes("remaining: 42"),
      "Implemented ADR should not have remaining updated",
    );
  });

  it("handles empty directories gracefully", async () => {
    const { autoUpdateRemaining } = await import("../extensions/workflow-transition.ts");
    // Should not throw
    await autoUpdateRemaining(tmpDir);
  });
});
