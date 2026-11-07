import { describe, it } from "vitest";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runSaveTask } from "../extensions/save-task-core.ts";
import { validateContract } from "../extensions/contract-v2-validate.ts";
import type { WorkflowState } from "../extensions/state.ts";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

function mockPi(): ExtensionAPI {
  const noop = () => {};
  return {
    appendEntry: noop,
    getActiveTools: () => [],
    setActiveTools: noop,
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

function payload(commands: unknown): Record<string, unknown> {
  return {
    title: "T",
    instruction: "i",
    done: "d",
    sources: [{ path: "src/a.ts", tasks: ["T1"] }],
    tests: [{ path: "tests/a.test.ts", tasks: ["T1"] }],
    tasks: [{ id: "T1", description: "x", expectedOutput: ["y"], commands }],
  };
}

describe("contract task commands", () => {
  it("validateContract accepts a string commands array", () => {
    const r = validateContract(payload(["lint"]));
    assert.equal(r.ok, true);
    if (r.ok) assert.deepEqual(r.contract.tasks[0].commands, ["lint"]);
  });

  it("validateContract rejects non-string command entries", () => {
    const r = validateContract(payload(["lint", 3]));
    assert.equal(r.ok, false);
    if (!r.ok) assert.match(r.reason, /commands/);
  });

  it("save_task rejects an undeclared command", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "cmds-"));
    mkdirSync(join(cwd, ".pi"));
    writeFileSync(
      join(cwd, ".pi", "workflow.json"),
      JSON.stringify({ implement: { commands: { lint: ["npm", "run", "lint"] } } }),
    );
    const s: WorkflowState = { phase: "discussing", specText: "t" };
    const res = await runSaveTask(s, payload(["deploy"]), {
      caller: "agent",
      pi: mockPi(),
      ctx: mockCtx(cwd),
    });
    assert.equal(res.ok, false);
    assert.match(res.text, /deploy/);
    assert.match(res.text, /update_workflow_config/);
  });
});
