import { describe, it } from "vitest";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { runSaveTask } from "../extensions/save-task-core.ts";
import type { WorkflowState } from "../extensions/state-types.ts";

function mockPi(): ExtensionAPI {
  return {
    appendEntry: () => {},
    getActiveTools: () => [],
    setActiveTools: () => {},
    exec: async () => ({ stdout: "", stderr: "", code: 0, killed: false }),
  } as unknown as ExtensionAPI;
}

function mockCtx(cwd: string): ExtensionContext {
  return {
    cwd,
    sessionManager: { getBranch: () => [] },
    ui: {
      notify: () => {},
      setStatus: () => {},
      setWidget: () => {},
      setTitle: () => {},
      theme: { fg: (_c: string, t: string) => t },
    },
  } as unknown as ExtensionContext;
}

const payload = {
  title: "T",
  instruction: "do",
  done: "tests pass",
  sources: [{ path: "src/a.rs", tasks: ["T1"] }],
  tests: [],
  tasks: [{ id: "T1", description: "x", expectedOutput: ["inspect: returns x"] }],
};

describe("run plan", () => {
  it("save_task pins scoped, full, commands and config hash, and lists argvs", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "run-plan-"));
    fs.writeFileSync(path.join(dir, "Cargo.toml"), "[package]\nname='x'\n");
    fs.mkdirSync(path.join(dir, ".pi"));
    const config = JSON.stringify({ implement: { commands: { lint: ["cargo", "clippy"] } } });
    fs.writeFileSync(path.join(dir, ".pi", "workflow.json"), config);
    const state: WorkflowState = { phase: "discussing", specText: "t" };
    const res = await runSaveTask(state, payload, {
      caller: "agent",
      pi: mockPi(),
      ctx: mockCtx(dir),
    });
    assert.equal(res.ok, true, res.text);
    const plan = state.runPlan;
    assert.ok(plan);
    assert.deepEqual(plan.commands, { lint: ["cargo", "clippy"] });
    assert.ok(plan.scoped.some((s) => s.argv.join(" ") === "cargo test"));
    assert.ok(plan.full.length > 0);
    assert.equal(plan.configHash, createHash("sha256").update(config).digest("hex"));
    for (const argv of [
      ...plan.scoped.map((s) => s.argv),
      ...plan.full.map((s) => s.argv),
      ...Object.values(plan.commands),
    ]) {
      assert.ok(res.text.includes(JSON.stringify(argv)), `missing ${JSON.stringify(argv)}`);
    }
  });
});
