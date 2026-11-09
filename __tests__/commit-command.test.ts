import { describe, it } from "vitest";
import assert from "node:assert/strict";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

// ═══ T8: minimal /commit command + bash git-commit guardrail ═══

interface ExecCall {
  cmd: string;
  args: string[];
}

/** Mock ExtensionAPI recording commands, exec calls, sends and notifies. */
function mockPi(stagedPaths: string): ExtensionAPI & {
  calls: Record<string, unknown[]>;
  execLog: ExecCall[];
} {
  const calls: Record<string, unknown[]> = {};
  const record = (name: string) => {
    calls[name] = [];
    return (...args: unknown[]) => {
      calls[name]!.push(args);
    };
  };
  const execLog: ExecCall[] = [];
  const exec = async (cmd: string, args: string[]) => {
    execLog.push({ cmd, args });
    if (args[0] === "add") return { stdout: "", stderr: "", code: 0, killed: false };
    if (args[0] === "diff") return { stdout: stagedPaths, stderr: "", code: 0, killed: false };
    return { stdout: "", stderr: "", code: 0, killed: false };
  };
  return {
    on: record("on") as ExtensionAPI["on"],
    registerCommand: record("registerCommand") as ExtensionAPI["registerCommand"],
    registerTool: record("registerTool") as ExtensionAPI["registerTool"],
    registerShortcut: record("registerShortcut") as ExtensionAPI["registerShortcut"],
    appendEntry: record("appendEntry") as ExtensionAPI["appendEntry"],
    sendUserMessage: record("sendUserMessage") as ExtensionAPI["sendUserMessage"],
    getActiveTools: () => ["read", "bash"],
    setActiveTools: record("setActiveTools") as ExtensionAPI["setActiveTools"],
    exec,
    execLog,
    calls,
  } as unknown as ExtensionAPI & { calls: Record<string, unknown[]>; execLog: ExecCall[] };
}

/** ExtensionContext whose session carries the given phase (null = no state). */
function ctxFor(phase: string | null): ExtensionContext & { notifies: string[] } {
  const notifies: string[] = [];
  const entries =
    phase === null
      ? []
      : [
          {
            type: "custom",
            customType: "workflow-state",
            data: { phase, specText: "t" },
          },
        ];
  return {
    cwd: "/tmp/test",
    sessionManager: { getBranch: () => entries },
    ui: {
      notify: (msg: string) => {
        notifies.push(msg);
      },
      setStatus: () => {},
      setWidget: () => {},
      setTitle: () => {},
      theme: { fg: (_c: string, t: string) => t },
      addAutocompleteProvider: () => {},
    },
    notifies,
  } as unknown as ExtensionContext & { notifies: string[] };
}

/** Load the extension factory and return the registered /commit handler. */
async function getCommitHandler(
  pi: ExtensionAPI & { calls: Record<string, unknown[]> },
) {
  const factory = (await import("../extensions/index.ts")).default;
  factory(pi);
  const def = (pi.calls["registerCommand"] ?? []).find(
    ([n]: [string]) => n === "commit",
  ) as [string, { handler: (args: string, ctx: ExtensionContext) => Promise<void> }] | undefined;
  assert.ok(def, "command /commit must be registered by the extension factory");
  return def[1].handler;
}

/** Load the factory and return the first tool_call handler. */
async function getToolCallHandler(
  pi: ExtensionAPI & { calls: Record<string, unknown[]> },
) {
  const factory = (await import("../extensions/index.ts")).default;
  factory(pi);
  const onCalls = pi.calls["on"] ?? [];
  return onCalls.find(([e]: [string]) => e === "tool_call")![1] as (
    event: unknown,
    ctx: ExtensionContext,
  ) => Promise<{ block?: boolean; reason?: string } | undefined>;
}

describe("/commit command (T8)", () => {
  it("stages all changes and steers a follow-up to read the staged diff, author one single-line conventional message, and call commit_changes", async () => {
    const pi = mockPi("extensions/a.ts\n__tests__/a.test.ts");
    const handler = await getCommitHandler(pi);
    const ctx = ctxFor("implementing");

    await handler("", ctx);

    const add = pi.execLog.find((c) => c.cmd === "git" && c.args[0] === "add");
    assert.ok(add, "git add must run");
    assert.deepEqual(add.args, ["add", "--all"], "stages all changes");

    const send = pi.calls["sendUserMessage"] ?? [];
    assert.equal(send.length, 1, "exactly one follow-up is sent");
    const [text, opts] = send[0] as [string, { deliverAs: string }];
    assert.equal(opts.deliverAs, "steer", "the follow-up is delivered as a steer");
    assert.match(text, /git diff --cached/, "the agent is told to read the staged diff");
    assert.match(text, /single-line/i, "the agent is told to author one single-line message");
    assert.match(text, /conventional/i, "the message must be conventional");
    assert.match(text, /commit_changes/, "the follow-up names the commit_changes tool");
  });

  it("with nothing staged it only notifies", async () => {
    const pi = mockPi("");
    const handler = await getCommitHandler(pi);
    const ctx = ctxFor("implementing");

    await handler("", ctx);

    assert.ok(ctx.notifies.length >= 1, "a notification is emitted");
    assert.equal((pi.calls["sendUserMessage"] ?? []).length, 0, "no follow-up when nothing staged");
  });

  it("refuses with a notify in the discussing and finalizing phases and stages nothing", async () => {
    for (const phase of ["discussing", "finalizing"]) {
      const pi = mockPi("extensions/a.ts");
      const handler = await getCommitHandler(pi);
      const ctx = ctxFor(phase);

      await handler("", ctx);

      assert.ok(ctx.notifies.length >= 1, `/commit must notify in ${phase}`);
      assert.ok(
        !pi.execLog.some((c) => c.cmd === "git" && c.args[0] === "add"),
        `no staging may happen in ${phase}`,
      );
      assert.equal(
        (pi.calls["sendUserMessage"] ?? []).length,
        0,
        `no follow-up may be sent in ${phase}`,
      );
    }
  });
});

describe("bash git-commit guardrail (T8)", () => {
  async function guardFor(command: string) {
    const pi = mockPi("");
    const toolCall = await getToolCallHandler(pi);
    return await toolCall(
      { toolName: "bash", input: { command } },
      ctxFor("implementing"),
    );
  }

  it("blocks `git commit` with a reason naming commit_changes", async () => {
    const block = await guardFor("git commit -m \"feat: x\"");
    assert.equal(block?.block, true, "git commit from bash must be blocked");
    assert.match(block!.reason!, /commit_changes/, "the reason names commit_changes");
  });

  it("blocks `git -c k=v commit`", async () => {
    const block = await guardFor("git -c k=v commit -m \"chore: y\"");
    assert.equal(block?.block, true, "git -c k=v commit must be blocked");
    assert.match(block!.reason!, /commit_changes/, "the reason names commit_changes");
  });

  it("blocks a git commit chained behind another command", async () => {
    const block = await guardFor("npm run build && git commit -m \"fix: z\"");
    assert.equal(block?.block, true, "chained git commit must be blocked");
    assert.match(block!.reason!, /commit_changes/);
  });

  it("passes other git commands and non-bash tools", async () => {
    for (const command of ["git status --short", "git diff --cached", "git add -A", "git log -1 --oneline"]) {
      assert.equal(await guardFor(command), undefined, `${command} must pass`);
    }
    const pi = mockPi("");
    const toolCall = await getToolCallHandler(pi);
    const block = await toolCall(
      { toolName: "write", input: { path: "x.ts", content: "y" } },
      ctxFor("implementing"),
    );
    assert.equal(block, undefined, "non-bash tools are unaffected by the guardrail");
  });
});
