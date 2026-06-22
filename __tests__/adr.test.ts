import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdir, writeFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import {
  detectAdrDir,
  detectArchitectureMd,
  findExistingAdrDirs,
} from "../extensions/adr-detect.ts";
import { listAdrs } from "../extensions/adr.ts";

/**
 * TDD tests for multi-location ADR support.
 *
 * Spec (ADR-1):
 * - Support multiple default locations: docs/ADR, docs/adr, ADR/
 * - Support ARCHITECTURE.md at docs/agents/ARCHITECTURE.md or root
 * - Once detected, list dir and keep in context
 * - When creating new ADR, read previous to evaluate for overlap
 */

let tmpDir: string;

function t(...parts: string[]): string {
  return join(tmpDir, ...parts);
}

describe("ADR multi-location detection", () => {
  before(async () => {
    tmpDir = join(tmpdir(), `adr-test-${randomUUID()}`);
    await mkdir(tmpDir, { recursive: true });
  });

  after(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  // ── findExistingAdrDirs ─────────────────────────────────

  it("returns empty array when no ADR dirs exist", async () => {
    const dirs = await findExistingAdrDirs(tmpDir);
    assert.deepEqual(dirs, []);
  });

  it("detects docs/adr/", async () => {
    const dir = t("docs", "adr");
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, "0001-test.md"), "# ADR-1: test\n", "utf-8");

    const dirs = await findExistingAdrDirs(tmpDir);
    assert.ok(dirs.length >= 1);
    assert.ok(dirs.some((d) => d.endsWith("docs/adr")));
  });

  it("detects docs/ADR/ (case variant)", async () => {
    // Add docs/ADR after docs/adr — both should appear
    const dir = t("docs", "ADR");
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, "0002-other.md"), "# ADR-2: other\n", "utf-8");

    const dirs = await findExistingAdrDirs(tmpDir);
    assert.ok(dirs.some((d) => d.endsWith("docs/ADR")));
  });

  it("detects ADR/ (root level)", async () => {
    const dir = t("ADR");
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, "0003-root.md"), "# ADR-3: root\n", "utf-8");

    const dirs = await findExistingAdrDirs(tmpDir);
    assert.ok(dirs.some((d) => d.endsWith("ADR")));
  });

  // ── detectAdrDir ───────────────────────────────────────

  it("returns first existing dir (priority: docs/ADR > docs/adr > ADR)", async () => {
    // All three exist; detectAdrDir should return the preferred one
    const dir = await detectAdrDir(tmpDir);
    assert.ok(dir);
    assert.ok(dir.endsWith("docs/ADR"));
  });

  it("returns docs/ADR as default when no dir exists", async () => {
    const cleanDir = join(tmpdir(), `adr-clean-${randomUUID()}`);
    await mkdir(cleanDir, { recursive: true });
    try {
      const dir = await detectAdrDir(cleanDir);
      assert.ok(dir);
      assert.ok(dir.endsWith("docs/ADR"), `Expected docs/ADR, got ${dir}`);
    } finally {
      await rm(cleanDir, { recursive: true, force: true });
    }
  });

  it("returns docs/ADR if docs/adr does not exist", async () => {
    const dir = join(tmpdir(), `adr-cap-${randomUUID()}`);
    await mkdir(dir, { recursive: true });
    try {
      await mkdir(join(dir, "docs", "ADR"), { recursive: true });
      await writeFile(join(dir, "docs", "ADR", "0001-cap.md"), "# ADR\n", "utf-8");

      const result = await detectAdrDir(dir);
      assert.ok(result);
      assert.ok(result.endsWith("docs/ADR"));
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  // ── detectArchitectureMd ───────────────────────────────

  it("detects ARCHITECTURE.md at root", async () => {
    await writeFile(t("ARCHITECTURE.md"), "# Architecture\n", "utf-8");

    const path = await detectArchitectureMd(tmpDir);
    assert.equal(path, t("ARCHITECTURE.md"));
  });

  it("detects docs/agents/ARCHITECTURE.md", async () => {
    // Remove root ARCHITECTURE.md first
    await rm(t("ARCHITECTURE.md"));
    const dir = t("docs", "agents");
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, "ARCHITECTURE.md"), "# Architecture\n", "utf-8");

    const path = await detectArchitectureMd(tmpDir);
    assert.equal(path, t("docs", "agents", "ARCHITECTURE.md"));
  });

  it("returns null when no ARCHITECTURE.md exists", async () => {
    // Remove the one just created
    await rm(t("docs", "agents", "ARCHITECTURE.md"));

    const path = await detectArchitectureMd(tmpDir);
    assert.equal(path, null);
  });

  // ── listAdrs ───────────────────────────────────────────

  it("lists ADR files from all detected directories", async () => {
    // docs/adr already has 0001-test.md from earlier
    // docs/ADR has 0002-other.md
    // ADR/ has 0003-root.md
    const files = await listAdrs(tmpDir);
    // Should include at least these three
    const basenames = files.map((f) => f.split("/").pop() ?? f).sort();
    assert.ok(basenames.includes("0001-test.md"));
    assert.ok(basenames.includes("0002-other.md"));
    assert.ok(basenames.includes("0003-root.md"));
  });

  it("returns empty array when no ADR dirs exist", async () => {
    const cleanDir = join(tmpdir(), `adr-empty-${randomUUID()}`);
    await mkdir(cleanDir, { recursive: true });
    try {
      const files = await listAdrs(cleanDir);
      assert.deepEqual(files, []);
    } finally {
      await rm(cleanDir, { recursive: true, force: true });
    }
  });
});

describe("ADR overlap detection", () => {
  // TODO: test that createAdr reads existing ADRs and warns on overlap
  it("placeholder — overlap detection needs createAdr refactor");
});
