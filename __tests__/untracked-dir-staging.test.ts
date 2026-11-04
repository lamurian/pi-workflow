import { describe, it } from "vitest";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { readChangedPaths } from "../extensions/git-ops.ts";
import { commitAndGate } from "../extensions/git-commit-gate.ts";
import type { Behavior, ContractV2, TaskContract } from "../extensions/state.ts";

/** A real temp git repo with one tracked file committed as the baseline. */
function mkRepo(): {
  repo: string;
  gitIn: (...args: string[]) => string;
  baseline: string;
  pi: ExtensionAPI;
} {
  const repo = mkdtempSync(join(tmpdir(), "pi-untracked-dir-"));
  const gitIn = (...args: string[]): string => {
    const res = spawnSync("git", args, { cwd: repo, encoding: "utf8" });
    assert.equal(res.status, 0, `git ${args.join(" ")} failed: ${res.stderr ?? ""}`);
    return (res.stdout ?? "").trim();
  };
  gitIn("init", "-q");
  gitIn("config", "user.email", "untracked@test");
  gitIn("config", "user.name", "untracked");
  gitIn("config", "commit.gpgsign", "false");
  mkdirSync(join(repo, "src"), { recursive: true });
  writeFileSync(join(repo, "src", "keep.ts"), "keep v1\n");
  gitIn("add", "--all");
  gitIn("commit", "-q", "-m", "chore: baseline");
  const baseline = gitIn("rev-parse", "HEAD");
  const exec = async (command: string, args: string[]) => {
    const res = spawnSync(command, args, { cwd: repo, encoding: "utf8" });
    return { stdout: res.stdout ?? "", stderr: res.stderr ?? "", code: res.status ?? 1, killed: false };
  };
  return { repo, gitIn, baseline, pi: { exec } as unknown as ExtensionAPI };
}

/** T1 owns newpkg/x.go — a new file inside a brand-new untracked directory. */
const UNTRACKED_DIR_CONTRACT: ContractV2 = {
  title: "Untracked Dir Task",
  instruction: "shared context only",
  done: "green",
  sources: [{ path: "newpkg/x.go", tasks: ["T1"] }],
  tests: [],
  tasks: [
    { id: "T1", description: "add x", expectedOutput: ["lands the new file"], status: "active" },
  ],
};

const BEHAVIOR: Behavior = {
  id: "T1",
  description: "add newpkg/x.go",
  expectedOutput: "newpkg/x.go exists at HEAD",
  kind: "test",
  status: "active",
};

const TASK: TaskContract = {
  title: "Untracked Dir Task",
  instruction: "shared context only",
  files: [{ path: "newpkg/x.go" }],
  done: "green",
  behaviors: [BEHAVIOR],
};

describe("readChangedPaths expands untracked directories", () => {
  it("lists each file inside a fully untracked directory individually, never the collapsed dir entry", async () => {
    const { repo, pi } = mkRepo();
    mkdirSync(join(repo, "newpkg"), { recursive: true });
    writeFileSync(join(repo, "newpkg", "a.go"), "package newpkg\n");
    writeFileSync(join(repo, "newpkg", "b.go"), "package newpkg\n");

    const paths = await readChangedPaths(pi, repo);

    assert.ok(paths.includes("newpkg/a.go"), `missing newpkg/a.go in ${JSON.stringify(paths)}`);
    assert.ok(paths.includes("newpkg/b.go"), `missing newpkg/b.go in ${JSON.stringify(paths)}`);
    assert.ok(
      !paths.includes("newpkg/"),
      `the collapsed dir entry must never appear, got ${JSON.stringify(paths)}`,
    );
  });

  it("still lists a modified tracked file by its path", async () => {
    const { repo, pi } = mkRepo();
    writeFileSync(join(repo, "src", "keep.ts"), "keep v2\n");

    const paths = await readChangedPaths(pi, repo);

    assert.ok(paths.includes("src/keep.ts"), `missing src/keep.ts in ${JSON.stringify(paths)}`);
  });
});

describe("commitAndGate stages new files inside untracked directories", () => {
  it("stages owned files that live only in a brand-new directory and lands them at HEAD", async () => {
    const { repo, gitIn, baseline, pi } = mkRepo();
    mkdirSync(join(repo, "newpkg"), { recursive: true });
    writeFileSync(join(repo, "newpkg", "x.go"), "package newpkg\n");
    const calls: Array<{ cmd: string; args: string[] }> = [];
    const exec = async (command: string, args: string[]) => {
      const res = spawnSync(command, args, { cwd: repo, encoding: "utf8" });
      if (command === "git") calls.push({ cmd: command, args });
      return { stdout: res.stdout ?? "", stderr: res.stderr ?? "", code: res.status ?? 1, killed: false };
    };
    const shim = { exec } as unknown as ExtensionAPI;

    const attempt = await commitAndGate(
      shim,
      repo,
      "feat(pkg): add x",
      BEHAVIOR,
      TASK,
      1,
      baseline,
      UNTRACKED_DIR_CONTRACT,
    );

    assert.equal(attempt.outcome, null, JSON.stringify(attempt.outcome));
    assert.ok(
      calls.some((c) => c.args[0] === "add" && c.args.includes("newpkg/x.go")),
      "the owned new file is staged via git add -- <path>",
    );
    assert.equal(gitIn("show", "HEAD:newpkg/x.go"), "package newpkg", "the file lands at HEAD");
  });
});
