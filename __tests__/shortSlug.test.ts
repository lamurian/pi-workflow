import { describe, it } from "vitest";
import assert from "node:assert/strict";
import { shortSlug } from "../extensions/utils.ts";

describe("shortSlug", () => {
  // ── default maxLen = 60 ─────────────────────────────────

  it("uses default maxLen of 60", () => {
    const slug = shortSlug("PostgreSQL for Persistence");
    assert.equal(slug, "postgresql-for-persistence");
    assert.ok(slug.length <= 60);
  });

  // ── short titles pass through ───────────────────────────

  it("generates slug for a short title", () => {
    const slug = shortSlug("Add Login", 60);
    assert.equal(slug, "add-login");
  });

  it("strips leading and trailing hyphens", () => {
    const slug = shortSlug("  Hello World  ", 60);
    assert.equal(slug, "hello-world");
  });

  it("collapses multiple non-alphanumeric sequences into one hyphen", () => {
    const slug = shortSlug("Foo   Bar---Baz!!Qux", 60);
    assert.equal(slug, "foo-bar-baz-qux");
  });

  // ── long titles throw instead of truncating ─────────────

  it("throws when slug exceeds maxLen", () => {
    const longTitle = "A Really Long Title That Should Exceed The Maximum Allowed Slug Length For Sure";

    assert.throws(
      () => shortSlug(longTitle, 40),
      (err: unknown) =>
        err instanceof Error &&
        err.message.includes("exceeds 40 characters") &&
        err.message.includes("shorter title"),
    );
  });

  it("throws on default 60-char limit when title is extremely long", () => {
    const extremelyLong =
      "This Is An Extremely Long Architecture Decision Record Title That Definitely Exceeds Sixty Characters By A Lot";

    assert.throws(
      () => shortSlug(extremelyLong),
      (err: unknown) =>
        err instanceof Error &&
        err.message.includes("exceeds 60 characters"),
    );
  });

  // ── boundary: exactly at the limit ──────────────────────

  it("passes when slug is exactly at maxLen", () => {
    // "exactly-sixty-characters-" is 24, pad with 'x' to make it 60
    const base = "exactly";
    const padding = "x".repeat(60 - base.length); // 53 x's
    const title = base + padding; // 60 chars of kebab-able text
    // After kebab: 'exactly' + 53 'x' = 60 chars
    const slug = shortSlug(title);
    assert.ok(slug.length <= 60);
    assert.equal(slug.length, 60);
  });

  it("passes when slug is one under maxLen", () => {
    const title = "short-title";
    const slug = shortSlug(title, 60);
    assert.equal(slug, "short-title");
    assert.ok(slug.length < 60);
  });
});
