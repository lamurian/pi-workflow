import { describe, it } from "vitest";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const load = (): Promise<string> =>
  readFile(new URL("../content/unit-prompt.md", import.meta.url), "utf8");

describe("unit-prompt.md budget (T11)", () => {
  it("is at most 5500 bytes and has no Contract drafting rules section", async () => {
    const text = await load();
    assert.ok(Buffer.byteLength(text, "utf8") <= 5500, `size ${Buffer.byteLength(text)}`);
    assert.doesNotMatch(text, /Contract drafting rules/);
  });

  it("asks for a skeleton within about 3 minutes and no repeated verification", async () => {
    const text = await load();
    assert.match(text, /skeleton/i);
    assert.match(text, /3 minutes/);
    assert.match(text, /not repeat verification/i);
    assert.match(text, /600 s/);
    assert.match(text, /50%/);
    assert.match(text, /80%/);
  });

  it("documents status blocked with blockedReason capability or too-large", async () => {
    const text = await load();
    assert.match(text, /"blocked"/);
    assert.match(text, /blockedReason: "capability"/);
    assert.match(text, /blockedReason: "too-large"/);
  });
});
