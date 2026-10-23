import { describe, it } from "vitest";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  PRELOAD_PER_FILE_CAP,
  PRELOAD_TOTAL_CAP,
  buildContextPreload,
} from "../extensions/unit-context-preload.ts";
import { buildUnitTask } from "../extensions/unit-task-text.ts";
import type { TaskContract } from "../extensions/state.ts";

function repo(files: TaskContract["files"]): TaskContract {
  return {
    title: "Preload Task",
    instruction: "do the thing",
    files,
    done: "tests pass",
    behaviors: [
      { id: "T1", description: "x", expectedOutput: "y", kind: "test", status: "active" },
    ],
  };
}

function makeRepoDir(): string {
  return mkdtempSync(join(tmpdir(), "preload-"));
}

describe("buildContextPreload (T7)", () => {
  it("embeds fenced contents of declared M and D files that exist on disk", () => {
    const dir = makeRepoDir();
    mkdirSync(join(dir, "src"));
    writeFileSync(join(dir, "src", "a.ts"), "export const a = 1;\n");
    writeFileSync(join(dir, "src", "old.ts"), "// being removed\n");
    const files = [
      { path: "src/a.ts", status: "M" as const },
      { path: "src/old.ts", status: "D" as const },
    ];

    const section = buildContextPreload(files, dir);

    assert.match(section, /## Preloaded declared file contents/);
    assert.match(section, /### src\/a\.ts \(M\)/);
    assert.match(section, /export const a = 1;/);
    assert.match(section, /### src\/old\.ts \(D\)/);
    assert.match(section, /being removed/);
  });

  it("lists declared A paths as (new file) without contents", () => {
    const dir = makeRepoDir();
    const section = buildContextPreload([{ path: "tests/new.test.ts", status: "A" }], dir);
    assert.match(section, /tests\/new\.test\.ts \(new file\)/);
    assert.doesNotMatch(section, /```/, "no fenced block for a new file");
  });

  it("skips M/D files that do not exist on disk", () => {
    const dir = makeRepoDir();
    const section = buildContextPreload([{ path: "src/missing.ts", status: "M" }], dir);
    assert.equal(section, "");
  });

  it("truncates a file over the 64 KB per-file cap and marks it truncated", () => {
    const dir = makeRepoDir();
    writeFileSync(join(dir, "big.ts"), "x".repeat(PRELOAD_PER_FILE_CAP + 1000));
    const section = buildContextPreload([{ path: "big.ts", status: "M" }], dir);
    assert.match(section, /truncated: showing first 65536 of 66536 bytes/);
    assert.ok(section.length < PRELOAD_PER_FILE_CAP + 2000, "no full 66 KB embedded");
  });

  it("caps the total across files at 256 KB and truncates later files", () => {
    const dir = makeRepoDir();
    mkdirSync(join(dir, "src"));
    for (let i = 0; i < 5; i++) {
      writeFileSync(join(dir, "src", `f${i}.ts`), `${i}`.repeat(PRELOAD_PER_FILE_CAP));
    }
    const files = [0, 1, 2, 3, 4].map((i) => ({
      path: `src/f${i}.ts`,
      status: "M" as const,
    }));
    const section = buildContextPreload(files, dir);
    const embedded = section.length - section.replace(/\n/g, "").length; // structural overhead only
    assert.ok(section.length < 5 * PRELOAD_PER_FILE_CAP, "not all 5 files embedded fully");
    assert.match(section, /truncated/, "the budget-exhausted file is marked truncated");
    assert.ok(embedded > 0);
    assert.ok(PRELOAD_TOTAL_CAP < 5 * PRELOAD_PER_FILE_CAP, "total cap is the binding constraint");
  });
});

describe("buildUnitTask context preload (T7)", () => {
  it("embeds the preload section when preloadCwd is given", () => {
    const dir = makeRepoDir();
    mkdirSync(join(dir, "src"));
    writeFileSync(join(dir, "src", "a.ts"), "export const a = 1;\n");
    const task = repo([
      { path: "src/a.ts", status: "M" },
      { path: "tests/new.test.ts", status: "A" },
    ]);

    const text = buildUnitTask(task.behaviors[0]!, task, { preloadCwd: dir });

    assert.match(text, /## Preloaded declared file contents/);
    assert.match(text, /export const a = 1;/);
    assert.match(text, /tests\/new\.test\.ts \(new file\)/);
  });

  it("omits the preload section without preloadCwd (byte-compatible default)", () => {
    const task = repo([{ path: "src/a.ts", status: "M" }]);
    const text = buildUnitTask(task.behaviors[0]!, task);
    assert.doesNotMatch(text, /## Preloaded declared file contents/);
  });
});
