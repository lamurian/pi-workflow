import { describe, it } from "vitest";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { chooseFixSession, FIX_FORK_CONTEXT_LIMIT } from "../extensions/fix-session.ts";
import {
  chooseBehaviorFixSession,
  createFixRoundTracker,
  noteAttemptContext,
  resolveBehaviorSession,
} from "../extensions/behavior-sessions.ts";
import { unitSessionFile } from "../extensions/unit-session.ts";
import {
  runOrchestratedImplement,
  type OrchestratorResult,
  type UnitRunner,
} from "../extensions/implement-loop.ts";
import { beginOrchestration, endOrchestration } from "../extensions/orchestration-cancel.ts";
import { setActiveUnitClient } from "../extensions/unit-client-registry.ts";
import type { UnitTask } from "../extensions/implementer-runner.ts";
import type { RpcUnitClient } from "../extensions/rpc-unit-client.ts";
import type { WorkflowState } from "../extensions/state.ts";

const HOOK_STDERR = "husky - pre-commit hook failed\nlint errors";

function mockPi(): ExtensionAPI & { calls: Record<string, unknown[]> } {
  const calls: Record<string, unknown[]> = {};
  const record = (name: string) => {
    calls[name] = [];
    return (...args: unknown[]) => {
      calls[name]!.push(args);
    };
  };
  return {
    on: record("on") as ExtensionAPI["on"],
    registerCommand: record("registerCommand") as ExtensionAPI["registerCommand"],
    registerTool: record("registerTool") as ExtensionAPI["registerTool"],
    appendEntry: record("appendEntry") as ExtensionAPI["appendEntry"],
    sendUserMessage: record("sendUserMessage") as ExtensionAPI["sendUserMessage"],
    getActiveTools: () => ["read", "write", "edit"],
    getAllTools: () => ["read", "write", "edit"].map((name) => ({ name })),
    setActiveTools: record("setActiveTools") as ExtensionAPI["setActiveTools"],
    exec: async () => ({ stdout: "", stderr: "", code: 0, killed: false }),
    calls,
  } as unknown as ExtensionAPI & { calls: typeof calls };
}

function ctxWithState(state: WorkflowState, cwd: string): ExtensionContext {
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

function taskState(): WorkflowState {
  return {
    phase: "finalizing",
    specText: "topic",
    task: {
      title: "Fix Session Task",
      instruction: "do the thing",
      files: [{ path: "src/a.ts", status: "M" }],
      done: "tests pass",
      behaviors: [
        { id: "T1", description: "x", expectedOutput: "y", kind: "test", status: "active" },
      ],
    },
  };
}

interface GitGateOptions {
  landOnCommit?: number;
  failCode?: number;
  dirty?: () => boolean;
}

/** Exec mock driving the commit gate: rev-parse/status/diff/commit sequences. */
function piWithGate(opts: GitGateOptions = {}) {
  const pi = mockPi();
  let head = 0;
  let commitAttempts = 0;
  pi.exec = (async (cmd: string, args: string[]) => {
    if (cmd === "git" && args[0] === "rev-parse") {
      return { stdout: `head${head}\n`, stderr: "", code: 0, killed: false };
    }
    if (cmd === "git" && args[0] === "status") {
      const dirty = opts.dirty ? opts.dirty() : true;
      return { stdout: dirty ? " M src/a.ts\n" : "", stderr: "", code: 0, killed: false };
    }
    if (cmd === "git" && (args[0] === "diff" || args[0] === "add")) {
      return { stdout: "", stderr: "", code: 0, killed: false };
    }
    if (cmd === "git" && args[0] === "commit") {
      commitAttempts++;
      if (opts.landOnCommit !== undefined && commitAttempts >= opts.landOnCommit) {
        head++;
        return { stdout: `[main c${commitAttempts}] landed`, stderr: "", code: 0, killed: false };
      }
      return { stdout: "", stderr: `${HOOK_STDERR} (attempt ${commitAttempts})`, code: opts.failCode ?? 1, killed: false };
    }
    return { stdout: "", stderr: "", code: 0, killed: false };
  }) as ExtensionAPI["exec"];
  return pi;
}

interface ClientHandle {
  client: RpcUnitClient;
  record: { prompts: string[]; steers: string[]; shutdowns: number };
}

/** Fake kept-alive child recording prompts, steers and shutdowns. */
function makeClient(): ClientHandle {
  let alive = true;
  const record = { prompts: [] as string[], steers: [] as string[], shutdowns: 0 };
  const client = {
    isAlive: () => alive,
    shutdown: async () => {
      record.shutdowns++;
      alive = false;
    },
    kill: () => {
      alive = false;
    },
    send: () => {},
    command: async () => ({ type: "response", success: true, id: "x" }),
    prompt: (message: string) => {
      record.prompts.push(message);
    },
    steer: (message: string) => {
      record.steers.push(message);
    },
    onEvent: () => () => {},
    onExit: () => () => {},
    rawStdout: () => "",
    stderrText: () => "",
  } as unknown as RpcUnitClient;
  return { client, record };
}

/** Fresh loop run with the cancelled flag reset (cancelOrchestration is sticky). */
async function runLoop(
  pi: ExtensionAPI,
  ctx: ExtensionContext,
  state: WorkflowState,
  runner: UnitRunner,
): Promise<OrchestratorResult> {
  beginOrchestration(Promise.resolve());
  try {
    return await runOrchestratedImplement(pi, ctx, state, state.task!, runner);
  } finally {
    endOrchestration();
  }
}

// ═══ chooseFixSession (unit) ═══
describe("chooseFixSession", () => {
  const implSessionId = "T1-base123";
  const sourceFile = "/tmp/sessions/impl_T1-base123.jsonl";

  it("forks the implementation session for semantic triggers at most 50% when the transcript resolves", () => {
    assert.equal(FIX_FORK_CONTEXT_LIMIT, 50, "the fork limit is 50% context usage");
    for (const trigger of ["scope-gate", "no-changes"] as const) {
      for (const contextPercent of [0, 30, 50]) {
        const plan = chooseFixSession({ trigger, contextPercent, implSessionId, fixIndex: 1, sourceFile });
        assert.deepEqual(
          plan,
          { id: `${implSessionId}-fix1`, forkFrom: implSessionId },
          `${trigger} at ${contextPercent}% forks the implementation session`,
        );
      }
    }
  });

  it("fresh for mechanical triggers, above-50 or unknown context, or a missing transcript", () => {
    const cases = [
      chooseFixSession({ trigger: "hook-rejected", contextPercent: 10, implSessionId, fixIndex: 1, sourceFile }),
      chooseFixSession({ trigger: "slop-guard", contextPercent: 10, implSessionId, fixIndex: 1, sourceFile }),
      chooseFixSession({ trigger: "scope-gate", contextPercent: 51, implSessionId, fixIndex: 2, sourceFile }),
      chooseFixSession({ trigger: "no-changes", implSessionId, fixIndex: 2, sourceFile }),
      chooseFixSession({ trigger: "no-changes", contextPercent: 30, implSessionId, fixIndex: 3 }),
    ];
    for (const plan of cases) {
      assert.equal(plan.forkFrom, undefined, `${plan.id} stays fresh`);
      assert.match(plan.id, /^T1-base123-fix\d+$/, "the fresh id is <implSessionId>-fix<n>");
    }
  });
});

// ═══ chooseBehaviorFixSession (unit) ═══
describe("chooseBehaviorFixSession", () => {
  it("resolves the implementation .jsonl — never an earlier fix session — and advances the fix index", () => {
    const cwd = mkdtempSync(join(tmpdir(), "pi-fix-session-"));
    const { session } = resolveBehaviorSession(cwd, "T1");
    const implFile = join(session.dir, `impl_${session.id}.jsonl`);
    const earlierFix = join(session.dir, `old_${session.id}-fix7.jsonl`);
    writeFileSync(implFile, "");
    writeFileSync(earlierFix, "");

    const tracker = createFixRoundTracker();
    noteAttemptContext(tracker, 30);
    const fork = chooseBehaviorFixSession(tracker, session, "scope-gate");
    assert.equal(fork.forkFrom, session.id, "the fork source is the implementation session");
    assert.equal(fork.id, `${session.id}-fix1`, "the new session id carries fix index 1");
    assert.equal(tracker.fixIndex, 1, "the fix index advanced");
    const source = unitSessionFile(session.dir, fork.forkFrom!);
    assert.equal(source, implFile, "the fork resolves the implementation transcript path");
    assert.notEqual(source, earlierFix, "an earlier fix session is never the fork source");

    noteAttemptContext(tracker, undefined);
    const fresh = chooseBehaviorFixSession(tracker, session, "no-changes");
    assert.equal(fresh.forkFrom, undefined, "unknown context falls back to a fresh session");
    assert.equal(fresh.id, `${session.id}-fix2`, "the second fix round uses fix index 2");

    noteAttemptContext(tracker, 80);
    const overLimit = chooseBehaviorFixSession(tracker, session, "no-changes");
    assert.equal(overLimit.forkFrom, undefined, "context above 50% stays fresh");
  });

  it("fresh when the implementation transcript cannot be resolved", () => {
    const cwd = mkdtempSync(join(tmpdir(), "pi-fix-session-"));
    const { session } = resolveBehaviorSession(cwd, "T1"); // dir exists, no transcript on disk
    const tracker = createFixRoundTracker();
    noteAttemptContext(tracker, 10);
    const plan = chooseBehaviorFixSession(tracker, session, "no-changes");
    assert.equal(plan.forkFrom, undefined, "no source file -> fresh spec");
    assert.equal(plan.id, `${session.id}-fix1`);
  });
});

// ═══ Loop integration ═══
describe("fix rounds in the orchestrator loop (T6)", () => {
  /** v2-gated state: one test-kind behavior owning a Go source + test file. */
  function gatedState(): WorkflowState {
    const GO_SUITE = { label: "go (go test ./...)", argv: ["go", "test", "./..."] };
    const JS_SUITE = { label: "javascript (npm run test)", argv: ["npm", "run", "test"] };
    return {
      phase: "finalizing",
      specText: "topic",
      testTool: { source: "detected", suites: [GO_SUITE, JS_SUITE] },
      contractV2: {
        title: "Gate Task",
        instruction: "do things",
        done: "all green",
        sources: [{ path: "pkg/foo/foo.go", tasks: ["T1"] }],
        tests: [{ path: "pkg/foo/foo_test.go", status: "A", tasks: ["T1"] }],
        tasks: [{ id: "T1", description: "first behavior", expectedOutput: ["e1"], status: "active" }],
      },
      task: {
        title: "Gate Task",
        instruction: "do things",
        files: [
          { path: "pkg/foo/foo.go", status: "M" },
          { path: "pkg/foo/foo_test.go", status: "A" },
        ],
        done: "all green",
        behaviors: [
          { id: "T1", description: "first behavior", expectedOutput: "e1", kind: "test", status: "active", sourceFile: "pkg/foo/foo.go" },
        ],
      },
    };
  }

  /** Exec mock: every commit lands; the go suite fails once (red gate) then passes. */
  function piWithGateExec(goFailures: number): ExtensionAPI {
    const pi = mockPi();
    let headCounter = 0;
    let goFailuresLeft = goFailures;
    pi.exec = (async (cmd: string, args: string[]) => {
      if (cmd === "git" && args[0] === "rev-parse") {
        return { stdout: `head${headCounter}\n`, stderr: "", code: 0, killed: false };
      }
      if (cmd === "git" && (args[0] === "status" || args[0] === "add" || args[0] === "diff")) {
        return { stdout: "", stderr: "", code: 0, killed: false };
      }
      if (cmd === "git" && args[0] === "commit") {
        headCounter++;
        return { stdout: "[main abc] committed", stderr: "", code: 0, killed: false };
      }
      if (cmd === "go" && args[0] === "test") {
        if (goFailuresLeft > 0) {
          goFailuresLeft--;
          return {
            stdout: "",
            stderr: "--- FAIL: TestFoo (0.00s)\n    foo_test.go:12: boom\nFAIL\tpkg/foo",
            code: 1,
            killed: false,
          };
        }
        return { stdout: "ok\tpkg/foo", stderr: "", code: 0, killed: false };
      }
      return { stdout: "", stderr: "", code: 0, killed: false };
    }) as ExtensionAPI["exec"];
    return pi;
  }

  it("a red scope-gate fix round spawns a new child forked from the implementation session and its prompt carries the gate failure output", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "pi-fix-session-"));
    const state = gatedState();
    const ctx = ctxWithState(state, cwd);
    const { session } = resolveBehaviorSession(cwd, "T1");
    const implFile = join(session.dir, `impl_${session.id}.jsonl`);
    writeFileSync(implFile, "");
    const pi = piWithGateExec(2); // first gate red (fail + owned-failure retry), green after the fix round
    const calls: UnitTask[] = [];
    let fixForkSource: string | undefined;
    const runner: UnitRunner = async (unit) => {
      calls.push(unit);
      if (calls.length === 1) {
        return { summary: "implemented", suggestedCommit: "feat(core): base", contextPercent: 20 };
      }
      if (unit.session?.forkFrom) fixForkSource = unitSessionFile(unit.session.dir, unit.session.forkFrom);
      return { summary: "fixed", suggestedCommit: "feat(core): fix T1" };
    };
    const result = await runLoop(pi, ctx, state, runner);

    assert.equal(result.complete, true, result.error ?? "");
    assert.equal(calls.length, 2, "base plus exactly one scope-gate fix spawn");
    const fix = calls[1]!;
    assert.equal(fix.session?.forkFrom, session.id, "forked from the implementation session");
    assert.equal(fix.session?.id, `${session.id}-fix1`, "the fix round spawns on a new session id");
    assert.equal(fixForkSource, implFile, "the fork resolves the implementation .jsonl path");
    assert.match(fix.taskText, /## Previous attempt failed \(retry 1\/5\)/, "the fix prompt");
    assert.match(fix.taskText, /scope gate/i, "the prompt carries the gate failure output");
    assert.match(fix.taskText, /TestFoo/, "the failing suite output rides the prompt");
  });

  interface NoChangesRun {
    result: OrchestratorResult;
    calls: UnitTask[];
    fixForkSource: string | undefined;
    base: ClientHandle;
    session: { dir: string; id: string };
    implFile: string;
    earlierFix: string;
  }

  /** One no-changes loop run; transcripts: "earlier-fix" (impl + stale fix), "impl", or "none". */
  async function runNoChanges(opts: {
    contextPercent?: number;
    transcript: "earlier-fix" | "impl" | "none";
  }): Promise<NoChangesRun> {
    const cwd = mkdtempSync(join(tmpdir(), "pi-fix-session-"));
    const state = taskState();
    const ctx = ctxWithState(state, cwd);
    const { session } = resolveBehaviorSession(cwd, "T1");
    const implFile = join(session.dir, `impl_${session.id}.jsonl`);
    const earlierFix = join(session.dir, `old_${session.id}-fix7.jsonl`);
    if (opts.transcript !== "none") writeFileSync(implFile, "");
    if (opts.transcript === "earlier-fix") writeFileSync(earlierFix, "");
    const pi = piWithGate({ landOnCommit: 2, failCode: 0, dirty: () => false });
    const calls: UnitTask[] = [];
    let fixForkSource: string | undefined;
    const base = makeClient();
    const runner: UnitRunner = async (unit) => {
      calls.push(unit);
      if (calls.length === 1) {
        setActiveUnitClient(base.client);
        return {
          summary: "implemented",
          suggestedCommit: "feat(core): base",
          client: base.client,
          ...(opts.contextPercent === undefined ? {} : { contextPercent: opts.contextPercent }),
        };
      }
      if (unit.session?.forkFrom) fixForkSource = unitSessionFile(unit.session.dir, unit.session.forkFrom);
      return { summary: "fixed", suggestedCommit: "feat(core): fix T1" };
    };
    const result = await runLoop(pi, ctx, state, runner);
    return { result, calls, fixForkSource, base, session, implFile, earlierFix };
  }

  it("a no-changes fix round spawns a new child forked from the implementation session via its resolved .jsonl path, not an earlier fix session, when context is at most 50%", async () => {
    const run = await runNoChanges({ contextPercent: 30, transcript: "earlier-fix" });

    assert.equal(run.result.complete, true, run.result.error ?? "run lands after the fix round");
    assert.equal(run.calls.length, 2, "base plus exactly one fresh fix spawn");
    const fix = run.calls[1]!;
    assert.ok(fix.session, "the fix spawn carries a session spec");
    assert.equal(fix.session.id, `${run.session.id}-fix1`, "the fix round spawns on a new session id");
    assert.equal(fix.session.forkFrom, run.session.id, "forked from the implementation session");
    assert.equal(run.fixForkSource, run.implFile, "the fork resolves to the implementation .jsonl");
    assert.notEqual(run.fixForkSource, run.earlierFix, "never an earlier fix session");
    // The kept-alive child is never steered into; the gate failure rides the fresh spawn's prompt.
    assert.equal(run.base.record.prompts.length, 0, "the kept-alive child gets no fix prompt");
    assert.deepEqual(run.base.record.steers, [], "the kept-alive child gets no steer");
    assert.equal(run.base.record.shutdowns, 1, "the kept-alive child is shut down before the fresh spawn");
    assert.match(fix.taskText, /## Previous attempt failed \(retry 1\/5\)/, "the fix prompt");
    assert.match(fix.taskText, /No changes detected/, "the prompt carries the gate failure output");
  });

  it("a fix round above 50% context, unknown context, or an unresolvable transcript spawns fresh", async () => {
    const high = await runNoChanges({ contextPercent: 80, transcript: "impl" });
    const unknown = await runNoChanges({ transcript: "impl" });
    const missing = await runNoChanges({ contextPercent: 30, transcript: "none" });
    for (const run of [high, unknown, missing]) {
      assert.equal(run.result.complete, true, run.result.error ?? "");
      assert.equal(run.calls.length, 2, "one fresh fix spawn");
      assert.equal(run.calls[1]!.session?.forkFrom, undefined, "no fork: fresh session");
      assert.match(run.calls[1]!.session?.id ?? "", /-fix1$/, "fresh id <implSessionId>-fix1");
      assert.equal(run.fixForkSource, undefined, "no fork source resolved");
    }
  });

  it("a hook-rejected fix round spawns fresh on <implSessionId>-fix<n> even with a resolvable transcript and low context", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "pi-fix-session-"));
    const state = taskState();
    const ctx = ctxWithState(state, cwd);
    const { session } = resolveBehaviorSession(cwd, "T1");
    writeFileSync(join(session.dir, `impl_${session.id}.jsonl`), "");
    const pi = piWithGate({ landOnCommit: 3 }); // hook rejects commits 1-2, lands 3
    const calls: UnitTask[] = [];
    const base = makeClient();
    const runner: UnitRunner = async (unit) => {
      calls.push(unit);
      if (calls.length === 1) {
        setActiveUnitClient(base.client);
        return { summary: "implemented", suggestedCommit: "feat(core): base", client: base.client, contextPercent: 30 };
      }
      return { summary: "fixed", suggestedCommit: "feat(core): fix T1" };
    };
    const result = await runLoop(pi, ctx, state, runner);

    assert.equal(result.complete, true, result.error ?? "");
    assert.equal(calls.length, 3, "base plus two mechanical fix rounds");
    for (const [i, spawn] of calls.slice(1).entries()) {
      assert.equal(spawn.session?.forkFrom, undefined, "mechanical trigger never forks");
      assert.match(spawn.session?.id ?? "", new RegExp(`-fix${i + 1}$`), "fresh id per fix index");
    }
    assert.match(calls[1]!.taskText, /husky - pre-commit hook failed/, "the prompt carries the hook output");
    assert.equal(base.record.prompts.length, 0, "the kept-alive child is never prompted");
    assert.equal(base.record.shutdowns, 1, "shut down before the first fresh spawn");
  });
});
