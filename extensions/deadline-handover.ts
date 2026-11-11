import {
  hasParseableReport,
  lastAssistantText,
  parseImplementerReport,
  type ImplementerReport,
} from "./implementer-report.ts";
import type { RpcUnitClient } from "./rpc-unit-client.ts";

/** Maximum rounds of abort/prompt/wait performed at the wall clock. */
export const DEADLINE_HANDOVER_ROUNDS = 3;

/** Per-round cap (ms) on waiting for the child to go idle after the RPC abort. */
export const DEADLINE_IDLE_TIMEOUT_MS = 5_000;

/** Per-round cap (ms) on waiting for a parseable report after the prompt. */
export const DEADLINE_REPORT_TIMEOUT_MS = 30_000;

/** Handover prompt delivered when the wall clock hits. */
export const DEADLINE_HANDOVER_MESSAGE =
  "deadline hit: emit the JSON report now with status partial, findings and " +
  "nextSteps, no tools";

/** Outcome of the deadline handover. */
export interface DeadlineHandoverResult {
  /** Parseable report captured in one of the rounds, when any round produced one. */
  report?: ImplementerReport;
  /** Always true: the routine only runs after the wall clock hit. */
  timedOut: true;
}

/**
 * Wait until the child is idle (its run ended via `agent_end`, or the child
 * exited) or the cap elapses.
 *
 * @param client   - Live RPC client for the unit subprocess.
 * @param timeoutMs - Cap on the idle wait.
 * @returns Resolves when idle is detected or the cap elapses.
 */
function waitUntilIdle(client: RpcUnitClient, timeoutMs: number): Promise<void> {
  return new Promise((resolve) => {
    let settled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const unsubs: Array<() => void> = [];
    const finish = (): void => {
      if (settled) return;
      settled = true;
      if (timer !== undefined) clearTimeout(timer);
      for (const unsub of unsubs) unsub();
      resolve();
    };
    unsubs.push(
      client.onEvent((event) => {
        if (event.type === "agent_end") finish();
      }),
    );
    // Fires synchronously when the child already exited (real-client contract);
    // finish() runs before this unsub is pushed, which is harmless (no-op).
    unsubs.push(client.onExit(() => finish()));
    if (!settled) timer = setTimeout(finish, timeoutMs);
  });
}

/**
 * Wait for a parseable report block in the child's stdout.
 *
 * Checks on every stdout event and on child exit (a flushed report still
 * counts); settles early with false when the child dies report-less, and
 * with false when the cap elapses.
 *
 * @param client   - Live RPC client for the unit subprocess.
 * @param timeoutMs - Cap on the report wait.
 * @returns True when a parseable report is present by the time it settles.
 */
function waitForReport(client: RpcUnitClient, timeoutMs: number): Promise<boolean> {
  const check = (): boolean => hasParseableReport(lastAssistantText(client.rawStdout()));
  if (check()) return Promise.resolve(true);
  return new Promise((resolve) => {
    let settled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const unsubs: Array<() => void> = [];
    const finish = (found: boolean): void => {
      if (settled) return;
      settled = true;
      if (timer !== undefined) clearTimeout(timer);
      for (const unsub of unsubs) unsub();
      resolve(found);
    };
    unsubs.push(
      client.onEvent(() => {
        if (check()) finish(true);
      }),
    );
    unsubs.push(client.onExit(() => finish(check())));
    if (!settled) timer = setTimeout(() => finish(false), timeoutMs);
  });
}

/**
 * Run the enforced deadline handover for a unit whose wall clock hit.
 *
 * Up to 3 rounds, each: send the RPC `abort`, wait (<= 5 s) for the child to
 * go idle, prompt the handover message asking for the JSON report now
 * (status partial, findings, nextSteps, no tools), then wait (<= 30 s) for a
 * parseable report. A report found in any round returns immediately with
 * `timedOut: true` and no SIGKILL; only after the third round fails is the
 * child SIGKILLed, still with `timedOut: true`. Never throws.
 *
 * @param client - Live RPC client for the unit subprocess.
 * @returns The report (when found) plus `timedOut: true`.
 */
export async function runDeadlineHandover(client: RpcUnitClient): Promise<DeadlineHandoverResult> {
  for (let round = 0; round < DEADLINE_HANDOVER_ROUNDS; round++) {
    client.send({ type: "abort" });
    await waitUntilIdle(client, DEADLINE_IDLE_TIMEOUT_MS);
    client.prompt(DEADLINE_HANDOVER_MESSAGE);
    const found = await waitForReport(client, DEADLINE_REPORT_TIMEOUT_MS);
    if (found) return { report: parseImplementerReport(client.rawStdout()), timedOut: true };
  }
  client.kill();
  return { timedOut: true };
}
