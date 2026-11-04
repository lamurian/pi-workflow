import { describe, it } from "vitest";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { classifyCommit, detectFailingStage, type GateInput } from "../extensions/commit-gate.ts";
import { commitAndGate } from "../extensions/git-commit-gate.ts";
import type { Behavior, ContractV2, TaskContract } from "../extensions/state.ts";

const BEHAVIOR: Behavior = {
  id: "T1",
  description: "first behavior",
  expectedOutput: "e1",
  kind: "test",
  status: "active",
};

function gateInput(overrides: Partial<GateInput> = {}): GateInput {
  return {
    headBefore: "headA",
    headAfter: "headA",
    commitExitCode: 1,
    commitOutput: "nothing added to commit but untracked files present (use \"git add\" to track)",
    timedOut: false,
    statusAfter: "?? foreign/x.txt",
    diffStat: "",
    timeoutMs: 300_000,
    ...overrides,
  };
}

describe("classifyCommit empty-index failure", () => {
  it("returns no-changes when the commit reported nothing added on a tree with only untracked entries", () => {
    const outcome = classifyCommit(BEHAVIOR, gateInput());
    assert.equal(outcome.kind, "no-changes", JSON.stringify(outcome));
  });

  it("the no-changes investigation states that nothing was staged (empty index)", () => {
    const outcome = classifyCommit(BEHAVIOR, gateInput());
    assert.equal(outcome.kind, "no-changes");
    if (outcome.kind !== "no-changes") return;
    assert.match(outcome.investigation, /nothing was staged/i);
    assert.match(outcome.investigation, /empty index/i);
  });

  it("still returns hook-rejected for a genuine hook failure with a dirty tree", () => {
    const outcome = classifyCommit(
      BEHAVIOR,
      gateInput({
        commitOutput: "golangci-lint run failed: 3 issues\nexit status 1",
        statusAfter: " M src/a.ts",
        diffStat: " src/a.ts | 2 +-",
      }),
    );
    assert.equal(outcome.kind, "hook-rejected");
    if (outcome.kind !== "hook-rejected") return;
    assert.match(outcome.hookOutput, /golangci-lint run failed/);
  });
});

describe("commitAndGate empty-index classification (real repo)", () => {
  it("returns no-changes, not hook-rejected, and leaves HEAD unchanged when only foreign untracked files exist", async () => {
    const repo = mkdtempSync(join(tmpdir(), "pi-empty-index-"));
    const gitIn = (...args: string[]): string => {
      const res = spawnSync("git", args, { cwd: repo, encoding: "utf8" });
      assert.equal(res.status, 0, `git ${args.join(" ")} failed: ${res.stderr ?? ""}`);
      return (res.stdout ?? "").trim();
    };
    gitIn("init", "-q");
    gitIn("config", "user.email", "empty@test");
    gitIn("config", "user.name", "empty");
    gitIn("config", "commit.gpgsign", "false");
    mkdirSync(join(repo, "src"), { recursive: true });
    writeFileSync(join(repo, "src", "mine.ts"), "mine v1\n");
    gitIn("add", "--all");
    gitIn("commit", "-q", "-m", "chore: baseline");
    const baseline = gitIn("rev-parse", "HEAD");
    // Foreign untracked work only: T1 owns src/mine.ts, which is untouched.
    mkdirSync(join(repo, "foreign"), { recursive: true });
    writeFileSync(join(repo, "foreign", "x.txt"), "someone else's work\n");
    const exec = async (command: string, args: string[]) => {
      const res = spawnSync(command, args, { cwd: repo, encoding: "utf8" });
      return { stdout: res.stdout ?? "", stderr: res.stderr ?? "", code: res.status ?? 1, killed: false };
    };
    const pi = { exec } as unknown as ExtensionAPI;

    const contract: ContractV2 = {
      title: "Empty Index Task",
      instruction: "shared context only",
      done: "green",
      sources: [{ path: "src/mine.ts", status: "M", tasks: ["T1"] }],
      tests: [],
      tasks: [
        { id: "T1", description: "mine", expectedOutput: ["lands the owned file"], status: "active" },
      ],
    };
    const task: TaskContract = {
      title: "Empty Index Task",
      instruction: "shared context only",
      files: [{ path: "src/mine.ts", status: "M" }],
      done: "green",
      behaviors: [BEHAVIOR],
    };

    const attempt = await commitAndGate(
      pi, repo, "feat(core): land T1", BEHAVIOR, task, 1, baseline, contract,
    );

    assert.equal(attempt.outcome?.kind, "no-changes", JSON.stringify(attempt.outcome));
    assert.equal(gitIn("rev-parse", "HEAD"), baseline, "HEAD is unchanged");
    assert.ok(
      gitIn("status", "--short").includes("foreign"),
      "the foreign untracked work stays on disk (status lists it, file or collapsed dir)",
    );
  });
});

describe("detectFailingStage ignores lefthook (skip) lines", () => {
  it("returns unknown when the only gofmt mention is a '(skip)' line", () => {
    const lefthookTail = [
      "│  line-limits (skip) no matching staged files",
      "│  gofmt (skip) no files for inspection",
      "│  secrets (skip) no matching staged files",
      "summary: (done in 0.00 seconds)",
    ].join("\n");
    assert.equal(detectFailingStage(lefthookTail), "unknown");
  });

  it("returns lint when a '(skip)' gofmt line is followed by a non-skip golangci-lint failure", () => {
    const output = [
      "│  gofmt (skip) no files for inspection",
      "│  golangci-lint (fail) 3 issues",
    ].join("\n");
    assert.equal(detectFailingStage(output), "lint");
  });
});
