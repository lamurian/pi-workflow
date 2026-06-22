import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { resolve, dirname } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const SANDBOX_SRC = resolve(__dirname, "../../../sandbox/index.ts");

// ═══════════════════════════════════════════════════════════════════════════════
// Sandbox extension — emoji-free status string
// ═══════════════════════════════════════════════════════════════════════════════

describe("sandbox extension — emoji in status string", () => {
  it("should use ✚ (U+271A) instead of 🔒 (U+1F512) in sandbox status", async () => {
    const source = await readFile(SANDBOX_SRC, "utf-8");

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
