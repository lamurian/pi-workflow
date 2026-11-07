import { describe, it } from "vitest";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { refreshTestExtensionAfterLanding } from "../extensions/test-extension-refresh.ts";
import { TEST_EXTENSION_CHORE_SUBJECT } from "../extensions/test-extension-chore.ts";
import { GENERATED_MARKER } from "../extensions/test-extension-constants.ts";
import { generateTestExtension } from "../extensions/test-extension-template.ts";
import type { TestSuite } from "../extensions/test-tool-detect.ts";

const EXT = ".pi/extensions/test.ts";

function setup() {
  const repo = mkdtempSync(join(tmpdir(), "pi-refresh-"));
  const git = (...args: string[]): string => {
    const res = spawnSync("git", args, { cwd: repo, encoding: "utf8" });
    assert.equal(res.status, 0, res.stderr);
    return (res.stdout ?? "").trim();
  };
  git("init", "-q");
  git("config", "user.email", "r@test");
  git("config", "user.name", "r");
  git("config", "commit.gpgsign", "false");
  mkdirSync(join(repo, ".pi", "extensions"), { recursive: true });
  writeFileSync(join(repo, EXT), `${GENERATED_MARKER}\n// stale\n`);
  git("add", "--all");
  git("commit", "-q", "-m", "chore: baseline");
  const execLog: string[] = [];
  const exec = async (cmd: string, args: string[]) => {
    execLog.push(cmd);
    const res = spawnSync(cmd, args, { cwd: repo, encoding: "utf8" });
    return { stdout: res.stdout ?? "", stderr: res.stderr ?? "", code: res.status ?? 1, killed: false };
  };
  return { repo, git, execLog, pi: { exec } as unknown as ExtensionAPI };
}

const suites = [{ label: "npm run test", command: "npm", args: ["run", "test"], cwd: "." }] as unknown as TestSuite[];

describe("refreshTestExtensionAfterLanding", () => {
  it("rewrites from a child-process generator and lands the chore commit, then no-ops", async () => {
    const { repo, git, execLog, pi } = setup();
    const state = { testTool: { source: "detected", suites, fullSuites: suites } } as never;
    const first = await refreshTestExtensionAfterLanding(pi, repo, state);
    assert.equal(first.kind, "landed", first.investigation);
    assert.ok(execLog.includes("node"), "generator ran in a child node process");
    assert.equal(readFileSync(join(repo, EXT), "utf8"), generateTestExtension(suites));
    assert.equal(git("log", "-1", "--format=%s"), TEST_EXTENSION_CHORE_SUBJECT);
    const head = git("rev-parse", "HEAD");

    const second = await refreshTestExtensionAfterLanding(pi, repo, state);
    assert.equal(second.kind, "unchanged");
    assert.equal(git("rev-parse", "HEAD"), head);
  });
});
