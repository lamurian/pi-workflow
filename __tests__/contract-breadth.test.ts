import { describe, it, afterEach } from "vitest";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { checkTaskBreadth } from "../extensions/contract-breadth.ts";
import type { ContractV2, PathEntry, TaskUnit } from "../extensions/state.ts";
import {
  loadWorkflowConfig,
  resetWorkflowConfigCache,
  resolveMaxPathsPerTask,
} from "../extensions/paths.ts";

/** Minimal valid contract around the given lists and task units. */
function contract(
  sources: PathEntry[],
  tasks: TaskUnit[],
  tests: PathEntry[] = [],
): ContractV2 {
  return { title: "t", instruction: "i", done: "d", sources, tests, tasks };
}

/** A task unit with a single assertion. */
function task(id: string, status: TaskUnit["status"] = "active"): TaskUnit {
  return { id, description: `d-${id}`, expectedOutput: ["e"], status };
}

/** n distinct source paths owned by one task. */
function ownedSources(id: string, n: number): PathEntry[] {
  return Array.from({ length: n }, (_, i) => ({ path: `src/${id}-${i}.ts`, tasks: [id] }));
}

describe("checkTaskBreadth (T1)", () => {
  it("returns no violation when every active task owns at most the limit", () => {
    const c = contract(ownedSources("T1", 10), [task("T1"), task("T2")], [
      { path: "tests/a.test.ts", tasks: ["T2"] },
    ]);

    assert.equal(checkTaskBreadth(c, 10), null);
  });

  it("reports a task owning limit+1 paths with its id, count and the limit", () => {
    const c = contract(ownedSources("T1", 11), [task("T1")]);

    const reason = checkTaskBreadth(c, 10);

    assert.ok(reason !== null, "11 paths must exceed a limit of 10");
    assert.match(reason, /^task too broad: /);
    assert.match(reason, /\bT1\b/);
    assert.match(reason, /\b11\b/);
    assert.match(reason, /\blimit 10\b/);
  });

  it("paths in tests count toward the task's total alongside sources", () => {
    const tests = Array.from({ length: 5 }, (_, i) => ({
      path: `tests/t${i}.test.ts`,
      tasks: ["T1"],
    }));
    const c = contract(ownedSources("T1", 6), [task("T1")], tests);

    const reason = checkTaskBreadth(c, 10);

    assert.ok(reason !== null, "6 sources + 5 tests = 11 must exceed 10");
    assert.match(reason, /\b11\b/);
  });

  it("a path shared by two tasks counts toward both tasks", () => {
    const shared: PathEntry = { path: "src/shared.ts", tasks: ["T1", "T2"] };
    const sources = [
      shared,
      ...ownedSources("T1", 10),
      ...ownedSources("T2", 10),
    ];
    const c = contract(sources, [task("T1"), task("T2")]);

    const reason = checkTaskBreadth(c, 10);

    assert.ok(reason !== null, "each owner has 11 paths once the shared path counts");
    assert.match(reason, /\bT1\b/);
    assert.match(reason, /\bT2\b/);
    assert.match(reason, /\b11\b/);
  });

  it("tasks with status done are exempt from the cap", () => {
    const c = contract(ownedSources("T1", 11), [
      task("T1", "done"),
      task("T2", "active"),
    ]);

    assert.equal(checkTaskBreadth(c, 10), null, "done tasks are exempt");

    const mixed = contract(
      [...ownedSources("T1", 11), ...ownedSources("T2", 11)],
      [task("T1", "done"), task("T2", "active")],
    );
    const reason = checkTaskBreadth(mixed, 10);
    assert.ok(reason !== null);
    assert.match(reason, /\bT2\b/);
    assert.doesNotMatch(reason, /\bT1\b/, "the done task must not be named");
  });
});

describe("maxPathsPerTask resolution (T1)", () => {
  const tmpDirs: string[] = [];
  afterEach(() => {
    while (tmpDirs.length) fs.rmSync(tmpDirs.pop()!, { recursive: true, force: true });
    resetWorkflowConfigCache();
  });

  /** Resolve the cap for a temp project carrying the given files. */
  async function resolveLimit(files: Record<string, string>): Promise<number> {
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "pi-breadth-"));
    tmpDirs.push(cwd);
    for (const [rel, content] of Object.entries(files)) {
      const full = path.join(cwd, rel);
      fs.mkdirSync(path.dirname(full), { recursive: true });
      fs.writeFileSync(full, content);
    }
    resetWorkflowConfigCache();
    const config = await loadWorkflowConfig(cwd);
    return resolveMaxPathsPerTask(config);
  }

  it("the resolved limit defaults to 10 when workflow.json sets no finalize.maxPathsPerTask", async () => {
    assert.equal(await resolveLimit({}), 10);
  });

  it("a finalize.maxPathsPerTask value from workflow.json overrides the default", async () => {
    const files = {
      ".pi/workflow.json": JSON.stringify({ finalize: { maxPathsPerTask: 4 } }),
    };
    assert.equal(await resolveLimit(files), 4);
  });

  it("an invalid maxPathsPerTask (0, negative, non-integer) falls back to 10", async () => {
    for (const bad of [0, -3, 2.5]) {
      const files = {
        ".pi/workflow.json": JSON.stringify({ finalize: { maxPathsPerTask: bad } }),
      };
      assert.equal(await resolveLimit(files), 10, `value ${bad} must fall back to 10`);
    }
  });
});
