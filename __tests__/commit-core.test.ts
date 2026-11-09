import { describe, it } from "vitest";
import assert from "node:assert/strict";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { buildCommitArgs, formatCommitSubject, runCommit } from "../extensions/commit-core.ts";

describe("buildCommitArgs (T1)", () => {
  it("returns commit -m <subject> followed by --signoff", () => {
    assert.deepEqual(buildCommitArgs("feat: add thing"), [
      "commit",
      "-m",
      "feat: add thing",
      "--signoff",
    ]);
  });

  it("adds -m <body> before --signoff when a body is given", () => {
    assert.deepEqual(buildCommitArgs("feat: add thing", "longer explanation"), [
      "commit",
      "-m",
      "feat: add thing",
      "-m",
      "longer explanation",
      "--signoff",
    ]);
  });

  it("appends --only -- <paths> when paths are given", () => {
    assert.deepEqual(buildCommitArgs("chore: x", undefined, ["a.ts", "b.ts"]), [
      "commit",
      "-m",
      "chore: x",
      "--signoff",
      "--only",
      "--",
      "a.ts",
      "b.ts",
    ]);
  });

  it("normalizes the subject through formatCommitSubject and keeps the body verbatim", () => {
    assert.deepEqual(
      buildCommitArgs("\n  feat: trimmed \nbody line\nmore", "multi\nline body"),
      ["commit", "-m", "feat: trimmed", "-m", "multi\nline body", "--signoff"],
    );
  });
});

describe("formatCommitSubject (T1)", () => {
  it("keeps only the first non-empty line, trimmed", () => {
    assert.equal(formatCommitSubject("\n\n  feat: hello \nbody line\nmore"), "feat: hello");
    assert.equal(formatCommitSubject("plain subject"), "plain subject");
  });

  it("caps the subject at 75 characters", () => {
    const long = "x".repeat(100);
    assert.equal(formatCommitSubject(long), "x".repeat(75));
    assert.equal(formatCommitSubject(long).length, 75);
  });

  it("returns an empty string when there is no non-empty line", () => {
    assert.equal(formatCommitSubject("\n   \n\t\n"), "");
  });
});

describe("runCommit (T1)", () => {
  it("executes git with the built --signoff args in cwd under the commit timeout", async () => {
    const calls: Array<{ cmd: string; args: string[]; opts: { cwd?: string; timeout?: number } }> = [];
    const pi = {
      exec: async (cmd: string, args: string[], opts: { cwd?: string; timeout?: number }) => {
        calls.push({ cmd, args, opts });
        return { stdout: "ok", stderr: "", code: 0, killed: false };
      },
    } as unknown as ExtensionAPI;

    const res = await runCommit(pi, "/repo", "feat: x", undefined, ["src/a.ts"]);

    assert.equal(calls.length, 1, "exactly one git invocation");
    assert.equal(calls[0]!.cmd, "git");
    assert.deepEqual(calls[0]!.args, [
      "commit",
      "-m",
      "feat: x",
      "--signoff",
      "--only",
      "--",
      "src/a.ts",
    ]);
    assert.equal(calls[0]!.opts.cwd, "/repo");
    assert.ok((calls[0]!.opts.timeout ?? 0) > 0, "a commit timeout budget is set");
    assert.equal(res.code, 0);
  });
});
