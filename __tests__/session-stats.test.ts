import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { readContextPercent } from "../extensions/session-stats.ts";
import { runImplementerUnitWithClient } from "../extensions/implementer-runner.ts";
import type { RpcResponse, RpcUnitClient } from "../extensions/rpc-unit-client.ts";

/** Build a client double whose command() resolves with `response`. */
function clientResponding(response: unknown): RpcUnitClient {
  return {
    command: vi.fn(async () => response as RpcResponse),
    isAlive: () => true,
  } as unknown as RpcUnitClient;
}

describe("readContextPercent", () => {
  it("returns contextUsage.percent from a get_session_stats response", async () => {
    const client = clientResponding({
      type: "response",
      command: "get_session_stats",
      success: true,
      data: {
        sessionFile: "/tmp/session.jsonl",
        sessionId: "abc123",
        contextUsage: { tokens: 60_000, contextWindow: 200_000, percent: 30 },
      },
    });

    await expect(readContextPercent(client)).resolves.toBe(30);
    expect(client.command).toHaveBeenCalledWith({ type: "get_session_stats" }, 2_000);
  });

  it("returns undefined when the command fails, times out, or lacks a numeric percent", async () => {
    // Command failure (e.g. child exited, RPC error).
    await expect(
      readContextPercent(clientResponding({ type: "response", success: false, error: "process exited" })),
    ).resolves.toBeUndefined();
    // The 2 s timeout surfacing as a failed response from client.command.
    await expect(
      readContextPercent(
        clientResponding({ type: "response", success: false, error: "no response within 2000ms" }),
      ),
    ).resolves.toBeUndefined();
    // A command that rejects outright must never throw out of the reader.
    const rejecting = {
      command: vi.fn(async () => {
        throw new Error("boom");
      }),
      isAlive: () => true,
    } as unknown as RpcUnitClient;
    await expect(readContextPercent(rejecting)).resolves.toBeUndefined();
    // Success without usable context usage.
    await expect(
      readContextPercent(clientResponding({ type: "response", success: true, data: {} })),
    ).resolves.toBeUndefined();
    await expect(
      readContextPercent(
        clientResponding({ type: "response", success: true, data: { contextUsage: null } }),
      ),
    ).resolves.toBeUndefined();
    await expect(
      readContextPercent(
        clientResponding({ type: "response", success: true, data: { contextUsage: { tokens: 1 } } }),
      ),
    ).resolves.toBeUndefined();
    // Null percent (post-compaction) is not numeric.
    await expect(
      readContextPercent(
        clientResponding({ type: "response", success: true, data: { contextUsage: { percent: null } } }),
      ),
    ).resolves.toBeUndefined();
    await expect(
      readContextPercent(
        clientResponding({
          type: "response",
          success: true,
          data: { contextUsage: { percent: "30" } },
        }),
      ),
    ).resolves.toBeUndefined();
  });
});

describe("runImplementerUnit context capture (T5)", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("a unit attempt whose child is alive after its report carries contextPercent read via get_session_stats before shutdown", async () => {
    const order: string[] = [];
    let stdout = "";
    const listeners: Array<(e: Record<string, unknown>) => void> = [];
    const client = {
      prompt: vi.fn(),
      steer: vi.fn(),
      send: vi.fn(),
      command: vi.fn(async () => {
        order.push("stats");
        return {
          type: "response",
          command: "get_session_stats",
          success: true,
          data: { contextUsage: { tokens: 60_000, contextWindow: 200_000, percent: 42 } },
        } as RpcResponse;
      }),
      shutdown: vi.fn(async () => {
        order.push("shutdown");
      }),
      kill: vi.fn(),
      onEvent: (fn: (e: Record<string, unknown>) => void) => {
        listeners.push(fn);
        return () => {};
      },
      onExit: () => () => {},
      rawStdout: () => stdout,
      stderrText: () => "",
      isAlive: () => true,
    } as unknown as RpcUnitClient;

    const run = runImplementerUnitWithClient(client, "task", { timeoutMs: 600_000 });
    const reportText = 'done.\n```json\n{"summary":"ok"}\n```';
    const message = {
      type: "message_end",
      message: { role: "assistant", content: [{ type: "text", text: reportText }] },
    };
    stdout += `${JSON.stringify(message)}\n`;
    for (const l of listeners) l(message);

    const res = await run;
    expect(res.summary).toBe("ok");
    expect(res.error).toBeUndefined();
    expect(res.contextPercent).toBe(42);
    expect(client.command).toHaveBeenCalledWith({ type: "get_session_stats" }, 2_000);
    expect(order).toEqual(["stats", "shutdown"]);
  });
});
