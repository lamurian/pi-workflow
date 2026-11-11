import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  DEADLINE_HANDOVER_MESSAGE,
  DEADLINE_HANDOVER_ROUNDS,
  DEADLINE_IDLE_TIMEOUT_MS,
  DEADLINE_REPORT_TIMEOUT_MS,
  runDeadlineHandover,
} from "../extensions/deadline-handover.ts";
import type { RpcUnitClient } from "../extensions/rpc-unit-client.ts";

const FENCE = "`".repeat(3);

function reportJson(summary: string): string {
  return (
    `${FENCE}json\n` +
    JSON.stringify({ summary, status: "partial", findings: ["f"], nextSteps: "n" }) +
    `\n${FENCE}`
  );
}

function makeClient() {
  let stdout = "";
  const eventListeners = new Set<(e: Record<string, unknown>) => void>();
  const exitListeners = new Set<(info: { code: number }) => void>();
  const send = vi.fn();
  const prompt = vi.fn();
  const kill = vi.fn();
  const client = {
    send,
    prompt,
    kill,
    steer: vi.fn(),
    command: vi.fn(),
    shutdown: vi.fn(async () => {}),
    onEvent: (fn: (e: Record<string, unknown>) => void) => {
      eventListeners.add(fn);
      return () => eventListeners.delete(fn);
    },
    onExit: (fn: (info: { code: number }) => void) => {
      exitListeners.add(fn);
      return () => exitListeners.delete(fn);
    },
    rawStdout: () => stdout,
    stderrText: () => "",
    isAlive: () => true,
  } as unknown as RpcUnitClient;
  const emit = (event: Record<string, unknown>) => {
    stdout += `${JSON.stringify(event)}\n`;
    for (const fn of [...eventListeners]) fn(event);
  };
  const say = (text: string) =>
    emit({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text }] } });
  return { client, send, prompt, kill, emit, say };
}

/** Advance one full round's idle wait (round starts with the RPC abort). */
async function passIdleWait(): Promise<void> {
  await vi.advanceTimersByTimeAsync(DEADLINE_IDLE_TIMEOUT_MS);
}

/** Advance one full round's report wait. */
async function passReportWait(): Promise<void> {
  await vi.advanceTimersByTimeAsync(DEADLINE_REPORT_TIMEOUT_MS);
}

describe("runDeadlineHandover (T2.1)", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("performs up to 3 rounds of RPC abort, a wait of up to 5 s for idle, the handover prompt, and a wait for a parseable report", async () => {
    const stub = makeClient();
    const run = runDeadlineHandover(stub.client);

    // Round 1: the RPC abort goes out immediately; the prompt waits for idle.
    expect(stub.send).toHaveBeenCalledTimes(1);
    expect(stub.send).toHaveBeenCalledWith({ type: "abort" });
    expect(stub.prompt).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(DEADLINE_IDLE_TIMEOUT_MS - 1);
    expect(stub.prompt).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(stub.prompt).toHaveBeenCalledTimes(1);
    expect(stub.prompt).toHaveBeenCalledWith(DEADLINE_HANDOVER_MESSAGE);

    // Report wait: the next round's abort only leaves after the 30 s cap.
    await vi.advanceTimersByTimeAsync(DEADLINE_REPORT_TIMEOUT_MS - 1);
    expect(stub.send).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(stub.send).toHaveBeenCalledTimes(2);

    // Round 2 repeats abort -> idle wait -> prompt -> report wait.
    await passIdleWait();
    expect(stub.prompt).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(DEADLINE_REPORT_TIMEOUT_MS - 1);
    expect(stub.send).toHaveBeenCalledTimes(2);

    // A parseable report during round 2's report wait ends the routine.
    stub.say(reportJson("late report"));
    const result = await run;
    expect(result.report?.summary).toBe("late report");
    expect(result.timedOut).toBe(true);
    expect(stub.send).toHaveBeenCalledTimes(2);
    expect(stub.kill).not.toHaveBeenCalled();
  });

  it("prompts as soon as the child goes idle, before the 5 s cap", async () => {
    const stub = makeClient();
    const run = runDeadlineHandover(stub.client);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(stub.prompt).not.toHaveBeenCalled();
    stub.emit({ type: "agent_end", willRetry: false }); // run ends -> child idle
    await vi.advanceTimersByTimeAsync(0);
    expect(stub.prompt).toHaveBeenCalledTimes(1);
    stub.say(reportJson("idle handover"));
    const result = await run;
    expect(result.report?.summary).toBe("idle handover");
    expect(result.timedOut).toBe(true);
    expect(stub.kill).not.toHaveBeenCalled();
  });

  it("the handover prompt demands the JSON report now: status partial, findings and nextSteps, no tools", () => {
    expect(DEADLINE_HANDOVER_MESSAGE).toMatch(/deadline hit/i);
    expect(DEADLINE_HANDOVER_MESSAGE).toMatch(/status partial/);
    expect(DEADLINE_HANDOVER_MESSAGE).toMatch(/findings/);
    expect(DEADLINE_HANDOVER_MESSAGE).toMatch(/nextSteps/);
    expect(DEADLINE_HANDOVER_MESSAGE).toMatch(/no tools/);
  });

  for (let round = 1; round <= DEADLINE_HANDOVER_ROUNDS; round++) {
    it(`a parseable report received in round ${round} returns that report with timedOut true and without a SIGKILL`, async () => {
      const stub = makeClient();
      const run = runDeadlineHandover(stub.client);
      // Burn the earlier rounds without a report.
      for (let earlier = 1; earlier < round; earlier++) {
        await passIdleWait();
        await passReportWait();
      }
      await passIdleWait();
      expect(stub.prompt).toHaveBeenCalledTimes(round);
      stub.say(reportJson(`report from round ${round}`));
      const result = await run;
      expect(result.timedOut).toBe(true);
      expect(result.report?.summary).toBe(`report from round ${round}`);
      expect(result.report?.status).toBe("partial");
      expect(stub.kill).not.toHaveBeenCalled();
      expect(vi.getTimerCount()).toBe(0);
    });
  }

  it("with no report after the third round the routine SIGKILLs the child and the caller reports timedOut true", async () => {
    const stub = makeClient();
    const run = runDeadlineHandover(stub.client);

    // Rounds 1 and 2 fail without a report: no kill yet.
    for (let earlier = 0; earlier < 2; earlier++) {
      await passIdleWait();
      await passReportWait();
    }
    expect(stub.kill).not.toHaveBeenCalled();
    expect(stub.prompt).toHaveBeenCalledTimes(2);

    // Round 3 runs its full idle wait, then its full report wait.
    await passIdleWait();
    expect(stub.prompt).toHaveBeenCalledTimes(3);
    expect(stub.kill).not.toHaveBeenCalled();
    await passReportWait();

    const result = await run;
    expect(stub.send).toHaveBeenCalledTimes(DEADLINE_HANDOVER_ROUNDS);
    for (const call of stub.send.mock.calls) expect(call).toEqual([{ type: "abort" }]);
    expect(stub.kill).toHaveBeenCalledTimes(1);
    expect(result.timedOut).toBe(true);
    expect(result.report).toBeUndefined();
    expect(vi.getTimerCount()).toBe(0);
  });
});
