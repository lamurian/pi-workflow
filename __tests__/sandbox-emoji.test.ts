import { describe, it } from "vitest";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { resolve, dirname } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
// The sandbox extension lives in ~/.pi/agent/extensions/sandbox, not in this
// repo. Resolve the sibling path and fall back to the global agent location;
// skip when the source is absent so this external check is env-independent.
const SANDBOX_SRC_CANDIDATES = [
  resolve(__dirname, "../../../sandbox/index.ts"),
  resolve(process.env.HOME ?? "", ".pi/agent/extensions/sandbox/index.ts"),
];
const SANDBOX_SRC = SANDBOX_SRC_CANDIDATES.find((p) => existsSync(p));

// ═══════════════════════════════════════════════════════════════════════════════
// Sandbox extension — emoji-free status string
// ═══════════════════════════════════════════════════════════════════════════════

describe("sandbox extension — emoji in status string", () => {
  it(
    "should use ✚ (U+271A) instead of 🔒 (U+1F512) in sandbox status",
    { skip: !SANDBOX_SRC && "sandbox/index.ts not found in this environment" },
    async () => {
      const source = await readFile(SANDBOX_SRC!, "utf-8");

    // The source should not contain the 🔒 emoji
    assert.ok(
      !source.includes("🔒"),
      "sandbox/index.ts should not contain 🔒 emoji",
    );

    // The source should contain the ✚ Dingbat glyph
    assert.ok(
      source.includes("✚"),
      "sandbox/index.ts should contain ✚ (U+271A) Dingbat glyph",
    );
  });
});
