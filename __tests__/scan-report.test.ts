import { describe, it } from "vitest";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { runSaveTask } from "../extensions/save-task-core.ts";
import { diffScanDigest, SCAN_EVIDENCE_PATH } from "../extensions/scan-report.ts";
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

const payload = (srcPath: string) => ({
  title: "T",
  instruction: "do",
  done: "tests pass",
  sources: [{ path: srcPath, tasks: ["T1"] }],
  tests: [],
  tasks: [{ id: "T1", description: "x", expectedOutput: ["inspect: returns x"] }],
});

describe("scan report", () => {
  it("writes the full evidence file and names it in the result", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "scan-report-"));
    const state: WorkflowState = { phase: "discussing", specText: "t" };
    const res = await runSaveTask(state, payload("src/a.ts"), {
      caller: "agent",
      pi: mockPi(),
      ctx: mockCtx(dir),
    });
    assert.equal(res.ok, true, res.text);
    assert.match(res.text, /\.pi\/workflow\/scan-evidence\.md/);
    const file = fs.readFileSync(path.join(dir, SCAN_EVIDENCE_PATH), "utf8");
    assert.match(file, /## Evidence/);
    assert.match(file, /## Warnings/);
    assert.ok(state.scanDigest);
  });

  it("re-save reports only changed lines plus an unchanged count", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "scan-report-"));
    const state: WorkflowState = { phase: "discussing", specText: "t" };
    const opts = { caller: "agent" as const, pi: mockPi(), ctx: mockCtx(dir) };
    await runSaveTask(state, payload("src/a.ts"), opts);
    state.scanDigest = [...(state.scanDigest ?? []), "warning: stale line"];
    const res = await runSaveTask(state, payload("src/a.ts"), opts);
    assert.equal(res.ok, true, res.text);
    assert.match(res.text, /## Scan changes since last save/);
    assert.match(res.text, /- warning: stale line/);
    assert.match(res.text, /\d+ unchanged lines/);
    assert.doesNotMatch(res.text, /Warnings \(advisory/);
  });

  it("diffScanDigest computes added, removed and unchanged", () => {
    const d = diffScanDigest(["a", "b", "c"], ["b", "c", "d"]);
    assert.deepEqual(d, { added: ["d"], removed: ["a"], unchanged: 2 });
  });
});
