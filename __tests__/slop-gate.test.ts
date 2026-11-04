import { afterEach, describe, it } from "vitest";
import assert from "node:assert/strict";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, isAbsolute, join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { resolveSlopGate, runSlopGate } from "../extensions/slop-gate.ts";
import { resetWorkflowConfigCache } from "../extensions/paths.ts";
import type { SlopConfig } from "../extensions/slop-config.ts";

// ─── Harness ──────────────────────────────────────────────────────────────────

const tempDirs: string[] = [];

afterEach(() => {
  while (tempDirs.length > 0) {
    rmSync(tempDirs.pop()!, { recursive: true, force: true });
  }
});

/** Fresh empty project root under the OS temp dir (registered for cleanup). */
function tmpCwd(): string {
  const dir = mkdtempSync(join(tmpdir(), "slop-gate-"));
  tempDirs.push(dir);
  return dir;
}

/** Resolved config with one mode overridden. */
function config(
  mode: SlopConfig["mode"],
  overrides: Partial<SlopConfig> = {},
): SlopConfig {
  return {
    mode,
    fetchFallback: true,
    codeFailBelow: 80,
    proseGate: 25,
    ...overrides,
  };
}

interface ExecCall {
  cmd: string;
  args: string[];
}

interface CommandResult {
  code?: number;
  stdout: string;
}

/** Scripted answers for every command the gate may run. */
interface MockScript {
  /** `which <name>` exit codes; missing names exit 1. */
  which?: Record<string, number>;
  /** stdout of `git diff --cached --name-only --diff-filter=d`. */
  nameOnly?: string;
  /** stdout of `git diff --cached -U0`. */
  u0?: string;
  /** Answer for `git show HEAD:<path>` (path has the HEAD: prefix stripped). */
  show?: (path: string) => CommandResult;
  /** Answer for the aislop scan run. */
  aislop?: CommandResult;
  /** Answer for `zero-slop score <path>` (absolute paths are temp files). */
  score?: (path: string) => CommandResult;
}

/**
 * Mock ExtensionAPI: every exec call is recorded, git/which/scanner commands
 * answer from the script, and absolute zero-slop score targets have their
 * on-disk content captured at call time (before the gate cleans them up).
 */
function mockPi(
  script: MockScript = {},
): ExtensionAPI & { calls: ExecCall[]; scoredFiles: Map<string, string> } {
  const calls: ExecCall[] = [];
  const scoredFiles = new Map<string, string>();
  const ok = (stdout: string) => ({ stdout, stderr: "", code: 0, killed: false });
  const pi = {
    exec: async (cmd: string, args: string[]) => {
      calls.push({ cmd, args });
      if (cmd === "which") {
        return {
          stdout: "",
          stderr: "",
          code: script.which?.[args[0] ?? ""] ?? 1,
          killed: false,
        };
      }
      if (cmd === "git") {
        if (args[0] === "diff" && args.includes("--name-only")) {
          return ok(script.nameOnly ?? "");
        }
        if (args[0] === "diff" && args.includes("-U0")) {
          return ok(script.u0 ?? "");
        }
        if (args[0] === "show") {
          const ref = args[1] ?? "";
          const path = ref.startsWith("HEAD:") ? ref.slice(5) : ref;
          if (script.show) {
            const r = script.show(path);
            return { stdout: r.stdout, stderr: "", code: r.code ?? 0, killed: false };
          }
          return { stdout: "", stderr: "fatal", code: 128, killed: false };
        }
      }
      if (cmd === "aislop") {
        const r = script.aislop ?? { stdout: "" };
        return { stdout: r.stdout, stderr: "", code: r.code ?? 0, killed: false };
      }
      if (cmd === "zero-slop" && args[0] === "score") {
        const path = args[1] ?? "";
        if (isAbsolute(path)) scoredFiles.set(path, readFileSync(path, "utf-8"));
        const r = script.score?.(path) ?? { stdout: "" };
        return { stdout: r.stdout, stderr: "", code: r.code ?? 0, killed: false };
      }
      return { stdout: "", stderr: "", code: 1, killed: false };
    },
    calls,
    scoredFiles,
  };
  return pi as unknown as ExtensionAPI & {
    calls: ExecCall[];
    scoredFiles: Map<string, string>;
  };
}

/** A minimal valid `git diff --cached -U0` touching one prose file. */
const U0_DIFF = [
  "diff --git a/docs/guide.md b/docs/guide.md",
  "--- a/docs/guide.md",
  "+++ b/docs/guide.md",
  "@@ -0,0 +1,2 @@",
  "+# one",
  "+# two",
  "",
].join("\n");

// ─── runSlopGate ─────────────────────────────────────────────────────────────

describe("runSlopGate", () => {
  it("mode off makes no exec calls and returns clean", async () => {
    const pi = mockPi({ nameOnly: "src/a.ts\nREADME.md\n" });

    const v = await runSlopGate(pi, tmpCwd(), config("off"));

    assert.equal(v.kind, "clean");
    assert.deepEqual(pi.calls, []);
  });

  it("returns clean without resolving any tool when git diff --cached --name-only --diff-filter=d lists no code or prose paths", async () => {
    const pi = mockPi({ nameOnly: "package.json\nlogo.png\nMakefile\n" });

    const v = await runSlopGate(pi, tmpCwd(), config("hard"));

    assert.equal(v.kind, "clean");
    assert.deepEqual(pi.calls, [
      {
        cmd: "git",
        args: ["diff", "--cached", "--name-only", "--diff-filter=d"],
      },
    ]);
  });

  it("runs <aislop argv> scan --staged --json only when code paths are staged", async () => {
    const proseOnly = mockPi({
      nameOnly: "README.md\n",
      which: { python3: 0, "zero-slop": 0 },
      score: () => ({ stdout: "Writing score: 10/100" }),
    });
    await runSlopGate(proseOnly, tmpCwd(), config("advisory"));
    assert.ok(
      !proseOnly.calls.some((c) => c.cmd === "aislop"),
      "no aislop exec when only prose is staged",
    );

    const withCode = mockPi({
      nameOnly: "src/a.ts\n",
      which: { aislop: 0 },
      aislop: { stdout: JSON.stringify({ score: 95, diagnostics: [] }) },
    });
    await runSlopGate(withCode, tmpCwd(), config("advisory"));
    assert.deepEqual(
      withCode.calls.find((c) => c.cmd === "aislop"),
      { cmd: "aislop", args: ["scan", "--staged", "--json"] },
    );
  });

  it("runs <zero-slop argv> score <path> once per staged prose path", async () => {
    const pi = mockPi({
      nameOnly: "README.md\ndocs/guide.md\n",
      which: { python3: 0, "zero-slop": 0 },
      score: () => ({ stdout: "Writing score: 10/100" }),
    });

    const v = await runSlopGate(pi, tmpCwd(), config("advisory"));

    const scoreCalls = pi.calls.filter((c) => c.cmd === "zero-slop");
    assert.deepEqual(scoreCalls, [
      { cmd: "zero-slop", args: ["score", "README.md"] },
      { cmd: "zero-slop", args: ["score", "docs/guide.md"] },
    ]);
    assert.notEqual(v.kind, "block");
  });

  it("in baseline mode reads git diff --cached -U0 and scores the HEAD version from a temp file written from git show HEAD:<path>", async () => {
    const pi = mockPi({
      nameOnly: "docs/guide.md\n",
      u0: U0_DIFF,
      show: (path) =>
        path === "docs/guide.md"
          ? { code: 0, stdout: "# HEAD content\n" }
          : { code: 128, stdout: "" },
      which: { python3: 0, "zero-slop": 0 },
      score: (path) => ({
        stdout: `Writing score: ${isAbsolute(path) ? 90 : 60}/100`,
      }),
    });

    const v = await runSlopGate(pi, tmpCwd(), config("baseline"));

    assert.ok(
      pi.calls.some(
        (c) => c.cmd === "git" && c.args.join(" ") === "diff --cached -U0",
      ),
      "baseline mode reads the -U0 diff",
    );
    assert.ok(
      pi.calls.some(
        (c) =>
          c.cmd === "git" &&
          c.args[0] === "show" &&
          c.args[1] === "HEAD:docs/guide.md",
      ),
      "reads the HEAD version via git show",
    );

    const scoreCalls = pi.calls.filter((c) => c.cmd === "zero-slop");
    assert.equal(scoreCalls.length, 2, "staged score plus HEAD score");
    assert.deepEqual(scoreCalls[0]!.args, ["score", "docs/guide.md"]);
    const tempArg = scoreCalls[1]!.args[1]!;
    assert.ok(isAbsolute(tempArg), "HEAD score runs against a temp file");
    assert.equal(basename(tempArg).endsWith(".md"), true, "keeps the extension");
    assert.equal(
      pi.scoredFiles.get(tempArg),
      "# HEAD content\n",
      "the temp file holds the git show HEAD output",
    );
    assert.equal(
      v.kind,
      "clean",
      "staged 60 does not exceed the HEAD score 90 in baseline mode",
    );
  });

  it("in baseline mode skips HEAD scoring for a prose path absent at HEAD", async () => {
    const pi = mockPi({
      nameOnly: "notes.txt\n",
      show: () => ({ code: 128, stdout: "" }),
      which: { python3: 0, "zero-slop": 0 },
      score: () => ({ stdout: "Writing score: 10/100" }),
    });

    const v = await runSlopGate(pi, tmpCwd(), config("baseline"));

    assert.ok(
      pi.calls.some(
        (c) => c.cmd === "git" && c.args[1] === "HEAD:notes.txt",
      ),
      "git show is still attempted",
    );
    assert.deepEqual(
      pi.calls.filter((c) => c.cmd === "zero-slop"),
      [{ cmd: "zero-slop", args: ["score", "notes.txt"] }],
      "only the staged score runs; no temp-file HEAD score",
    );
    assert.notEqual(v.kind, "block");
  });

  it("an unavailable tool (resolveSlopTool returns null) yields a slop gate unavailable: note and never blocks", async () => {
    const noTools = mockPi({ nameOnly: "src/a.ts\n", which: {} });
    const v1 = await runSlopGate(noTools, tmpCwd(), config("hard", { fetchFallback: false }));
    assert.notEqual(v1.kind, "block");
    assert.ok(v1.notes.some((n) => n.startsWith("slop gate unavailable:")));

    const noPython = mockPi({ nameOnly: "README.md\n", which: { python3: 1 } });
    const v2 = await runSlopGate(noPython, tmpCwd(), config("hard"));
    assert.notEqual(v2.kind, "block");
    assert.ok(v2.notes.some((n) => n.startsWith("slop gate unavailable:")));
  });

  it("unparseable scanner output yields a slop gate unavailable: note and never blocks", async () => {
    const badScan = mockPi({
      nameOnly: "src/a.ts\n",
      which: { aislop: 0 },
      aislop: { stdout: "score: 71 (ok)" },
    });
    const v1 = await runSlopGate(badScan, tmpCwd(), config("hard"));
    assert.notEqual(v1.kind, "block");
    assert.ok(v1.notes.some((n) => n.startsWith("slop gate unavailable:")));

    const badScore = mockPi({
      nameOnly: "README.md\n",
      which: { python3: 0, "zero-slop": 0 },
      score: () => ({ stdout: "nothing to report" }),
    });
    const v2 = await runSlopGate(badScore, tmpCwd(), config("hard"));
    assert.notEqual(v2.kind, "block");
    assert.ok(v2.notes.some((n) => n.startsWith("slop gate unavailable:")));
  });

  it("returns a block verdict with investigation and violations when classification blocks", async () => {
    const pi = mockPi({
      nameOnly: "src/a.ts\n",
      which: { aislop: 0 },
      aislop: {
        stdout: JSON.stringify({
          score: 40,
          diagnostics: [
            {
              filePath: "src/a.ts",
              line: 3,
              rule: "no-console",
              severity: "warning",
              message: "avoid console",
            },
          ],
        }),
      },
    });

    const v = await runSlopGate(pi, tmpCwd(), config("hard"));

    assert.equal(v.kind, "block");
    assert.ok(v.investigation.startsWith("slop gate blocked:"));
    assert.deepEqual(v.violations, ["src/a.ts:3 no-console — avoid console"]);
  });
});

// ─── resolveSlopGate ─────────────────────────────────────────────────────────

describe("resolveSlopGate", () => {
  it("returns undefined when the resolved mode is off (e.g. env PI_SLOP_GATE=off)", async () => {
    resetWorkflowConfigCache();

    const runner = await resolveSlopGate(tmpCwd(), { PI_SLOP_GATE: "off" });

    assert.equal(runner, undefined);
  });

  it("returns a runner when the resolved mode is advisory, baseline or hard", async () => {
    for (const mode of ["advisory", "baseline", "hard"] as const) {
      resetWorkflowConfigCache();

      const runner = await resolveSlopGate(tmpCwd(), { PI_SLOP_GATE: mode });

      assert.ok(runner, `${mode} resolves to a runner`);
      assert.equal(runner.mode, mode);
      assert.equal(typeof runner.run, "function");
    }
  });

  it("reads the mode from workflow.json when the env does not override", async () => {
    const cwd = tmpCwd();
    mkdirSync(join(cwd, ".pi"), { recursive: true });
    writeFileSync(
      join(cwd, ".pi", "workflow.json"),
      JSON.stringify({ implement: { slop: { mode: "baseline" } } }),
    );
    resetWorkflowConfigCache();

    const runner = await resolveSlopGate(cwd, {});

    assert.ok(runner);
    assert.equal(runner.mode, "baseline");
    resetWorkflowConfigCache();
  });
});
