import { describe, it } from "vitest";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { updateWorkflowConfig } from "../extensions/workflow-config-tool.ts";
import { commitScopedPath } from "../extensions/scoped-commit.ts";

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

  it("a confirmed update commits only .pi/workflow.json and reports the landed commit", async () => {
    const { cwd, path } = setup({});
    const git = (...a: string[]): string => {
      const r = spawnSync("git", a, { cwd, encoding: "utf8" });
      assert.equal(r.status, 0, r.stderr);
      return (r.stdout ?? "").trim();
    };
    git("init", "-q");
    git("config", "user.email", "t@t");
    git("config", "user.name", "t");
    git("config", "commit.gpgsign", "false");
    writeFileSync(join(cwd, "other.txt"), "v1\n");
    git("add", "--all");
    git("commit", "-q", "-m", "base");
    writeFileSync(join(cwd, "other.txt"), "v2\n");
    git("add", "other.txt");
    const pi = {
      exec: async (cmd: string, args: string[]) => {
        const r = spawnSync(cmd, args, { cwd, encoding: "utf8" });
        return { stdout: r.stdout ?? "", stderr: r.stderr ?? "", code: r.status ?? 1, killed: false };
      },
    } as unknown as ExtensionAPI;
    const res = await updateWorkflowConfig({
      cwd, phase: "discussing", patch, confirm: async () => true,
      commit: (p, s) => commitScopedPath(pi, cwd, p, s),
    });
    assert.equal(res.ok, true, res.text);
    assert.match(res.text, /committed/);
    assert.equal(git("log", "-1", "--pretty=%s"), "chore: update workflow config");
    assert.equal(git("diff", "--name-only", "HEAD~1", "HEAD"), ".pi/workflow.json");
    assert.equal(git("diff", "--cached", "--name-only"), "other.txt");
    assert.deepEqual(JSON.parse(readFileSync(path, "utf8")), patch);
  });

  it("a hook rejection leaves the config written and returns the hook output", async () => {
    const { cwd, path } = setup({});
    const res = await updateWorkflowConfig({
      cwd, phase: "discussing", patch, confirm: async () => true,
      commit: async () => ({ kind: "failed", investigation: "HOOK SAYS NO" }),
    });
    assert.equal(res.ok, false);
    assert.match(res.text, /Wrote/);
    assert.match(res.text, /HOOK SAYS NO/);
    assert.doesNotMatch(res.text, /committed it/);
    assert.deepEqual(JSON.parse(readFileSync(path, "utf8")), patch);
  });

  it("a config identical to HEAD skips the commit and says so", async () => {
    const { cwd } = setup({});
    let args: string[] = [];
    const res = await updateWorkflowConfig({
      cwd, phase: "discussing", patch, confirm: async () => true,
      commit: async (p, s) => { args = [p, s]; return { kind: "skipped", investigation: "" }; },
    });
    assert.equal(res.ok, true);
    assert.match(res.text, /skipped/);
    assert.deepEqual(args, [".pi/workflow.json", "chore: update workflow config"]);
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
