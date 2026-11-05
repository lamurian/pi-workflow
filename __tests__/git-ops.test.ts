import { describe, it } from "vitest";
import assert from "node:assert/strict";
import { readCommitsSinceBaseline } from "../extensions/git-ops.ts";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

interface ExecCall {
  cmd: string;
  args: string[];
}

/** pi mock whose exec records every call and replays a canned result. */
function execSpy(
  handler: (cmd: string, args: string[]) => { stdout: string; code: number },
): { pi: ExtensionAPI; calls: ExecCall[] } {
  const calls: ExecCall[] = [];
  const pi = {
    exec: async (cmd: string, args: string[]): Promise<unknown> => {
      calls.push({ cmd, args });
      return handler(cmd, args);
    },
  } as unknown as ExtensionAPI;
  return { pi, calls };
}

describe("readCommitsSinceBaseline (T4)", () => {
  it("returns null and never calls exec when baselineHead starts with '-'", async () => {
    const { pi, calls } = execSpy(() => ({ stdout: "feat(core): pwned\n", code: 0 }));
    const result = await readCommitsSinceBaseline(
      pi,
      "/tmp/repo",
      "--upload-pack=touch /tmp/pwned",
    );
    assert.equal(result, null, "a '-'-prefixed baselineHead returns null");
    assert.equal(calls.length, 0, "git never runs for an option-shaped baselineHead");

    const dashShort = await readCommitsSinceBaseline(pi, "/tmp/repo", "-p");
    assert.equal(dashShort, null, "short-flag shaped baselines also return null");
    assert.equal(calls.length, 0, "still no exec call after the second attempt");
  });

  it("runs `git log <baselineHead>..HEAD --pretty=%s` and returns trimmed non-empty subjects for a normal ref", async () => {
    const { pi, calls } = execSpy((cmd, args) => {
      if (cmd === "git" && args[0] === "log") {
        return { stdout: "feat(core): add T1\n\n   fix(core): retry T2   \n", code: 0 };
      }
      return { stdout: "", code: 0 };
    });
    const result = await readCommitsSinceBaseline(pi, "/tmp/repo", "base123");
    assert.deepEqual(
      calls,
      [{ cmd: "git", args: ["log", "base123..HEAD", "--pretty=%s"] }],
      "the exact git log invocation for a normal ref",
    );
    assert.deepEqual(
      result,
      ["feat(core): add T1", "fix(core): retry T2"],
      "trimmed non-empty subjects, blank lines dropped",
    );
  });
});
