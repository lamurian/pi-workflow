// T2: landed deletes never trip later tasks. classifyBaselineDiff skips the
// delete-ownership check for a D whose path is absent from the pending-vs-HEAD
// set (it already landed since the baseline); git-commit-gate computes that
// set for the v2 teeth classification. Verified against a real temp git repo.

import { describe, it } from "vitest";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { classifyBaselineDiff } from "../extensions/contract-guard-diff.ts";
import { commitAndGate } from "../extensions/git-commit-gate.ts";
import type { DeclaredFile } from "../extensions/contract-guard-core.ts";
import type { Behavior, ContractV2, TaskContract } from "../extensions/state.ts";

/** T1 owns the D path; T2 is the committing task under test. */
const FILES: DeclaredFile[] = [
  { path: "src/t1-owned.ts", status: "D", tasks: ["T1"] },
  { path: "src/t2-owned.ts", status: "M", tasks: ["T2"] },
];

/** Baseline name-status line: a delete of another task's declared path. */
const T1_DELETE = "D\tsrc/t1-owned.ts\n";

describe("classifyBaselineDiff pending-vs-HEAD skip (T2)", () => {
  it("a D owned by another task absent from the pending set never violates", () => {
    const result = classifyBaselineDiff({
      nameStatus: T1_DELETE,
      files: FILES,
      baselineRef: "base123",
      taskId: "T2",
      pendingVsHead: new Set(["src/t2-owned.ts"]),
    });
    assert.deepEqual(
      result.violations,
      [],
      `a landed delete must not trip, got ${JSON.stringify(result.violations)}`,
    );
    assert.ok(
      !result.violations.some((v) => /unauthorized delete/.test(v)),
      "no unauthorized-delete violation for an already-landed D",
    );
  });

  it("a D owned by another task still pending versus HEAD still violates", () => {
    const result = classifyBaselineDiff({
      nameStatus: T1_DELETE,
      files: FILES,
      baselineRef: "base123",
      taskId: "T2",
      pendingVsHead: new Set(["src/t1-owned.ts"]),
    });
    assert.equal(result.violations.length, 1, JSON.stringify(result.violations));
    assert.match(result.violations[0]!, /unauthorized delete/);
    assert.match(result.violations[0]!, /src\/t1-owned\.ts/);
    assert.match(result.violations[0]!, /T2/, "the committing task is named");
  });

  it("without a pending set the unauthorized delete still trips (behavior unchanged)", () => {
    const result = classifyBaselineDiff({
      nameStatus: T1_DELETE,
      files: FILES,
      baselineRef: "base123",
      taskId: "T2",
    });
    assert.equal(result.violations.length, 1, JSON.stringify(result.violations));
    assert.match(result.violations[0]!, /unauthorized delete/);
    assert.match(result.violations[0]!, /src\/t1-owned\.ts/);
  });

  it("an undeclared path landed since the baseline still violates", () => {
    const result = classifyBaselineDiff({
      nameStatus: "D\tsecrets.env\n",
      files: FILES,
      baselineRef: "base123",
      taskId: "T2",
      pendingVsHead: new Set<string>(),
    });
    assert.equal(result.violations.length, 1, JSON.stringify(result.violations));
    assert.match(result.violations[0]!, /undeclared/i);
    assert.match(result.violations[0]!, /secrets\.env/);
  });
});

/** A real temp git repo with two tracked files committed as the baseline. */
function mkRepo(): {
  repo: string;
  gitIn: (...args: string[]) => string;
  baseline: string;
  pi: ExtensionAPI;
} {
  const repo = mkdtempSync(join(tmpdir(), "pi-landed-delete-"));
  const gitIn = (...args: string[]): string => {
    const res = spawnSync("git", args, { cwd: repo, encoding: "utf8" });
    assert.equal(res.status, 0, `git ${args.join(" ")} failed: ${res.stderr ?? ""}`);
    return (res.stdout ?? "").trim();
  };
  gitIn("init", "-q");
  gitIn("config", "user.email", "landed@test");
  gitIn("config", "user.name", "landed");
  gitIn("config", "commit.gpgsign", "false");
  mkdirSync(join(repo, "src"), { recursive: true });
  writeFileSync(join(repo, "src", "t1-owned.ts"), "t1 v1\n");
  writeFileSync(join(repo, "src", "t2-owned.ts"), "t2 v1\n");
  gitIn("add", "--all");
  gitIn("commit", "-q", "-m", "chore: baseline");
  const baseline = gitIn("rev-parse", "HEAD");
  const exec = async (command: string, args: string[]) => {
    const res = spawnSync(command, args, { cwd: repo, encoding: "utf8" });
    return {
      stdout: res.stdout ?? "",
      stderr: res.stderr ?? "",
      code: res.status ?? 1,
      killed: false,
    };
  };
  return { repo, gitIn, baseline, pi: { exec } as unknown as ExtensionAPI };
}

const CONTRACT: ContractV2 = {
  title: "Landed Delete Task",
  instruction: "shared context only",
  done: "green",
  sources: [
    { path: "src/t1-owned.ts", status: "D", tasks: ["T1"] },
    { path: "src/t2-owned.ts", status: "M", tasks: ["T2"] },
  ],
  tests: [],
  tasks: [
    { id: "T1", description: "delete t1-owned", expectedOutput: ["t1-owned is gone"], status: "active" },
    { id: "T2", description: "modify t2-owned", expectedOutput: ["t2-owned is modified"], status: "active" },
  ],
};

const T2_BEHAVIOR: Behavior = {
  id: "T2",
  description: "modify src/t2-owned.ts",
  expectedOutput: "src/t2-owned.ts modified at HEAD",
  kind: "test",
  status: "active",
};

const TASK: TaskContract = {
  title: "Landed Delete Task",
  instruction: "shared context only",
  files: [
    { path: "src/t1-owned.ts", status: "D" },
    { path: "src/t2-owned.ts", status: "M" },
  ],
  done: "green",
  behaviors: [T2_BEHAVIOR],
};

describe("commitAndGate after a T1-owned deletion landed since the baseline (T2)", () => {
  it("lands T2's owned change: null outcome, HEAD advances, T1's delete stays landed", async () => {
    const { repo, gitIn, baseline, pi } = mkRepo();
    // T1 commits its owned deletion AFTER the baseline was recorded.
    gitIn("rm", "-q", "src/t1-owned.ts");
    gitIn("commit", "-q", "-m", "feat: delete t1-owned");
    const headAfterT1 = gitIn("rev-parse", "HEAD");
    assert.notEqual(headAfterT1, baseline, "T1's commit moved HEAD past the baseline");
    // T2's own pending work: modify its owned file in the worktree.
    writeFileSync(join(repo, "src", "t2-owned.ts"), "t2 v2\n");

    const attempt = await commitAndGate(
      pi,
      repo,
      "feat(core): update t2-owned",
      T2_BEHAVIOR,
      TASK,
      1,
      baseline,
      CONTRACT,
    );

    assert.equal(attempt.outcome, null, JSON.stringify(attempt.outcome));
    assert.notEqual(gitIn("rev-parse", "HEAD"), headAfterT1, "T2's commit advanced HEAD");
    assert.equal(gitIn("show", "HEAD:src/t2-owned.ts"), "t2 v2", "T2's owned change landed");
    assert.equal(
      gitIn("ls-tree", "HEAD", "--", "src/t1-owned.ts"),
      "",
      "T1's deletion stays landed at HEAD",
    );
  });
});
