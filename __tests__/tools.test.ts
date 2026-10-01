import { describe, it, beforeEach } from "vitest";
import assert from "node:assert/strict";
import {
  DISCUSS_BLOCKED_TOOLS,
  applyDiscussTools,
  restoreTools,
  resetToolsState,
} from "../extensions/tools.ts";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

/**
 * Simulated full toolset: read/search tools plus every write-capable tool.
 */
const FULL_TOOLS = [
  "read",
  "bash",
  "grep",
  "find",
  "ls",
  "explore",
  "ask",
  "web_search",
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

/**
 * READ_ONLY_TOOLS is FULL_TOOLS minus the discuss-blocked list.
 */
const READ_ONLY_TOOLS = FULL_TOOLS.filter(
  (name) => !DISCUSS_BLOCKED_TOOLS.includes(name),
);

/**
 * Create a mock ExtensionAPI with getActiveTools/setActiveTools spies.
 *
 * @param activeTools - Initial active tool list returned by getActiveTools.
 * @returns Mock with a `.calls.setActiveTools` recording of each call.
 */
function mockPi(
  activeTools: string[] = FULL_TOOLS,
): ExtensionAPI & { calls: Record<string, unknown[]> } {
  const calls: Record<string, unknown[]> = {};
  const record = (name: string) => {
    calls[name] = [];
    return (...args: unknown[]) => {
      calls[name]!.push(args);
    };
  };

  return {
    getActiveTools: () => [...activeTools],
    setActiveTools: record("setActiveTools") as ExtensionAPI["setActiveTools"],
    calls,
  } as unknown as ExtensionAPI & { calls: Record<string, unknown[]> };
}

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
// applyDiscussTools
// ═══════════════════════════════════════════════════════════════════════════════

describe("applyDiscussTools", () => {
  beforeEach(() => {
    resetToolsState();
  });

  it("removes all write-capable tools from the active set", () => {
    const pi = mockPi();

    applyDiscussTools(pi);

    const setCalls = pi.calls["setActiveTools"] ?? [];
    assert.equal(setCalls.length, 1, "setActiveTools should be called once");

    const [filtered] = setCalls[0] as [string[]];
    assert.deepEqual(filtered, READ_ONLY_TOOLS);
  });

  it("keeps read/search/exploration tools available", () => {
    const pi = mockPi();

    applyDiscussTools(pi);

    const setCalls = pi.calls["setActiveTools"] ?? [];
    const [filtered] = setCalls[0] as [string[]];

    for (const name of ["read", "bash", "grep", "find", "ls", "explore"]) {
      assert.ok(filtered.includes(name), `${name} should remain available`);
    }
  });

  it("keeps the original snapshot across repeated applies", () => {
    const pi = mockPi(FULL_TOOLS);

    applyDiscussTools(pi);
    applyDiscussTools(pi);
    restoreTools(pi);

    const setCalls = pi.calls["setActiveTools"] ?? [];
    assert.equal(setCalls.length, 3, "apply, apply, restore");
    // Snapshot must not have been re-saved from the filtered set:
    // restore still returns the ORIGINAL full toolset.
    const [restored] = setCalls[setCalls.length - 1] as [string[]];
    assert.deepEqual(restored, FULL_TOOLS);
  });

  it("survives tools that are not registered (unknown names are dropped)", () => {
    const pi = mockPi(["read", "bash", "write"]);

    applyDiscussTools(pi);

    const setCalls = pi.calls["setActiveTools"] ?? [];
    const [filtered] = setCalls[0] as [string[]];
    assert.deepEqual(filtered, ["read", "bash"]);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// restoreTools
// ═══════════════════════════════════════════════════════════════════════════════

describe("restoreTools", () => {
  beforeEach(() => {
    resetToolsState();
  });

  it("round-trips back to the exact original toolset", () => {
    const pi = mockPi(FULL_TOOLS);

    applyDiscussTools(pi);
    restoreTools(pi);

    const setCalls = pi.calls["setActiveTools"] ?? [];
    assert.equal(setCalls.length, 2, "apply then restore");

    const [filtered] = setCalls[0] as [string[]];
    const [restored] = setCalls[1] as [string[]];
    assert.deepEqual(filtered, READ_ONLY_TOOLS);
    assert.deepEqual(restored, FULL_TOOLS);
  });

  it("is a no-op when no snapshot exists", () => {
    const pi = mockPi(FULL_TOOLS);

    restoreTools(pi);

    const setCalls = pi.calls["setActiveTools"] ?? [];
    assert.equal(setCalls.length, 0, "restore without snapshot must not call setActiveTools");
  });

  it("clears the snapshot after restoring", () => {
    const pi = mockPi(FULL_TOOLS);

    applyDiscussTools(pi);
    restoreTools(pi);
    restoreTools(pi);

    const setCalls = pi.calls["setActiveTools"] ?? [];
    assert.equal(setCalls.length, 2, "second restore must be a no-op");
  });
});