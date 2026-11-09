import { describe, it } from "vitest";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { runSaveTask } from "../extensions/save-task-core.ts";
import type { WorkflowState } from "../extensions/state.ts";
import { TEST_EXTENSION_CHORE_SUBJECT } from "../extensions/test-extension-chore.ts";
import { detectTestSuites, projectFacts } from "../extensions/test-tool-detect.ts";
import { generateTestExtension } from "../extensions/test-extension-template.ts";
import { loadWorkflowConfig } from "../extensions/paths.ts";

const EXT = ".pi/extensions/test.ts";

/** What save_task finds at the extension path in the baseline commit. */
type Mode = "generate" | "regenerate" | "unchanged";

/**
 * Real temp git repo (go.mod manifest so save_task detects a suite) plus an
 * exec shim that spawns the real command, plus mock ctx/state/payload handles.
 *
 * @param mode - Extension state at the baseline commit.
 */
async function setup(mode: Mode): Promise<{
  repo: string;
  git: (...args: string[]) => string;
  pi: ExtensionAPI;
  ctx: ExtensionContext;
  state: WorkflowState;
}> {
  const repo = mkdtempSync(join(tmpdir(), "pi-save-chore-"));
  const git = (...args: string[]): string => {
    const res = spawnSync("git", args, { cwd: repo, encoding: "utf8" });
    assert.equal(res.status, 0, `git ${args.join(" ")} failed: ${res.stderr ?? ""}`);
    return (res.stdout ?? "").trim();
  };
  git("init", "-q");
  git("config", "user.email", "chore@test");
  git("config", "user.name", "chore");
  git("config", "commit.gpgsign", "false");
  mkdirSync(join(repo, "src"), { recursive: true });
  mkdirSync(join(repo, "tests"), { recursive: true });
  writeFileSync(join(repo, "go.mod"), "module example.com/save-chore\n");
  writeFileSync(join(repo, "src", "a.ts"), "export const a = 1;\n");
  writeFileSync(join(repo, "src", "other.ts"), "other v1\n");
  writeFileSync(join(repo, "tests", "a.test.ts"), "// test\n");
  if (mode !== "generate") {
    mkdirSync(join(repo, ".pi", "extensions"), { recursive: true });
    const fresh = generateTestExtension(detectTestSuites(projectFacts(repo)).suites);
    const content = mode === "regenerate" ? `${fresh}\n// stale\n` : fresh;
    writeFileSync(join(repo, EXT), content);
  }
  git("add", "--all");
  git("commit", "-q", "-m", "chore: baseline");
  const exec = async (cmd: string, args: string[]) => {
    const res = spawnSync(cmd, args, { cwd: repo, encoding: "utf8" });
    return {
      stdout: res.stdout ?? "",
      stderr: res.stderr ?? "",
      code: res.status ?? 1,
      killed: false,
    };
  };
  const pi = {
    appendEntry: () => {},
    getActiveTools: () => [],
    setActiveTools: () => {},
    exec,
  } as unknown as ExtensionAPI;
  const ctx = {
    cwd: repo,
    sessionManager: { getBranch: () => [] },
    ui: {
      notify: () => {},
      setStatus: () => {},
      setWidget: () => {},
      setTitle: () => {},
      theme: { fg: (_c: string, t: string) => t },
    },
  } as unknown as ExtensionContext;
  // Same detection inputs save_task uses, for the exact generated content.
  assert.ok((await loadWorkflowConfig(repo)) !== undefined);
  return { repo, git, pi, ctx, state: { phase: "discussing", specText: "t" } };
}

const PAYLOAD = {
  title: "T",
  instruction: "i",
  done: "d",
  sources: [{ path: "src/a.ts", tasks: ["T1"] }],
  tests: [{ path: "tests/a.test.ts", tasks: ["T1"] }],
  tasks: [{ id: "T1", description: "x", expectedOutput: ["y"], status: "active" }],
};

/** Stage leftover foreign work, as a halted unit attempt leaves it. */
function stageForeignWork(repo: string, git: (...args: string[]) => string): void {
  writeFileSync(join(repo, "src", "other.ts"), "other v2 (leftover)\n");
  git("add", "--", "src/other.ts");
}

describe("save_task test-extension chore commit (T12)", () => {
  for (const mode of ["generate", "regenerate"] as const) {
    it(`lands the signed-off chore commit when save_task ${mode}s the extension`, async () => {
      const { repo, git, pi, ctx, state } = await setup(mode);
      stageForeignWork(repo, git);

      const res = await runSaveTask(state, PAYLOAD, { caller: "agent", pi, ctx });

      assert.equal(res.ok, true, res.text);
      assert.equal(git("log", "-1", "--pretty=%s"), TEST_EXTENSION_CHORE_SUBJECT);
      assert.match(
        git("log", "-1", "--pretty=%B"),
        /^Signed-off-by: chore <chore@test>$/m,
        "the chore commit carries the Signed-off-by trailer",
      );
      assert.equal(
        git("diff", "--name-only", "HEAD~1", "HEAD"),
        EXT,
        "the chore commit contains only the generated extension",
      );
      assert.equal(
        git("diff", "--cached", "--name-only"),
        "src/other.ts",
        "the foreign staged path stays staged",
      );
      assert.equal(git("show", ":src/other.ts"), "other v2 (leftover)", "staged content intact");
    });
  }

  it("lands no commit when unchanged and reports the chore outcome in the result text", async () => {
    const { repo, git, pi, ctx, state } = await setup("unchanged");
    stageForeignWork(repo, git);
    const headBefore = git("rev-parse", "HEAD");

    const res = await runSaveTask(state, PAYLOAD, { caller: "agent", pi, ctx });

    assert.equal(res.ok, true, res.text);
    assert.equal(git("rev-parse", "HEAD"), headBefore, "HEAD did not move");
    assert.equal(
      git("diff", "--cached", "--name-only"),
      "src/other.ts",
      "foreign work still staged",
    );
    assert.match(
      res.text,
      /chore commit: skipped/,
      "the save_task result text reports the chore commit outcome",
    );
  });
});
