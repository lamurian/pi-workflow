import { afterEach, describe, it, vi } from "vitest";
import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// ═══════════════════════════════════════════════════════════════════════════════
// T1 — bidirectional `pi --mode rpc` implementer transport
// ═══════════════════════════════════════════════════════════════════════════════

/** Write an executable fake pi script and return its path. */
function fakePi(body: string): string {
  const dir = mkdtempSync(join(tmpdir(), "pi-rpc-fake-"));
  const fake = join(dir, "fake-pi.sh");
  writeFileSync(fake, "#!/bin/sh\n" + body);
  chmodSync(fake, 0o755);
  return fake;
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

/** Run `fn` with PI_BIN pinned to `bin`, restoring the prior value after. */
async function withPiBin<T>(bin: string, fn: () => Promise<T>): Promise<T> {
  const prev = process.env.PI_BIN;
  process.env.PI_BIN = bin;
  try {
    return await fn();
  } finally {
    if (prev === undefined) delete process.env.PI_BIN;
    else process.env.PI_BIN = prev;
  }
}

describe("spawnRpcUnitClient", () => {
  it("delivers the task as a JSONL prompt command with a unique id", async () => {
    // Fake echoes every stdin line to stderr so the test can assert the wire format.
    const fake = fakePi(
      'while IFS= read -r line; do\n  printf "ECHO:%s\\n" "$line" >&2\ndone\n',
    );
    const { spawnRpcUnitClient } = await import("../extensions/rpc-unit-client.ts");
    await withPiBin(fake, async () => {
      const client = spawnRpcUnitClient({ systemPrompt: "sys", cwd: "/tmp" });
      try {
        client.prompt("Implement behavior T1.");
        client.prompt("Second task.");
        assert.ok(
          await waitFor(() => /"type":"prompt"/.test(client.stderrText())),
          "prompt command must reach the child's stdin as JSONL",
        );
        assert.match(client.stderrText(), /"message":"Implement behavior T1\."/);
        const ids = [...client.stderrText().matchAll(/"id":"(rpc-\d+)"/g)].map((m) => m[1]);
        assert.ok(ids.length >= 2, "each command must carry an id");
        assert.notEqual(ids[0], ids[1], "command ids must be unique");
      } finally {
        await client.shutdown(200);
      }
    });
  });

  it("steer attaches images when present", async () => {
    const fake = fakePi(
      'while IFS= read -r line; do\n  printf "ECHO:%s\\n" "$line" >&2\ndone\n',
    );
    const { spawnRpcUnitClient } = await import("../extensions/rpc-unit-client.ts");
    await withPiBin(fake, async () => {
      const client = spawnRpcUnitClient({ systemPrompt: "sys", cwd: "/tmp" });
      try {
        client.steer("try the other approach", [
          { type: "image", data: "aGVsbG8=", mimeType: "image/png" },
        ]);
        assert.ok(
          await waitFor(() => /"type":"steer"/.test(client.stderrText())),
          "steer command must reach the child",
        );
        assert.match(client.stderrText(), /"message":"try the other approach"/);
        assert.match(client.stderrText(), /"mimeType":"image\/png"/);
      } finally {
        await client.shutdown(200);
      }
    });
  });

  it("command() resolves the correlated response", async () => {
    const fake = fakePi(
      'while IFS= read -r line; do\n' +
        '  case "$line" in\n' +
        "    *'\"type\":\"get_messages\"'*)\n" +
        '      id=$(printf \'%s\' "$line" | sed \'s/.*"id":"//; s/".*//\')\n' +
        '      printf \'%s\\n\' "{\\"type\\":\\"response\\",\\"command\\":\\"get_messages\\",\\"success\\":true,\\"id\\":\\"$id\\",\\"data\\":{\\"count\\":2}}"\n' +
        "      ;;\n" +
        "  esac\n" +
        "done\n",
    );
    const { spawnRpcUnitClient } = await import("../extensions/rpc-unit-client.ts");
    await withPiBin(fake, async () => {
      const client = spawnRpcUnitClient({ systemPrompt: "sys", cwd: "/tmp" });
      try {
        const res = await client.command({ type: "get_messages" }, 3_000);
        assert.equal(res.success, true);
        assert.deepEqual(res.data, { count: 2 });
      } finally {
        await client.shutdown(200);
      }
    });
  });

  it("shutdown falls back to SIGKILL when the child ignores abort", async () => {
    // Ignores abort, exits its read loop at EOF, then lingers in exec'd sleep.
    const fake = fakePi(
      'trap "" PIPE\nwhile IFS= read -r line; do :; done\nexec sleep 60\n',
    );
    const { spawnRpcUnitClient } = await import("../extensions/rpc-unit-client.ts");
    await withPiBin(fake, async () => {
      const client = spawnRpcUnitClient({ systemPrompt: "sys", cwd: "/tmp" });
      await new Promise((r) => setTimeout(r, 100));
      assert.equal(client.isAlive(), true, "child must be alive before shutdown");
      const started = Date.now();
      await client.shutdown(200);
      assert.ok(Date.now() - started < 3_000, "shutdown must settle via the kill fallback");
      assert.equal(client.isAlive(), false, "child must be dead after shutdown");
    });
  });
});

describe("runImplementerUnit over the rpc transport", () => {
  it("delivers the task via stdin (never argv) and returns the parsed report", async () => {
    // Fake reads the prompt command off stdin, then emits a report block
    // quoting the task it received — proof the task arrived over stdin.
    // NB: backticks are escaped (\`) — unescaped, sh command-substitutes them
    // inside the double-quoted printf arg and the report fence is lost.
    const fake = fakePi(
      'while IFS= read -r line; do\n' +
        '  case "$line" in\n' +
        "    *'\"type\":\"prompt\"'*)\n" +
        '      task=$(printf \'%s\' "$line" | sed \'s/.*"message":"//; s/","id".*//\')\n' +
        '      printf \'%s\\n\' "{\\"type\\":\\"message_end\\",\\"message\\":{\\"role\\":\\"assistant\\",\\"content\\":[{\\"type\\":\\"text\\",\\"text\\":\\"RAN: $task done.\\\\n\\`\\`\\`json\\\\n{\\\\\\"summary\\\\\\":\\\\\\"ran task\\\\\\",\\\\\\"suggestedCommit\\\\\\":\\\\\\"feat(x): ran\\\\\\"}\\\\n\\`\\`\\`\\"}]}}"\n' +
        "      ;;\n" +
        "    *'\"type\":\"abort\"'*) exit 0 ;;\n" +
        "  esac\n" +
        "done\nexit 0\n",
    );
    const { runImplementerUnit } = await import("../extensions/implementer-runner.ts");
    await withPiBin(fake, async () => {
      const res = await runImplementerUnit("sys", "Implement behavior T1.", "/tmp", undefined, 5_000);
      assert.equal(res.error, undefined, "a compliant report must not be an error");
      assert.equal(res.summary, "ran task");
      assert.equal(res.suggestedCommit, "feat(x): ran");
    });
  });

  it("shuts the child down gracefully after the report (abort + stdin close)", async () => {
    const fake = fakePi(
      'while IFS= read -r line; do\n' +
        '  case "$line" in\n' +
        "    *'\"type\":\"prompt\"'*)\n" +
        '      printf \'%s\\n\' "{\\"type\\":\\"message_end\\",\\"message\\":{\\"role\\":\\"assistant\\",\\"content\\":[{\\"type\\":\\"text\\",\\"text\\":\\"ok \\`\\`\\`json {\\\\\\"summary\\\\\\":\\\\\\"done\\\\\\"} \\`\\`\\`\\"}]}}"\n' +
        "      ;;\n" +
        '    *\'"type":"abort"\'*) echo "graceful-abort" >&2; exit 0 ;;\n' +
        "  esac\n" +
        "done\nexit 0\n",
    );
    const { spawnRpcUnitClient } = await import("../extensions/rpc-unit-client.ts");
    await withPiBin(fake, async () => {
      // Same shutdown path runImplementerUnit takes after seeing a report.
      const client = spawnRpcUnitClient({ systemPrompt: "sys", cwd: "/tmp" });
      try {
        await client.shutdown(2_000);
        assert.ok(
          await waitFor(() => /graceful-abort/.test(client.stderrText())),
          "the child must receive the graceful abort command",
        );
        assert.equal(client.isAlive(), false);
      } finally {
        client.kill();
      }
    });
  });

  it("SIGKILLs a working child at the wall clock and reports timedOut with assistant-text context", async () => {
    const fake = fakePi(
      'printf \'%s\\n\' \'{"type":"message_end","message":{"role":"assistant","content":[{"type":"text","text":"partial work"}]}}\'\nexec sleep 60\n',
    );
    const { runImplementerUnit } = await import("../extensions/implementer-runner.ts");
    await withPiBin(fake, async () => {
      const started = Date.now();
      const res = await runImplementerUnit("sys", "task", "/tmp", undefined, 400);
      assert.equal(res.timedOut, true, "timeout must be flagged structurally");
      assert.match(res.error ?? "", /timed out after 400ms/, "timeout must be named");
      assert.match(res.error ?? "", /partial work/, "error context must be the assistant text");
      assert.ok(Date.now() - started < 5_000, "must settle promptly after the kill");
    });
  });

  it("classifies an exit before any report block per the old exit semantics", async () => {
    const fake = fakePi(
      'printf \'%s\\n\' \'{"type":"message_end","message":{"role":"assistant","content":[{"type":"text","text":"halfway there"}]}}\'\nexit 3\n',
    );
    const { runImplementerUnit } = await import("../extensions/implementer-runner.ts");
    await withPiBin(fake, async () => {
      const res = await runImplementerUnit("sys", "task", "/tmp", undefined, 5_000);
      assert.equal(typeof res.error, "string");
      assert.match(res.error!, /halfway there/, "stdout tail context is unchanged");
      assert.equal(res.summary, "halfway there");
      assert.equal(res.timedOut, undefined, "non-timeout failures must not be flagged");
    });
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// T3 — soft deadline: a single wrap-up steer at 75% before the hard kill
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * In-memory RpcUnitClient double for fake-timer tests: records steer
 * messages and lets the test emit assistant output on demand.
 */
function stubClient() {
  const eventListeners = new Set<(event: Record<string, unknown>) => void>();
  const exitListeners = new Set<(info: { code: number }) => void>();
  const steers: string[] = [];
  let raw = "";
  let alive = true;
  return {
    steers,
    send: () => {},
    command: async () => ({ type: "response", success: false, id: "" }),
    prompt: (_message: string) => {},
    steer: (message: string) => {
      steers.push(message);
    },
    shutdown: async () => {
      alive = false;
    },
    kill: () => {
      if (!alive) return;
      alive = false;
      for (const listener of exitListeners) listener({ code: 1 });
      exitListeners.clear();
    },
    onEvent: (listener: (event: Record<string, unknown>) => void) => {
      eventListeners.add(listener);
      return () => eventListeners.delete(listener);
    },
    onExit: (listener: (info: { code: number }) => void) => {
      if (!alive) {
        listener({ code: 1 });
        return () => {};
      }
      exitListeners.add(listener);
      return () => exitListeners.delete(listener);
    },
    rawStdout: () => raw,
    stderrText: () => "",
    isAlive: () => alive,
    /** Emit a final assistant message containing `text` (e.g. a report block). */
    emitAssistant(text: string) {
      raw +=
        JSON.stringify({
          type: "message_end",
          message: { role: "assistant", content: [{ type: "text", text }] },
        }) + "\n";
      for (const listener of eventListeners) listener({ type: "message_end" });
    },
  };
}

describe("runImplementerUnit soft deadline (T3)", () => {
  afterEach(() => vi.useRealTimers());

  it("steers exactly once at 750ms of a 1000ms budget; the hard kill still fires timedOut", async () => {
    vi.useFakeTimers();
    const { runImplementerUnitWithClient } = await import("../extensions/implementer-runner.ts");
    const client = stubClient();
    const promise = runImplementerUnitWithClient(client, "task", { timeoutMs: 1_000 });
    await vi.advanceTimersByTimeAsync(749);
    assert.equal(client.steers.length, 0, "no steer before the 75% mark");
    await vi.advanceTimersByTimeAsync(1);
    assert.equal(client.steers.length, 1, "one wrap-up steer at 750ms");
    assert.match(client.steers[0]!, /status/, "the steer names the status field");
    assert.match(client.steers[0]!, /partial/, "the steer asks for status partial");
    await vi.advanceTimersByTimeAsync(251); // hard kill at 1000ms
    const res = await promise;
    assert.equal(res.timedOut, true, "the hard kill still yields timedOut=true");
    assert.match(res.error ?? "", /timed out after 1000ms/);
    assert.equal(client.steers.length, 1, "the steer fires exactly once");
  });

  it("does not steer when the report arrives before the soft deadline", async () => {
    vi.useFakeTimers();
    const { runImplementerUnitWithClient } = await import("../extensions/implementer-runner.ts");
    const client = stubClient();
    const promise = runImplementerUnitWithClient(client, "task", { timeoutMs: 1_000 });
    await vi.advanceTimersByTimeAsync(0);
    client.emitAssistant("done.\n```json\n{\"summary\": \"ok\"}\n```");
    const res = await promise;
    assert.equal(res.summary, "ok");
    assert.equal(res.timedOut, undefined);
    await vi.advanceTimersByTimeAsync(2_000); // timers cleared on completion
    assert.equal(client.steers.length, 0, "no steer when the report beats the deadline");
  });

  it("clears the soft timer on abort (no steer after the unit is aborted)", async () => {
    vi.useFakeTimers();
    const { runImplementerUnitWithClient } = await import("../extensions/implementer-runner.ts");
    const client = stubClient();
    const controller = new AbortController();
    const promise = runImplementerUnitWithClient(client, "task", {
      timeoutMs: 1_000,
      signal: controller.signal,
    });
    await vi.advanceTimersByTimeAsync(0);
    controller.abort();
    const res = await promise;
    assert.equal(res.timedOut, true, "an abort takes the kill path");
    await vi.advanceTimersByTimeAsync(2_000);
    assert.equal(client.steers.length, 0, "the soft timer must not steer after abort");
  });
});

