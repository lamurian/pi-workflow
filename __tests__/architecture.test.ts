import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdir, writeFile, rm, readFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";

/**
 * Test for ARCHITECTURE.md management.
 *
 * Spec (discussion):
 * - ARCHITECTURE.md should not have extra blank lines before ADR entries
 *   after addAdrToArchitecture adds the first entry.
 * - The {{adrEntries}} placeholder is removed by ensureArchitectureMd at init time,
 *   but the blank lines from the template placeholder should be cleaned up
 *   when the first ADR entry is inserted.
 * - Subsequent entries should be inserted without creating consecutive blank lines.
 */

let tmpDir: string;

function t(...parts: string[]): string {
  return join(tmpDir, ...parts);
}

/**
 * Extract lines of the Implementation Status section from file content.
 * Returns lines from the heading to the next heading (exclusive).
 */
function extractStatusLines(content: string): { headingIdx: number; lines: string[] } {
  const allLines = content.split("\n");
  const headingIdx = allLines.findIndex((l) => l.startsWith("# Implementation Status"));
  assert.ok(headingIdx >= 0, "Should find Implementation Status heading");

  // Find the next heading
  let nextHeadingIdx = headingIdx + 1;
  while (nextHeadingIdx < allLines.length && !allLines[nextHeadingIdx].startsWith("# ")) {
    nextHeadingIdx++;
  }

  return {
    headingIdx,
    lines: allLines.slice(headingIdx, nextHeadingIdx),
  };
}

describe("ARCHITECTURE.md — addAdrToArchitecture formatting", () => {
  before(async () => {
    tmpDir = join(tmpdir(), `arch-test-${randomUUID()}`);
    await mkdir(tmpDir, { recursive: true });
  });

  after(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  it("removes extra blank lines when inserting the first ADR entry", async () => {
    // Write the template as ensureArchitectureMd would produce it
    // ({{adrEntries}} rendered to empty string leaves blank lines)
    await writeFile(
      t("ARCHITECTURE.md"),
      `---
title: Test
date: 2026-06-17
---

# Overview

High-level description.

# Implementation Status



# Data Flow

Data flow description.
`,
      "utf-8",
    );

    const { addAdrToArchitecture } = await import("../extensions/architecture.ts");

    await addAdrToArchitecture(
      tmpDir,
      "docs/ADR/001-environment-configuration.md",
      "Environment Configuration",
      "drafted",
    );

    const content = await readFile(t("ARCHITECTURE.md"), "utf-8");
    const { headingIdx, lines } = extractStatusLines(content);

    // Verify: heading → blank → entry → blank (then next heading follows)
    // In the sliced section, heading is at index 0
    assert.equal(
      lines[1].trim(),
      "",
      "Line after heading should be blank",
    );
    assert.ok(
      lines[2].includes("@docs/ADR/001"),
      `Line after blank should be ADR entry, got: ${JSON.stringify(lines[2])}`,
    );
    assert.equal(
      lines[3].trim(),
      "",
      "Line after entry should be blank",
    );

    // Ensure no more than one consecutive blank line
    for (let i = 1; i < lines.length - 1; i++) {
      if (lines[i].trim() === "" && lines[i + 1].trim() === "") {
        assert.fail(
          `Found consecutive blank lines at section offset ${i}: ` +
            `lines[${i}]=${JSON.stringify(lines[i])}, lines[${i + 1}]=${JSON.stringify(lines[i + 1])}`,
        );
      }
    }
  });

  it("adds second entry without creating consecutive blank lines", async () => {
    const { addAdrToArchitecture } = await import("../extensions/architecture.ts");

    await addAdrToArchitecture(
      tmpDir,
      "docs/ADR/002-postgresql.md",
      "Use PostgreSQL for persistence",
      "drafted",
    );

    const content = await readFile(t("ARCHITECTURE.md"), "utf-8");
    const { lines } = extractStatusLines(content);

    // Should have both entries
    const entryLines = lines.filter((l) => l.includes("@docs/ADR/"));
    assert.equal(entryLines.length, 2, "Should have 2 ADR entries");
    assert.ok(entryLines[0].includes("001-"), "First entry should be 001");
    assert.ok(entryLines[1].includes("002-"), "Second entry should be 002");

    // Verify spacing: heading → blank → entry → blank → entry → blank
    const contentLines = lines.slice(1); // skip heading
    assert.equal(contentLines[0].trim(), "", "Blank after heading");
    assert.ok(contentLines[1].includes("@docs/ADR/001"), "First ADR entry");
    assert.equal(contentLines[2].trim(), "", "Blank between entries");
    assert.ok(contentLines[3].includes("@docs/ADR/002"), "Second ADR entry");
    assert.equal(contentLines[4].trim(), "", "Blank after last entry");

    // No consecutive blank lines
    for (let i = 1; i < lines.length - 1; i++) {
      if (lines[i].trim() === "" && lines[i + 1].trim() === "") {
        assert.fail(
          `Found consecutive blank lines at section offset ${i}: ` +
            `lines[${i}]=${JSON.stringify(lines[i])}, lines[${i + 1}]=${JSON.stringify(lines[i + 1])}`,
        );
      }
    }
  });
});
