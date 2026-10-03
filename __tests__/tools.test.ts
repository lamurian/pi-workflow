import { describe, it } from "vitest";
import assert from "node:assert/strict";
import * as toolsModule from "../extensions/tools.ts";
import { DISCUSS_BLOCKED_TOOLS } from "../extensions/tools.ts";

// ═══════════════════════════════════════════════════════════════════════════════
// DISCUSS_BLOCKED_TOOLS
// ═══════════════════════════════════════════════════════════════════════════════

describe("DISCUSS_BLOCKED_TOOLS", () => {
  it("deny-lists write, edit, PARA mutators and commit tools", () => {
    const expected = [
      "write",
      "edit",
      "create_para_doc",
      "update_para_doc",
      "batch_create_para_docs",
      "expand_bullet_points",
      "standardize_frontmatter",
      "commit_changes",
      "commit_amend",
    ];
    for (const name of expected) {
      assert.ok(
        DISCUSS_BLOCKED_TOOLS.includes(name),
        `${name} should be in the deny list`,
      );
    }
  });

  it("is a flat list of tool names", () => {
    assert.ok(Array.isArray(DISCUSS_BLOCKED_TOOLS));
    for (const name of DISCUSS_BLOCKED_TOOLS) {
      assert.equal(typeof name, "string");
    }
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// Tool-removal machinery removed (T1)
// ═══════════════════════════════════════════════════════════════════════════════

describe("tool-removal machinery removed", () => {
  it("no longer exports applyDiscussTools, restoreTools, or resetToolsState", () => {
    const mod = toolsModule as unknown as Record<string, unknown>;
    assert.equal(mod["applyDiscussTools"], undefined);
    assert.equal(mod["restoreTools"], undefined);
    assert.equal(mod["resetToolsState"], undefined);
  });
});
