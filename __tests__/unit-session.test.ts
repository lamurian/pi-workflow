import { describe, it } from "vitest";
import assert from "node:assert/strict";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

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
