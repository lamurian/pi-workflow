import { describe, it } from "vitest";
import assert from "node:assert/strict";
import {
  classifyDirtyTree,
  parsePorcelainPaths,
  buildDirtyTreeHaltText,
  buildDirtyTreeAdvisoryText,
  IGNORED_DIRTY_PATH,
} from "../extensions/dirty-tree-check.ts";
import type { ContractV2 } from "../extensions/state.ts";

/** Contract: T1 owns src/first.ts, T2 owns src/later.ts, both share src/shared.ts. */
const CONTRACT: ContractV2 = {
  title: "Preflight",
  instruction: "do things",
  done: "all green",
  sources: [
    { path: "src/first.ts", tasks: ["T1"] },
    { path: "src/later.ts", tasks: ["T2"] },
    { path: "src/shared.ts", tasks: ["T1", "T2"] },
    { path: "src/unowned.ts", tasks: [] },
  ],
  tests: [{ path: "__tests__/t.test.ts", tasks: ["T1"] }],
  tasks: [
    { id: "T1", description: "first", expectedOutput: ["e1"], status: "active" },
    { id: "T2", description: "second", expectedOutput: ["e2"], status: "active" },
  ],
};

describe("dirty-tree preflight classification (T6)", () => {
  it("a dirty path owned by the first active task is not blocking", () => {
    const c = classifyDirtyTree(" M src/first.ts\n", CONTRACT, "T1");
    assert.deepEqual(c.blocking, [], "first-task-owned dirty work is fine");
    assert.deepEqual(c.advisory, []);
  });

  it("a dirty declared path owned only by a later task is blocking and carries its owner ids", () => {
    const c = classifyDirtyTree(" M src/later.ts\n", CONTRACT, "T1");
    assert.deepEqual(c.blocking, [{ path: "src/later.ts", owners: ["T2"] }]);
    assert.deepEqual(c.advisory, [], "a blocking path is not advisory too");
  });

  it("a dirty path shared by the first active task and a later task is not blocking", () => {
    const c = classifyDirtyTree(" M src/shared.ts\n", CONTRACT, "T1");
    assert.deepEqual(c.blocking, [], "co-owned dirty work never blocks");
  });

  it("an undeclared dirty path is advisory, not blocking", () => {
    const c = classifyDirtyTree("?? scratch.txt\n", CONTRACT, "T1");
    assert.deepEqual(c.blocking, []);
    assert.deepEqual(c.advisory, ["scratch.txt"]);
  });

  it(".pi/extensions/test.ts is ignored by the classification", () => {
    assert.equal(IGNORED_DIRTY_PATH, ".pi/extensions/test.ts");
    const c = classifyDirtyTree(`?? ${IGNORED_DIRTY_PATH}\n`, CONTRACT, "T1");
    assert.deepEqual(c.blocking, []);
    assert.deepEqual(c.advisory, [], "the orchestrator-owned file is neither blocking nor advisory");
  });

  it("a declared path with no owners (shared contract path) never blocks", () => {
    // Mirrors the cross-ownership module's owners.length > 0 guard: only a
    // path owned by OTHER tasks is a cross-ownership hazard.
    const c = classifyDirtyTree(" M src/unowned.ts\n", CONTRACT, "T1");
    assert.deepEqual(c.blocking, []);
    assert.deepEqual(c.advisory, []);
  });

  it("parsePorcelainPaths handles renames, quotes and short lines", () => {
    assert.deepEqual(
      parsePorcelainPaths(" M a.ts\n?? b.ts\nR  old.ts -> new.ts\n?? \"q dir/x.ts\"\nab\n"),
      ["a.ts", "b.ts", "new.ts", "q dir/x.ts"],
    );
  });

  it("the halt text names every blocking path, its owners and the three fallbacks", () => {
    const c = classifyDirtyTree(" M src/later.ts\n", CONTRACT, "T1");
    const text = buildDirtyTreeHaltText(c, "T1");
    assert.match(text, /src\/later\.ts/, "names the path");
    assert.match(text, /T2/, "names the owners");
    assert.match(text, /checkpoint/i, "fallback: commit as checkpoint");
    assert.match(text, /git stash push -- src\/later\.ts/, "fallback: stash the paths");
    assert.match(text, /re-finalize/i, "fallback: re-finalize so the first active task owns them");
    assert.match(text, /before any unit spawned/, "states the halt happened pre-spawn");
  });

  it("the advisory text lists undeclared paths and is empty with nothing to report", () => {
    const dirty = classifyDirtyTree("?? scratch.txt\n", CONTRACT, "T1");
    assert.match(buildDirtyTreeAdvisoryText(dirty), /scratch\.txt/);
    const clean = classifyDirtyTree(" M src/first.ts\n", CONTRACT, "T1");
    assert.equal(buildDirtyTreeAdvisoryText(clean), "");
  });
});
