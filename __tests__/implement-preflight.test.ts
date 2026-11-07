import { describe, it } from "vitest";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { preflightImplement } from "../extensions/implement-preflight.ts";
import { hashProjectConfig } from "../extensions/run-plan.ts";
import type { WorkflowState } from "../extensions/state.ts";

function tmp(config?: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "preflight-"));
  if (config !== undefined) {
    fs.mkdirSync(path.join(dir, ".pi"));
    fs.writeFileSync(path.join(dir, ".pi", "workflow.json"), config);
  }
  return dir;
}

function baseState(): WorkflowState {
  return {
    phase: "finalizing",
    specText: "x",
    contractV2: {
      title: "t",
      instruction: "i",
      done: "d",
      sources: [],
      tests: [{ path: "__tests__/a.test.ts", tasks: ["T1"] }],
      tasks: [{ id: "T1", description: "d", expectedOutput: ["e"], status: "active" }],
    },
  } as unknown as WorkflowState;
}

describe("preflightImplement", () => {
  it("refuses when the config hash differs, naming /discuss -> /finalize", async () => {
    const cwd = tmp("{}");
    const state = baseState();
    state.runPlan = { scoped: [{ argv: ["npm", "test"] }] as never, full: [], commands: {}, configHash: "stale" };
    const msg = await preflightImplement(state, cwd);
    assert.ok(msg && msg.includes("/discuss -> /finalize"));
    assert.equal(msg.split("\n").length, 1);
  });

  it("refuses when an active task owns tests but there are no scoped suites", async () => {
    const cwd = tmp("{}");
    const state = baseState();
    state.runPlan = { scoped: [], full: [], commands: {}, configHash: await hashProjectConfig(cwd) };
    const msg = await preflightImplement(state, cwd);
    assert.ok(msg && /scoped suites/.test(msg));
  });

  it("passes for a matching plan with scoped suites", async () => {
    const cwd = tmp();
    const state = baseState();
    state.runPlan = { scoped: [{ argv: ["npm", "test"] }] as never, full: [], commands: {}, configHash: "none" };
    assert.equal(await preflightImplement(state, cwd), null);
  });

  it("passes for legacy state without a runPlan", async () => {
    assert.equal(await preflightImplement(baseState(), tmp("{}")), null);
  });
});
