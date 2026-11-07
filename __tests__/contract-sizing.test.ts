import { describe, it, afterEach } from "vitest";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { checkTaskSizing, resolveSizingLimits } from "../extensions/contract-sizing.ts";
import type { ContractV2 } from "../extensions/state.ts";

const LIMITS = resolveSizingLimits(null);

function contract(over: Partial<ContractV2> & { tasks: ContractV2["tasks"] }): ContractV2 {
  return {
    title: "t",
    instruction: "i",
    done: "d",
    sources: [{ path: "src/a.ts", tasks: ["T1"] }],
    tests: [{ path: "tests/a.test.ts", tasks: ["T1"] }],
    ...over,
  } as ContractV2;
}

const dirs: string[] = [];
afterEach(() => {
  while (dirs.length) fs.rmSync(dirs.pop()!, { recursive: true, force: true });
});

describe("checkTaskSizing", () => {
  it("rejects more than 3 assertions, naming task, count and limit", () => {
    const c = contract({
      tasks: [{ id: "T1", description: "x", expectedOutput: ["a", "b", "c", "d"], status: "active" }],
    });
    const r = checkTaskSizing(c, "/nonexistent", LIMITS);
    assert.match(r ?? "", /T1 has 4 assertions \(limit 3\)/);
  });

  it("rejects a manual task with more than 2 assertions", () => {
    const c = contract({
      tests: [],
      tasks: [{ id: "T1", description: "x", expectedOutput: ["a", "b", "c"], status: "active" }],
    });
    assert.match(checkTaskSizing(c, "/nonexistent", LIMITS) ?? "", /T1 has 3 manual assertions \(limit 2\)/);
  });

  it("exempts done tasks and honors configured limits", () => {
    const tasks = [{ id: "T1", description: "x", expectedOutput: ["a", "b", "c", "d"], status: "done" as const }];
    assert.equal(checkTaskSizing(contract({ tasks }), "/nonexistent", LIMITS), null);
    const limits = resolveSizingLimits({ finalize: { maxAssertionsPerTask: 5 } });
    const active = [{ ...tasks[0]!, status: "active" as const }];
    assert.equal(checkTaskSizing(contract({ tasks: active }), "/nonexistent", limits), null);
  });

  it("rejects owned existing files over maxTaskBytes, naming bytes and limit", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-size-"));
    dirs.push(dir);
    fs.mkdirSync(path.join(dir, "src"));
    fs.writeFileSync(path.join(dir, "src/a.ts"), "x".repeat(98305));
    const c = contract({ tasks: [{ id: "T1", description: "x", expectedOutput: ["a"], status: "active" }] });
    assert.match(checkTaskSizing(c, dir, LIMITS) ?? "", /T1 owns 98305 bytes .*limit 98304/);
  });

  it("rejects bulk wording unless the task lists a command", () => {
    const t = { id: "T1", description: "x", expectedOutput: ["each file has a header"], status: "active" as const };
    assert.match(checkTaskSizing(contract({ tasks: [t] }), "/nonexistent", LIMITS) ?? "", /bulk wording: T1/);
    const withCmd = { ...t, commands: ["lint"] };
    assert.equal(checkTaskSizing(contract({ tasks: [withCmd] }), "/nonexistent", LIMITS), null);
  });
});
