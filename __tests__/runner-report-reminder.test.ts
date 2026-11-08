import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { runImplementerUnitWithClient } from "../extensions/implementer-runner.ts";
import { REPORT_REMINDER_MESSAGE } from "../extensions/report-reminder.ts";
import type { RpcUnitClient } from "../extensions/rpc-unit-client.ts";

const FENCE = "`".repeat(3);

function makeClient() {
  let stdout = "";
  const listeners: Array<(e: Record<string, unknown>) => void> = [];
  const prompt = vi.fn();
  const client = {
    prompt,
    steer: vi.fn(),
    onEvent: (fn: (e: Record<string, unknown>) => void) => {
      listeners.push(fn);
      return () => {};
    },
    onExit: () => () => {},
    kill: vi.fn(),
    shutdown: vi.fn(async () => {}),
    isAlive: () => false,
    rawStdout: () => stdout,
    stderrText: () => "",
  } as unknown as RpcUnitClient;
  const emit = (e: Record<string, unknown>) => {
    stdout += `${JSON.stringify(e)}\n`;
    for (const l of listeners) l(e);
  };
  const say = (text: string) =>
    emit({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text }] } });
  return { client, prompt, emit, say };
}

describe("report reminder", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  async function start() {
    const stub = makeClient();
    let settled = false;
    const run = runImplementerUnitWithClient(stub.client, "task", { timeoutMs: 600_000 }).then((r) => {
      settled = true;
      return r;
    });
    stub.emit({ type: "tool_execution_start" });
    stub.say("did the work");
    stub.emit({ type: "agent_end", willRetry: false, messages: [] });
    await vi.advanceTimersByTimeAsync(10);
    return { ...stub, run, isSettled: () => settled };
  }

  it("sends exactly one steer reminder and keeps waiting", async () => {
    const s = await start();
    const reminders = s.prompt.mock.calls.filter((c) => c[0] === REPORT_REMINDER_MESSAGE);
    expect(reminders).toEqual([[REPORT_REMINDER_MESSAGE, "steer"]]);
    expect(s.isSettled()).toBe(false);
    s.emit({ type: "agent_end", willRetry: false });
    await s.run;
  });

  it("settles with the report emitted after the reminder", async () => {
    const s = await start();
    s.say(`${FENCE}json\n{"summary":"done late"}\n${FENCE}`);
    const r = await s.run;
    expect(r.summary).toBe("done late");
    expect(r.timedOut).toBeUndefined();
  });

  it("settles immediately on a second report-less agent_end", async () => {
    const s = await start();
    s.say("still no report");
    s.emit({ type: "agent_end", willRetry: false, messages: [] });
    await vi.advanceTimersByTimeAsync(10);
    expect(s.isSettled()).toBe(true);
    const r = await s.run;
    expect(r.missingReport).toBe(true);
    expect(r.timedOut).toBeUndefined();
  });
});
