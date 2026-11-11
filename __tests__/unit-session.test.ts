import { describe, it } from "vitest";
import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { runOrchestratedImplement, type UnitRunner } from "../extensions/implement-loop.ts";
import type { WorkflowState } from "../extensions/state.ts";
import { mockPi } from "./helpers/implement-harness.ts";

// ═══════════════════════════════════════════════════════════════════════════════
// T1 — persistent session CLI args and session file resolution
// ═══════════════════════════════════════════════════════════════════════════════

/** Value following `flag` in argv, or undefined when the flag is absent. */
function flagValue(args: readonly string[], flag: string): string | undefined {
  const i = args.indexOf(flag);
  return i >= 0 ? args[i + 1] : undefined;
}

/** Poll until `check` passes or `ms` elapses. */
async function waitFor(check: () => boolean, ms = 3_000): Promise<boolean> {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (check()) return true;
    await new Promise((r) => setTimeout(r, 25));
  }
  return check();
}

describe("buildImplementerArgs session spec (T1)", () => {
  it("resume spec emits --session-dir/--session-id and omits --no-session; spec-less keeps --no-session", async () => {
    const { buildImplementerArgs } = await import("../extensions/implementer-args.ts");
    const dir = mkdtempSync(join(tmpdir(), "pi-sess-resume-"));
    const args = buildImplementerArgs("sys", undefined, undefined, undefined, [], {
      dir,
      id: "sess-abc",
    });
    assert.equal(flagValue(args, "--session-dir"), dir);
    assert.equal(flagValue(args, "--session-id"), "sess-abc");
    assert.ok(!args.includes("--no-session"), "resume spec must not emit --no-session");

    const bare = buildImplementerArgs("sys");
    assert.ok(bare.includes("--no-session"), "spec-less call keeps --no-session");
    assert.equal(flagValue(bare, "--session-dir"), undefined);
    assert.equal(flagValue(bare, "--session-id"), undefined);
  });

  it("fork spec emits --session-dir, --fork with the absolute source path, and --session-id", async () => {
    const { buildImplementerArgs } = await import("../extensions/implementer-args.ts");
    const dir = mkdtempSync(join(tmpdir(), "pi-sess-fork-"));
    const source = join(dir, "chat_ab12.jsonl");
    writeFileSync(source, "");
    const args = buildImplementerArgs("sys", undefined, undefined, undefined, [], {
      dir,
      id: "new-id",
      forkFrom: "ab12",
    });
    assert.equal(flagValue(args, "--session-dir"), dir);
    const fork = flagValue(args, "--fork");
    assert.ok(fork, "--fork must be present for a fork spec");
    assert.ok(resolve(fork) === fork && fork.startsWith("/"), "--fork path must be absolute");
    assert.equal(fork, source);
    assert.equal(flagValue(args, "--session-id"), "new-id");
    assert.ok(!args.includes("--no-session"), "fork spec must not emit --no-session");
  });

  it("spawnRpcUnitClient forwards the session option to the child argv", async () => {
    const dir = mkdtempSync(join(tmpdir(), "pi-sess-spawn-"));
    const fake = join(dir, "fake-pi.sh");
    writeFileSync(
      fake,
      '#!/bin/sh\nprintf "ARGS:%s\\n" "$@" >&2\nwhile IFS= read -r line; do :; done\n',
    );
    chmodSync(fake, 0o755);
    const prev = process.env.PI_BIN;
    process.env.PI_BIN = fake;
    try {
      const { spawnRpcUnitClient } = await import("../extensions/rpc-unit-client.ts");
      const client = spawnRpcUnitClient({
        systemPrompt: "sys",
        cwd: dir,
        session: { dir: "/tmp/sessions", id: "s-1" },
      });
      try {
        assert.ok(
          await waitFor(() => client.stderrText().includes("--session-dir")),
          "child argv must carry --session-dir",
        );
        const text = client.stderrText();
        assert.ok(text.includes("/tmp/sessions"), "--session-dir value must reach argv");
        assert.ok(text.includes("--session-id"), "--session-id must reach argv");
        assert.ok(!text.includes("--no-session"), "--no-session must be absent with a session");
      } finally {
        await client.shutdown(200);
      }
    } finally {
      if (prev === undefined) delete process.env.PI_BIN;
      else process.env.PI_BIN = prev;
    }
  });
});

describe("unitSessionDir / unitSessionFile (T1)", () => {
  it("unitSessionDir creates <cwd>/.pi/workflow/sessions with .pi/workflow/.gitignore containing exactly *", async () => {
    const { unitSessionDir } = await import("../extensions/unit-session.ts");
    const cwd = mkdtempSync(join(tmpdir(), "pi-sess-cwd-"));
    const sessions = unitSessionDir(cwd);
    assert.equal(sessions, resolve(cwd, ".pi/workflow/sessions"));
    assert.ok(statSync(sessions).isDirectory(), "sessions dir must exist");
    assert.equal(readFileSync(resolve(cwd, ".pi/workflow/.gitignore"), "utf8"), "*");
  });

  it("unitSessionFile finds flat and nested session files by suffix, undefined on no match", async () => {
    const { unitSessionDir, unitSessionFile } = await import("../extensions/unit-session.ts");
    const cwd = mkdtempSync(join(tmpdir(), "pi-sess-find-"));
    const sessions = unitSessionDir(cwd);

    // Flat layout: file directly in the sessions dir.
    const flat = join(sessions, "agent_ab12.jsonl");
    writeFileSync(flat, "");
    assert.equal(unitSessionFile(sessions, "ab12"), flat);

    // Nested layout: file under a subdirectory.
    const nestedDir = join(sessions, "team", "alpha");
    mkdirSync(nestedDir, { recursive: true });
    const nested = join(nestedDir, "log_cd34.jsonl");
    writeFileSync(nested, "");
    assert.equal(unitSessionFile(sessions, "cd34"), nested);

    // No match: unknown id, missing underscore form, missing dir.
    assert.equal(unitSessionFile(sessions, "zzzz"), undefined);
    assert.equal(unitSessionFile(join(sessions, "absent"), "ab12"), undefined);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// T4 — session cleanup: landed behaviors drop transcripts, halts keep them
// ═══════════════════════════════════════════════════════════════════════════════

/** Behavior session id used by the T4 tests (`<behaviorId>-<head first 8>`). */
const BEHAVIOR_SESSION_ID = "T1-abcdef12";

/** Mock context rooted at a temp cwd carrying the given workflow state. */
function t4Ctx(state: WorkflowState, cwd: string): ExtensionContext {
  return {
    cwd,
    sessionManager: {
      getBranch: () => [{ type: "custom", customType: "workflow-state", data: state }],
    },
    ui: {
      notify: () => {},
      setStatus: () => {},
      setWidget: () => {},
      setTitle: () => {},
      theme: { fg: (_c: string, t: string) => t },
      addAutocompleteProvider: () => {},
    },
  } as unknown as ExtensionContext;
}

/** Finalizing state with the baseline head that keys the resume session. */
function t4State(): WorkflowState {
  return {
    phase: "finalizing",
    specText: "topic",
    baselineHead: "abcdef1234567890",
    task: {
      title: "T4 Task",
      instruction: "do things",
      files: [{ path: "src/a.ts", status: "M" }],
      done: "tests pass",
      behaviors: [
        { id: "T1", description: "x", expectedOutput: "y", kind: "test", status: "active" },
      ],
    },
  };
}

/** Mock API whose git exec answers rev-parse (head advances on commit) and commit. */
function t4Pi(): ExtensionAPI {
  const pi = mockPi();
  let headCounter = 0;
  pi.exec = (async (cmd: string, args: string[]) => {
    if (cmd === "git" && args[0] === "rev-parse") {
      return { stdout: `head${headCounter}\n`, stderr: "", code: 0, killed: false };
    }
    if (cmd === "git" && args[0] === "commit") {
      headCounter++;
      return { stdout: "[main abc] committed", stderr: "", code: 0, killed: false };
    }
    return { stdout: "", stderr: "", code: 0, killed: false };
  }) as ExtensionAPI["exec"];
  return pi;
}

describe("removeBehaviorSessions (T4)", () => {
  it("deletes the behavior's implementation and fix session files and leaves other behaviors' session files untouched", async () => {
    const { removeBehaviorSessions } = await import("../extensions/unit-session.ts");
    const dir = mkdtempSync(join(tmpdir(), "pi-sess-remove-"));
    const impl = join(dir, `agent_${BEHAVIOR_SESSION_ID}.jsonl`);
    const fix1 = join(dir, `agent_${BEHAVIOR_SESSION_ID}-fix1.jsonl`);
    const nestedDir = join(dir, "team");
    mkdirSync(nestedDir, { recursive: true });
    const fix2 = join(nestedDir, `log_${BEHAVIOR_SESSION_ID}-fix2.jsonl`);
    const other = join(dir, "agent_T2-abcdef12.jsonl");
    const notJsonl = join(dir, `note_${BEHAVIOR_SESSION_ID}.txt`);
    for (const f of [impl, fix1, fix2, other, notJsonl]) writeFileSync(f, "");

    removeBehaviorSessions(dir, BEHAVIOR_SESSION_ID);

    assert.ok(!existsSync(impl), "implementation session file must be deleted");
    assert.ok(!existsSync(fix1), "fix session file must be deleted");
    assert.ok(!existsSync(fix2), "nested fix session file must be deleted");
    assert.ok(existsSync(other), "another behavior's session file must survive");
    assert.ok(existsSync(notJsonl), "non-.jsonl files must survive");
    // Missing dir is a no-op.
    removeBehaviorSessions(join(dir, "absent"), BEHAVIOR_SESSION_ID);
  });
});

describe("behavior-loop session cleanup (T4)", () => {
  it("a landed behavior has no session files left under .pi/workflow/sessions, while a halted behavior keeps its session files", async () => {
    // Landed run: base attempt succeeds and the commit lands → transcripts removed.
    const landedCwd = mkdtempSync(join(tmpdir(), "pi-sess-landed-"));
    const landedSessions = join(landedCwd, ".pi", "workflow", "sessions");
    mkdirSync(landedSessions, { recursive: true });
    const landedImpl = join(landedSessions, `prev_${BEHAVIOR_SESSION_ID}.jsonl`);
    const landedFix = join(landedSessions, `prev_${BEHAVIOR_SESSION_ID}-fix1.jsonl`);
    const landedOther = join(landedSessions, "prev_T2-abcdef12.jsonl");
    for (const f of [landedImpl, landedFix, landedOther]) writeFileSync(f, "");
    const landedState = t4State();
    const landedRunner: UnitRunner = async () => ({
      summary: "implemented T1",
      suggestedCommit: "feat(core): add behavior",
    });
    const landedResult = await runOrchestratedImplement(
      t4Pi(),
      t4Ctx(landedState, landedCwd),
      landedState,
      landedState.task!,
      landedRunner,
    );
    assert.equal(landedResult.complete, true, `landed run must complete: ${landedResult.error}`);
    assert.ok(!existsSync(landedImpl), "landed behavior's implementation session must be gone");
    assert.ok(!existsSync(landedFix), "landed behavior's fix session must be gone");
    assert.ok(existsSync(landedOther), "other behavior's session file must survive the landing");

    // Halted run: the unit fails every attempt → halt keeps the transcripts for resume.
    const haltedCwd = mkdtempSync(join(tmpdir(), "pi-sess-halted-"));
    const haltedSessions = join(haltedCwd, ".pi", "workflow", "sessions");
    mkdirSync(haltedSessions, { recursive: true });
    const haltedImpl = join(haltedSessions, `prev_${BEHAVIOR_SESSION_ID}.jsonl`);
    writeFileSync(haltedImpl, "");
    const haltedState = t4State();
    const haltedRunner: UnitRunner = async () => ({ summary: "failed", error: "unit crashed" });
    const haltedResult = await runOrchestratedImplement(
      t4Pi(),
      t4Ctx(haltedState, haltedCwd),
      haltedState,
      haltedState.task!,
      haltedRunner,
    );
    assert.equal(haltedResult.complete, false, "halted run must not complete");
    assert.ok(haltedResult.error, "halted run must report the halt error");
    assert.ok(existsSync(haltedImpl), "halted behavior must keep its session files for /implement resume");
  }, 60_000);
});
