import { describe, it } from "vitest";
import assert from "node:assert/strict";
import { execFile, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
  createChildProcessGenerator,
  refreshTestExtensionAfterLanding,
} from "../extensions/test-extension-refresh.ts";
import { GENERATED_MARKER } from "../extensions/test-extension-constants.ts";
import { generateTestExtension } from "../extensions/test-extension-template.ts";
import type { TestSuite } from "../extensions/test-tool-detect.ts";

const git = (cwd: string, ...args: string[]) =>
  spawnSync("git", args, { cwd, encoding: "utf8" });

function makePi(): ExtensionAPI {
  return {
    exec: (cmd: string, args: string[], opts?: { cwd?: string }) =>
      new Promise((done) => {
        execFile(cmd, args, { cwd: opts?.cwd, encoding: "utf8" }, (err, stdout, stderr) => {
          const code = err ? (typeof err.code === "number" ? err.code : 1) : 0;
          done({ code, stdout: stdout ?? "", stderr: stderr ?? "", killed: false });
        });
      }),
  } as unknown as ExtensionAPI;
}

function makeRepo(content: string): string {
  const dir = mkdtempSync(join(tmpdir(), "refresh-"));
  git(dir, "init", "-q");
  git(dir, "config", "user.email", "t@t");
  git(dir, "config", "user.name", "t");
  git(dir, "config", "core.hooksPath", "/dev/null");
  mkdirSync(join(dir, ".pi", "extensions"), { recursive: true });
  writeFileSync(join(dir, ".pi", "extensions", "test.ts"), content);
  git(dir, "add", "-A");
  git(dir, "commit", "-qm", "init");
  return dir;
}

const suites = [{ label: "unit", command: "npm", args: ["test"], cwd: "." }] as unknown as TestSuite[];
const state = { testTool: { source: "detected", suites, fullSuites: suites } } as never;
const head = (dir: string) => git(dir, "rev-parse", "HEAD").stdout.trim();

describe("refreshTestExtensionAfterLanding", () => {
  it("rewrites and commits the chore when the fresh output differs", async () => {
    const dir = makeRepo(`// ${GENERATED_MARKER}\nold\n`);
    const before = head(dir);
    const fresh = `// ${GENERATED_MARKER}\nnew\n`;
    const res = await refreshTestExtensionAfterLanding(makePi(), dir, state, async () => fresh);
    assert.equal(res.kind, "landed");
    assert.equal(readFileSync(join(dir, ".pi/extensions/test.ts"), "utf8"), fresh);
    assert.notEqual(head(dir), before);
    assert.equal(git(dir, "log", "-1", "--format=%s").stdout.trim(), "chore: regenerate test extension");
  });

  it("writes nothing and commits nothing when output is unchanged", async () => {
    const same = `// ${GENERATED_MARKER}\nsame\n`;
    const dir = makeRepo(same);
    const before = head(dir);
    let execCalls = 0;
    const pi = { exec: async () => (execCalls++, { code: 0, stdout: "", stderr: "" }) } as unknown as ExtensionAPI;
    const res = await refreshTestExtensionAfterLanding(pi, dir, state, async () => same);
    assert.equal(res.kind, "unchanged");
    assert.equal(execCalls, 0);
    assert.equal(head(dir), before);
  });

  it("child-process generator matches the committed template output", { timeout: 30000 }, async () => {
    const dir = mkdtempSync(join(tmpdir(), "refresh-gen-"));
    const out = await createChildProcessGenerator(makePi(), dir)(suites);
    assert.equal(out, generateTestExtension(suites));
    assert.ok(!existsSync(join(dir, ".pi")));
  });
});
