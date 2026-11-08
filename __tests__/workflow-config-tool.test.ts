import { describe, it } from "vitest";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { updateWorkflowConfig } from "../extensions/workflow-config-tool.ts";

function setup(initial?: unknown): { cwd: string; path: string } {
  const cwd = mkdtempSync(join(tmpdir(), "wfcfg-"));
  const path = join(cwd, ".pi", "workflow.json");
  if (initial !== undefined) {
    mkdirSync(join(cwd, ".pi"), { recursive: true });
    writeFileSync(path, JSON.stringify(initial));
  }
  return { cwd, path };
}

describe("update_workflow_config", () => {
  it("rejects calls outside the discussing phase naming /discuss", async () => {
    const { cwd, path } = setup();
    const res = await updateWorkflowConfig({
      cwd, phase: "implementing", patch: { implement: {} }, confirm: async () => true,
    });
    assert.equal(res.ok, false);
    assert.match(res.text, /\/discuss/);
    assert.match(res.text, /discussing/);
    assert.match(res.text, /finalizing/);
    assert.equal(existsSync(path), false);
  });

  it("applies a confirmed patch when the phase is finalizing", async () => {
    const { cwd, path } = setup({});
    const res = await updateWorkflowConfig({
      cwd, phase: "finalizing", patch: { implement: { commands: { lint: ["npm", "run", "lint"] } } },
      confirm: async () => true,
    });
    assert.equal(res.ok, true);
    assert.deepEqual(JSON.parse(readFileSync(path, "utf8")).implement.commands.lint, ["npm", "run", "lint"]);
  });

  it("README documents discussing and finalizing for the tool", () => {
    const readme = readFileSync(join(__dirname, "..", "README.md"), "utf8");
    const row = readme.split("\n").find((l) => l.startsWith("| `update_workflow_config`")) ?? "";
    assert.match(row, /`discussing` and `finalizing`/);
  });

  it("rejects an invalid merged result and writes nothing", async () => {
    const { cwd, path } = setup({ implement: {} });
    const before = readFileSync(path, "utf8");
    let asked = false;
    const res = await updateWorkflowConfig({
      cwd, phase: "discussing",
      patch: { implement: { tests: { scoped: [[]] } } },
      confirm: async () => { asked = true; return true; },
    });
    assert.equal(res.ok, false);
    assert.equal(asked, false);
    assert.equal(readFileSync(path, "utf8"), before);
  });

  const patch = {
    implement: {
      tests: { scoped: [["npm", "test", "--", "a"]], full: [{ argv: ["npm", "run", "full"] }] },
      commands: { lint: ["npm", "run", "lint"] },
    },
  };

  it("shows diff and argvs, writes on confirm", async () => {
    const { cwd, path } = setup({});
    let msg = "";
    const res = await updateWorkflowConfig({
      cwd, phase: "discussing", patch, confirm: async (_t, m) => { msg = m; return true; },
    });
    assert.equal(res.ok, true);
    assert.match(msg, /Diff/);
    assert.ok(msg.includes('["npm","test","--","a"]'));
    assert.ok(msg.includes('["npm","run","full"]'));
    assert.ok(msg.includes('["npm","run","lint"]'));
    assert.deepEqual(JSON.parse(readFileSync(path, "utf8")), patch);
  });

  it("declining leaves the file unchanged", async () => {
    const { cwd, path } = setup({});
    const before = readFileSync(path, "utf8");
    const res = await updateWorkflowConfig({
      cwd, phase: "discussing", patch, confirm: async () => false,
    });
    assert.equal(res.ok, false);
    assert.equal(readFileSync(path, "utf8"), before);
  });
});
