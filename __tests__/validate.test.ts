import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdir, writeFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";

/**
 * Tests for the ADR → Spec → Plan chain validation.
 */

let tmpDir: string;

/** Helper: create an ADR file. */
async function writeAdr(
  num: number,
  title: string,
  status = "proposed",
): Promise<void> {
  const dir = join(tmpDir, "docs", "ADR");
  await mkdir(dir, { recursive: true });
  const slug = title.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
  const content = [
    "---",
    `title: ${title}`,
    `status: ${status}`,
    "---",
  ].join("\n");
  await writeFile(join(dir, `${String(num).padStart(3, "0")}-${slug}.md`), content, "utf-8");
}

/** Helper: create a spec file referencing an ADR. */
async function writeSpec(
  num: number,
  title: string,
  adrNum: number,
): Promise<void> {
  const dir = join(tmpDir, "docs", "specs");
  await mkdir(dir, { recursive: true });
  const slug = title.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
  const content = [
    "---",
    `title: ${title}`,
    "---",
    "",
    `This spec implements @docs/ADR/${String(adrNum).padStart(3, "0")}-*.md`,
  ].join("\n");
  await writeFile(join(dir, `${String(num).padStart(3, "0")}-${slug}.md`), content, "utf-8");
}

/** Helper: create a plan file referencing a spec. */
async function writePlan(
  num: number,
  title: string,
  specNum: number,
): Promise<void> {
  const dir = join(tmpDir, "docs", "plans");
  await mkdir(dir, { recursive: true });
  const slug = title.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
  const content = [
    "---",
    `title: ${title}`,
    "---",
    "",
    `This plan implements @docs/specs/${String(specNum).padStart(3, "0")}-*.md`,
  ].join("\n");
  await writeFile(join(dir, `${String(num).padStart(3, "0")}-${slug}.md`), content, "utf-8");
}

describe("validateMappings", () => {
  before(() => {
    tmpDir = join(tmpdir(), `validate-${randomUUID()}`);
  });

  after(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  it("reports no issues for a complete chain (ADR→Spec→Plan)", async () => {
    await writeAdr(1, "Database Choice");
    await writeSpec(1, "DB Schema", 1);
    await writePlan(1, "Create Schema", 1);

    const { validateMappings } = await import("../extensions/validate.ts");
    const report = await validateMappings(tmpDir);

    assert.equal(report.errors.length, 0, "Complete chain should have no errors");
    assert.equal(report.warnings.length, 0, "Complete chain should have no warnings");
  });

  it("reports orphan specs that reference a missing ADR number", async () => {
    await writeSpec(2, "Orphan Spec", 99);

    const { validateMappings } = await import("../extensions/validate.ts");
    const report = await validateMappings(tmpDir);

    const orphanErrors = report.errors.filter(
      (e: string) => e.includes("orphan") || (e.includes("spec") && e.includes("99")),
    );
    assert.ok(orphanErrors.length >= 1, `Should report orphan spec, got: ${JSON.stringify(report.errors)}`);
  });

  it("reports orphan plans that reference a missing spec number", async () => {
    await writePlan(3, "Orphan Plan", 99);

    const { validateMappings } = await import("../extensions/validate.ts");
    const report = await validateMappings(tmpDir);

    const orphanErrors = report.errors.filter(
      (e: string) => e.includes("orphan") || (e.includes("plan") && e.includes("99")),
    );
    assert.ok(orphanErrors.length >= 1, `Should report orphan plan, got: ${JSON.stringify(report.errors)}`);
  });

  it("reports ADRs with zero specs as needing specs", async () => {
    await writeAdr(4, "Specless ADR");

    const { validateMappings } = await import("../extensions/validate.ts");
    const report = await validateMappings(tmpDir);

    const zeroSpecWarnings = report.warnings.filter(
      (w: string) => w.includes("ADR 004") || w.includes("no specs"),
    );
    assert.ok(
      zeroSpecWarnings.length >= 1,
      `Should warn about ADR with no specs, got warnings: ${JSON.stringify(report.warnings)}`,
    );
  });

  it("reports specs with zero plans as needing plans", async () => {
    await writeAdr(5, "Planned ADR");
    await writeSpec(5, "Planless Spec", 5);

    const { validateMappings } = await import("../extensions/validate.ts");
    const report = await validateMappings(tmpDir);

    const zeroPlanWarnings = report.warnings.filter(
      (w: string) => w.includes("005") || w.includes("no plan"),
    );
    assert.ok(
      zeroPlanWarnings.length >= 1,
      `Should warn about spec with no plans, got warnings: ${JSON.stringify(report.warnings)}`,
    );
  });
});
