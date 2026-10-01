import { describe, it } from "vitest";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const PKG_PATH = new URL("../package.json", import.meta.url);

describe("package.json packaging", () => {
  it("should keep peerDependencies for pi core packages (pi docs recommend this)", async () => {
    const pkg = JSON.parse(await readFile(PKG_PATH, "utf-8"));
    assert.ok(
      pkg.peerDependencies,
      "peerDependencies should exist per pi package conventions. " +
        "Pi core packages (@earendil-works/*, typebox) go in peerDependencies with '*' range.",
    );
  });

  it("should retain fast-glob as a direct dependency", async () => {
    const pkg = JSON.parse(await readFile(PKG_PATH, "utf-8"));
    assert.ok(
      pkg.dependencies?.["fast-glob"],
      "fast-glob is a third-party dependency not provided by pi, so it must remain",
    );
  });
});
