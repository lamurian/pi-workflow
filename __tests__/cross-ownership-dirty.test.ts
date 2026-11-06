// T3: the cross-ownership halt covers the dirty working tree, not only the
// staged index. A hook-named foreign path that is modified-but-unstaged or
// untracked blocks with a working-tree-specific message; a clean foreign path
// (absent from index AND dirty set) stays a phantom and never blocks.

import { describe, it } from "vitest";
import assert from "node:assert/strict";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { crossOwnershipHalt, findCrossOwnershipBlock, buildCrossOwnershipHaltText } from "../extensions/cross-ownership.ts";
import type { ContractV2 } from "../extensions/state.ts";

/** Hook output naming a foreign declared path (extensions/other.ts → T7/T2). */
const FOREIGN_HOOK =
  "golangci-lint run failed\n" +
  "extensions/other.ts:12:5: undefined: Probe\n" +
  "exit status 1";

/**
 * A v2 contract where T1 owns src/a.ts + __tests__/a.test.ts and the foreign
 * path extensions/other.ts is owned by T7 and T2.
 *
 * @returns A fresh contract fixture.
 */
function dirtyContract(): ContractV2 {
  return {
    title: "Dirty Ownership",
    instruction: "do things",
    done: "all green",
    sources: [
      { path: "src/a.ts", tasks: ["T1"] },
      { path: "extensions/other.ts", tasks: ["T7", "T2"] },
    ],
    tests: [{ path: "__tests__/a.test.ts", tasks: ["T1"] }],
    tasks: [
      { id: "T1", description: "first behavior", expectedOutput: ["e1"], status: "active" },
      { id: "T7", description: "second behavior", expectedOutput: ["e7"], status: "active" },
      { id: "T2", description: "third behavior", expectedOutput: ["e2"], status: "active" },
    ],
  };
}

/**
 * Exec mock answering the two tree snapshots the classifier reads:
 * `git diff --cached --name-only HEAD` (staged index) and
 * `git status --porcelain --untracked-files=all` (dirty lines).
 *
 * @param staged    - Paths in the true index.
 * @param dirtyLine - Raw porcelain lines (` M path` modified, `?? path` untracked).
 * @returns The mock ExtensionAPI.
 */
function piWithTree(staged: string[], dirtyLine: string[]): ExtensionAPI {
  return {
    exec: (async (cmd: string, args: string[]) => {
      const ok = (stdout = "") => ({ stdout, stderr: "", code: 0, killed: false });
      if (cmd === "git" && args[0] === "diff" && args.includes("--cached")) {
        return ok(staged.length > 0 ? `${staged.join("\n")}\n` : "");
      }
      if (cmd === "git" && args[0] === "status" && args.includes("--porcelain")) {
        return ok(dirtyLine.length > 0 ? `${dirtyLine.join("\n")}\n` : "");
      }
      return ok();
    }) as ExtensionAPI["exec"],
  } as unknown as ExtensionAPI;
}

describe("T3: cross-ownership halt over the dirty working tree", () => {
  it("dirtyUnstagedForeignPathHalts: a hook-named foreign path modified but unstaged halts naming the path and its owners", async () => {
    const text = await crossOwnershipHalt(
      piWithTree(["src/a.ts"], [" M extensions/other.ts"]),
      "/repo",
      FOREIGN_HOOK,
      dirtyContract(),
      "T1",
    );
    assert.ok(text, "a dirty-unstaged foreign path blocks the commit");
    assert.match(text, /extensions\/other\.ts/, "the blocking path is named");
    assert.match(text, /T7/, "the first owning task id is named");
    assert.match(text, /T2/, "the second owning task id is named");
  });

  it("untrackedForeignPathHalts: a hook-named foreign path that is untracked produces a cross-ownership halt", async () => {
    const text = await crossOwnershipHalt(
      piWithTree(["src/a.ts"], ["?? extensions/other.ts"]),
      "/repo",
      FOREIGN_HOOK,
      dirtyContract(),
      "T1",
    );
    assert.ok(text, "an untracked foreign path blocks the commit");
    assert.match(text, /extensions\/other\.ts/, "the blocking path is named");
    assert.match(text, /T7/, "the owning task ids are named");
  });

  it("cleanForeignPathNeverHalts: a hook-named foreign path absent from index and dirty set produces no halt", async () => {
    const text = await crossOwnershipHalt(
      piWithTree(["src/a.ts"], [" M src/a.ts"]),
      "/repo",
      FOREIGN_HOOK,
      dirtyContract(),
      "T1",
    );
    assert.equal(text, undefined, "a clean foreign path stays a phantom and never blocks");
  });

  it("dirtyHaltExplainsWorkingTreeScope: the halt text states that the hook checks the working tree", async () => {
    const text = await crossOwnershipHalt(
      piWithTree(["src/a.ts"], [" M extensions/other.ts"]),
      "/repo",
      FOREIGN_HOOK,
      dirtyContract(),
      "T1",
    );
    assert.ok(text, "the dirty-unstaged foreign path halts");
    assert.match(
      text,
      /checks the working tree/,
      "the halt text says the repo-wide hook checks the working tree",
    );
  });

  it("dirtyHaltNamesStashAndRefinalizeFallbacks: the halt text names git stash push -- <path> and re-finalize as fallbacks", async () => {
    const text = await crossOwnershipHalt(
      piWithTree(["src/a.ts"], [" M extensions/other.ts"]),
      "/repo",
      FOREIGN_HOOK,
      dirtyContract(),
      "T1",
    );
    assert.ok(text, "the dirty-unstaged foreign path halts");
    assert.match(
      text,
      /git stash push -- extensions\/other\.ts/,
      "fallback: git stash push -- <path>",
    );
    assert.match(text, /re-finalize/, "fallback: re-finalize so the current task owns the path");
    assert.match(
      text,
      /commit the file for its owning task/i,
      "fallback: commit the file for the owning task",
    );
  });

  it("stagedForeignPathKeepsExistingFallbackText: a hook-named staged foreign path still halts with the fix-the-file/unstage fallback", async () => {
    const text = await crossOwnershipHalt(
      piWithTree(["src/a.ts", "extensions/other.ts"], [" M extensions/other.ts"]),
      "/repo",
      FOREIGN_HOOK,
      dirtyContract(),
      "T1",
    );
    assert.ok(text, "a staged foreign path still blocks");
    assert.match(text, /extensions\/other\.ts/, "the blocking path is named");
    assert.match(text, /T7, T2/, "the owning task ids are named");
    assert.match(
      text,
      /fix the file for the owning task/i,
      "existing fallback: fix the file for the owning task",
    );
    assert.match(
      text,
      /unstage\/keep it out of this unit's commit/i,
      "existing fallback: unstage/keep out of this unit's commit",
    );
  });

  it("pureHelpersKeepSignatures: 4-arg staged-only calls keep working; the 5th arg adds the dirty set", () => {
    const contract = dirtyContract();
    const staged = ["src/a.ts"];
    assert.equal(
      findCrossOwnershipBlock(FOREIGN_HOOK, contract, "T1", staged),
      undefined,
      "4-arg call: without the dirty set a foreign path outside the index stays a phantom",
    );
    assert.deepEqual(
      findCrossOwnershipBlock(FOREIGN_HOOK, contract, "T1", staged, ["extensions/other.ts"]),
      { path: "extensions/other.ts", owners: ["T7", "T2"] },
      "5-arg call: the dirty set adds the blocking path with its owners",
    );
    assert.equal(
      buildCrossOwnershipHaltText("src/a.ts:10:1: bad", contract, "T1", staged),
      undefined,
      "4-arg build call keeps working: no block → no error",
    );
    assert.equal(
      findCrossOwnershipBlock(FOREIGN_HOOK, undefined, "T1", staged, ["extensions/other.ts"]),
      undefined,
      "v1 sessions (no contract) never block regardless of the dirty set",
    );
  });
});
