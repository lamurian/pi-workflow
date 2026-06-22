import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdir, writeFile, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";

/**
 * TDD tests for ADR/Spec implementation tracking (remaining field).
 */

let tmpDir: string;

/** Helper: create an ADR file with the new template format. */
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

describe("ADR remaining tracking", () => {
  before(async () => {
    tmpDir = join(tmpdir(), `tracking-adr-${randomUUID()}`);
    await mkdir(tmpDir, { recursive: true });
  });

  after(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  it("counts specs and updates ADR frontmatter", async () => {
    const adrPath = await createAdr(1, "Test Architecture");
    await createSpec(1, "Auth Spec", 1);
    await createSpec(2, "API Spec", 1);

    const { computeAndUpdateAdrRemaining } = await import("../extensions/adr.ts");
    const result = await computeAndUpdateAdrRemaining(1, tmpDir);

    assert.equal(result.remaining, 2);
    assert.equal(result.status, "proposed");

    const content = await readFile(adrPath, "utf-8");
    assert.ok(content.includes("remaining: 2"));
    assert.ok(content.includes("status: proposed"));
  });

  it("returns 0 when no specs reference the ADR", async () => {
    const adrPath = await createAdr(2, "Orphan ADR");

    const { computeAndUpdateAdrRemaining } = await import("../extensions/adr.ts");
    const result = await computeAndUpdateAdrRemaining(2, tmpDir);

    assert.equal(result.remaining, 0);

    const content = await readFile(adrPath, "utf-8");
    assert.ok(content.includes("remaining: 0"));
  });

  it("excludes archived specs", async () => {
    const adrPath = await createAdr(3, "Archived Specs ADR");
    await createSpec(3, "Active Spec", 3);
    await createSpec(4, "Another Active", 3);

    const archiveDir = join(tmpDir, "docs", "specs", ".archive");
    await mkdir(archiveDir, { recursive: true });
    const archived = [
      "---", "title: Archived", "description: Archived",
      "status: proposed", "remaining: 0", "date: 2026-06-18", "---",
      "", "# References", "",
      "This spec implements @docs/ADR/003-*.md",
    ].join("\n");
    await writeFile(join(archiveDir, "005-archived.md"), archived, "utf-8");

    const { computeAndUpdateAdrRemaining } = await import("../extensions/adr.ts");
    const result = await computeAndUpdateAdrRemaining(3, tmpDir);

    assert.equal(result.remaining, 2);
  });
});

describe("Spec remaining tracking", () => {
  before(async () => {
    tmpDir = join(tmpdir(), `tracking-spec-${randomUUID()}`);
    await mkdir(tmpDir, { recursive: true });
  });

  after(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  it("counts plans and updates spec frontmatter", async () => {
    const specPath = await createSpec(1, "Auth Spec", 1);
    await createPlan(1, "Plan One", 1);
    await createPlan(2, "Plan Two", 1);
    await createPlan(3, "Plan Three", 1);

    const { computeAndUpdateSpecRemaining } = await import("../extensions/spec.ts");
    const result = await computeAndUpdateSpecRemaining("001", tmpDir);

    assert.equal(result.remaining, 3);
    assert.equal(result.status, "proposed");

    const content = await readFile(specPath, "utf-8");
    assert.ok(content.includes("remaining: 3"));
    assert.ok(content.includes("status: proposed"));
  });

  it("returns 0 when no plans reference the spec", async () => {
    const specPath = await createSpec(2, "Orphan Spec", 1);

    const { computeAndUpdateSpecRemaining } = await import("../extensions/spec.ts");
    const result = await computeAndUpdateSpecRemaining("002", tmpDir);

    assert.equal(result.remaining, 0);

    const content = await readFile(specPath, "utf-8");
    assert.ok(content.includes("remaining: 0"));
  });

  it("excludes archived plans", async () => {
    const specPath = await createSpec(3, "Active Spec", 2);
    await createPlan(4, "Plan One", 3);
    await createPlan(5, "Plan Two", 3);

    const archiveDir = join(tmpDir, "docs", "plans", ".archive");
    await mkdir(archiveDir, { recursive: true });
    const archived = [
      "---", "title: Archived Plan", "description: Archived",
      "status: proposed", "date: 2026-06-18", "---",
      "", "# References", "",
      "This plan implements @docs/specs/003-*.md",
    ].join("\n");
    await writeFile(join(archiveDir, "006-archived.md"), archived, "utf-8");

    const { computeAndUpdateSpecRemaining } = await import("../extensions/spec.ts");
    const result = await computeAndUpdateSpecRemaining("003", tmpDir);

    assert.equal(result.remaining, 2);
  });
});
