import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdir, writeFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";

/**
 * Tests for normalizeReferences in cross-ref.ts
 *
 * Spec (discussion):
 * - Resolves @docs/ADR/NNN-*.md globs to exact filenames
 * - Resolves @docs/specs/NNN-*.md globs to exact filenames
 * - Converts "ADR NNN: Title" human labels to "ADR NNN: @docs/ADR/NNN-slug.md"
 * - Converts "Spec NNN: Title" human labels to "Spec NNN: @docs/specs/NNN-slug.md"
 * - Unchanged when no ADR/spec directories exist
 * - Unchanged when no patterns match
 */

let tmpDir: string;

describe("normalizeReferences", () => {
  before(async () => {
    tmpDir = join(tmpdir(), `cross-ref-test-${randomUUID()}`);
    await mkdir(tmpDir, { recursive: true });
    await mkdir(join(tmpDir, "docs", "ADR"), { recursive: true });
    await mkdir(join(tmpDir, "docs", "specs"), { recursive: true });

    // Create sample ADR and spec files with known filenames
    await writeFile(
      join(tmpDir, "docs", "ADR", "006-remove-roadmap-skill.md"),
      "---\ntitle: Remove Roadmap Skill\n---\n\n# Decision\n\nDelete it.",
      "utf-8",
    );
    await writeFile(
      join(tmpDir, "docs", "ADR", "007-standard-markdown-links.md"),
      "---\ntitle: Standard Markdown Links\n---\n\n# Decision\n\nUse [title](path).",
      "utf-8",
    );
    await writeFile(
      join(tmpDir, "docs", "specs", "016-remove-roadmap-skill.md"),
      "---\ntitle: Remove Roadmap Skill\n---\n\n# Requirements\n\nDelete and update.",
      "utf-8",
    );
    await writeFile(
      join(tmpDir, "docs", "specs", "017-update-appendlinks.md"),
      "---\ntitle: Update appendLinks Code\n---\n\n# Requirements\n\nChange link format.",
      "utf-8",
    );
  });

  after(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  it("resolves @docs/ADR/NNN-*.md glob to exact filename", async () => {
    const { normalizeReferences } = await import("../extensions/cross-ref.ts");
    const input = "This spec implements @docs/ADR/006-*.md";
    const result = await normalizeReferences(input, tmpDir);
    assert.equal(result, "This spec implements @docs/ADR/006-remove-roadmap-skill.md");
  });

  it("resolves @docs/specs/NNN-*.md glob to exact filename", async () => {
    const { normalizeReferences } = await import("../extensions/cross-ref.ts");
    const input = "This plan implements @docs/specs/016-*.md";
    const result = await normalizeReferences(input, tmpDir);
    assert.equal(result, "This plan implements @docs/specs/016-remove-roadmap-skill.md");
  });

  it("converts 'ADR NNN: Title' to 'ADR NNN: @docs/ADR/NNN-slug.md'", async () => {
    const { normalizeReferences } = await import("../extensions/cross-ref.ts");
    const input = "- ADR 006: Remove Roadmap Skill";
    const result = await normalizeReferences(input, tmpDir);
    assert.equal(result, "- ADR 006: @docs/ADR/006-remove-roadmap-skill.md");
  });

  it("converts 'Spec NNN: Title' to 'Spec NNN: @docs/specs/NNN-slug.md'", async () => {
    const { normalizeReferences } = await import("../extensions/cross-ref.ts");
    const input = "- Spec 016: Remove Roadmap Skill";
    const result = await normalizeReferences(input, tmpDir);
    assert.equal(result, "- Spec 016: @docs/specs/016-remove-roadmap-skill.md");
  });

  it("handles multiple references in one string", async () => {
    const { normalizeReferences } = await import("../extensions/cross-ref.ts");
    const input = [
      "- ADR 006: Remove Roadmap Skill",
      "- ADR 007: Standard Markdown Links",
      "",
      "This spec implements @docs/ADR/006-*.md and @docs/ADR/007-*.md",
    ].join("\n");

    const expected = [
      "- ADR 006: @docs/ADR/006-remove-roadmap-skill.md",
      "- ADR 007: @docs/ADR/007-standard-markdown-links.md",
      "",
      "This spec implements @docs/ADR/006-remove-roadmap-skill.md and @docs/ADR/007-standard-markdown-links.md",
    ].join("\n");

    const result = await normalizeReferences(input, tmpDir);
    assert.equal(result, expected);
  });

  it("leaves content unchanged when no patterns match", async () => {
    const { normalizeReferences } = await import("../extensions/cross-ref.ts");
    const input = "# Just a regular document\n\nNo references here.";
    const result = await normalizeReferences(input, tmpDir);
    assert.equal(result, input);
  });

  it("leaves content unchanged when ADR/spec dirs exist but no matching number", async () => {
    const { normalizeReferences } = await import("../extensions/cross-ref.ts");
    const input = "Refers to @docs/ADR/999-*.md which doesn't exist";
    const result = await normalizeReferences(input, tmpDir);
    // Should leave the glob pattern as-is when no matching file is found
    assert.equal(result, input);
  });

  it("handles empty content", async () => {
    const { normalizeReferences } = await import("../extensions/cross-ref.ts");
    const result = await normalizeReferences("", tmpDir);
    assert.equal(result, "");
  });

  it("works when docs directories are missing", async () => {
    const isolatedDir = join(tmpDir, "empty-project");
    await mkdir(isolatedDir, { recursive: true });

    const { normalizeReferences } = await import("../extensions/cross-ref.ts");
    const input = "- ADR 006: Remove Roadmap Skill";
    // No docs dirs exist — should leave unchanged
    const result = await normalizeReferences(input, isolatedDir);
    assert.equal(result, input);
  });
});
