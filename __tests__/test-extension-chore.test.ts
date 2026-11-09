import { describe, it } from "vitest";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
  TEST_EXTENSION_CHORE_SUBJECT,
  commitTestExtensionChore,
} from "../extensions/test-extension-chore.ts";

const EXT = ".pi/extensions/test.ts";

interface ExecEntry {
  cmd: string;
  args: string[];
}

/**
 * A real temp git repo plus an exec shim that records every call.
 *
 * @param trackExtension - Whether the baseline commit already tracks the extension.
 */
function setupRepo(trackExtension = true): {
  repo: string;
  gitIn: (...args: string[]) => string;
  pi: ExtensionAPI;
  execLog: ExecEntry[];
} {
  const repo = mkdtempSync(join(tmpdir(), "pi-chore-"));
  const gitIn = (...args: string[]): string => {
    const res = spawnSync("git", args, { cwd: repo, encoding: "utf8" });
    assert.equal(res.status, 0, `git ${args.join(" ")} failed: ${res.stderr ?? ""}`);
    return (res.stdout ?? "").trim();
  };
  gitIn("init", "-q");
  gitIn("config", "user.email", "chore@test");
  gitIn("config", "user.name", "chore");
  gitIn("config", "commit.gpgsign", "false");
  mkdirSync(join(repo, "src"), { recursive: true });
  writeFileSync(join(repo, "src", "other.ts"), "other v1\n");
  if (trackExtension) {
    mkdirSync(join(repo, ".pi", "extensions"), { recursive: true });
    writeFileSync(join(repo, EXT), "// generated v1\n");
  }
  gitIn("add", "--all");
  gitIn("commit", "-q", "-m", "chore: baseline");
  const execLog: ExecEntry[] = [];
  const exec = async (cmd: string, args: string[]) => {
    execLog.push({ cmd, args });
    const res = spawnSync(cmd, args, { cwd: repo, encoding: "utf8" });
    return { stdout: res.stdout ?? "", stderr: res.stderr ?? "", code: res.status ?? 1, killed: false };
  };
  return { repo, gitIn, pi: { exec } as unknown as ExtensionAPI, execLog };
}

/** Stage leftover foreign work, as a halted unit attempt leaves it. */
function stageForeignWork(repo: string, gitIn: (...args: string[]) => string): void {
  writeFileSync(join(repo, "src", "other.ts"), "other v2 (leftover)\n");
  gitIn("add", "--", "src/other.ts");
}

describe("commitTestExtensionChore (bug 2)", () => {
  it("lands a commit containing only the extension while another path is staged, leaving that path staged", async () => {
    const { repo, gitIn, pi } = setupRepo();
    stageForeignWork(repo, gitIn);
    writeFileSync(join(repo, EXT), "// generated v2\n");

    const result = await commitTestExtensionChore(pi, repo, EXT);

    assert.equal(result.kind, "landed", result.investigation);
    assert.equal(gitIn("log", "-1", "--pretty=%s"), TEST_EXTENSION_CHORE_SUBJECT);
    assert.match(
      gitIn("log", "-1", "--pretty=%B"),
      /^Signed-off-by: chore <chore@test>$/m,
      "the chore commit carries the Signed-off-by trailer from user.name/user.email",
    );
    assert.equal(
      gitIn("diff", "--name-only", "HEAD~1", "HEAD"),
      EXT,
      "the chore commit's diff against its parent contains only the extension",
    );
    assert.equal(
      gitIn("diff", "--cached", "--name-only"),
      "src/other.ts",
      "the foreign path is still staged after the chore commit",
    );
    assert.equal(gitIn("show", ":src/other.ts"), "other v2 (leftover)", "staged content intact");
    assert.equal(readFileSync(join(repo, "src", "other.ts"), "utf8"), "other v2 (leftover)\n");
  });

  it("returns skipped and leaves HEAD unmoved when the extension is unchanged, even with other paths staged", async () => {
    const { repo, gitIn, pi } = setupRepo();
    stageForeignWork(repo, gitIn);
    const headBefore = gitIn("rev-parse", "HEAD");

    const result = await commitTestExtensionChore(pi, repo, EXT);

    assert.equal(result.kind, "skipped", result.investigation);
    assert.equal(gitIn("rev-parse", "HEAD"), headBefore, "HEAD did not move");
    assert.equal(gitIn("diff", "--cached", "--name-only"), "src/other.ts", "foreign work still staged");
  });

  it("lands a previously untracked, newly generated extension", async () => {
    const { repo, gitIn, pi } = setupRepo(false);
    mkdirSync(join(repo, ".pi", "extensions"), { recursive: true });
    writeFileSync(join(repo, EXT), "// generated fresh\n");

    const result = await commitTestExtensionChore(pi, repo, EXT);

    assert.equal(result.kind, "landed", result.investigation);
    assert.equal(gitIn("show", `HEAD:${EXT}`), "// generated fresh");
    assert.equal(gitIn("diff", "--name-only", "HEAD~1", "HEAD"), EXT);
  });

  it("runs git commit with argv commit -m <subject> --signoff --only -- .pi/extensions/test.ts", async () => {
    const { repo, pi, execLog } = setupRepo();
    writeFileSync(join(repo, EXT), "// generated v2\n");

    await commitTestExtensionChore(pi, repo, EXT);

    const commits = execLog.filter((e) => e.cmd === "git" && e.args[0] === "commit");
    assert.equal(commits.length, 1, "exactly one commit invocation");
    assert.deepEqual(commits[0]!.args, [
      "commit",
      "-m",
      "chore: regenerate test extension",
      "--signoff",
      "--only",
      "--",
      ".pi/extensions/test.ts",
    ]);
  });
});
