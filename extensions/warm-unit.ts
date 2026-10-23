// ─── Warm unit children (T5) ──────────────────────────────────────────────────
// Test-kind children stay alive after their report so hook-rejected/no-changes
// retries steer into the SAME child (attempt recording, warm steer, completion shutdowns).

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { RpcUnitClient } from "./rpc-unit-client.ts";
import type { UnitTask } from "./implementer-runner.ts";
import type { UnitAttempt, UnitRunner, OrchestratorResult } from "./implement-loop.ts";
import type { Behavior, WorkflowState } from "./state.ts";
import type { AttemptOutcome, AttemptRecord } from "./halt-report.ts";
import type { ImplementerReport } from "./implementer-report.ts";
import {
  SOFT_DEADLINE_RATIO,
  WRAP_UP_STEER_MESSAGE,
  hasParseableReport,
} from "./implementer-runner.ts";
import { lastAssistantText, parseImplementerReport } from "./implementer-report.ts";
import { getImplementerTimeoutMs } from "./process-utils.ts";
import {
  createToolCallCollector,
  renderToolCallDigest,
  type ToolCallCollector,
} from "./findings-ledger.ts";
import { classifyProgress } from "./unit-progress.ts";
import { classifyAttemptOutcome, truncateAttemptText } from "./halt-report.ts";
import { readGitHead } from "./git-ops.ts";
import { saveState, updateUi } from "./state.ts";
import { getActiveUnitClient, setActiveUnitClient } from "./unit-client-registry.ts";
import { openVerificationPause, type PauseOutcome } from "./hitl-pause.ts";

/** Maximum warm steers per kept-alive child before a fresh spawn takes over. */
export const WARM_STEER_CAP = 5;

/**
 * Decide whether a fix round can be steered into a kept-alive child.
 * @param client     - The kept-alive child from the previous attempt, if any.
 * @param steersUsed - Warm steers already delivered to that child.
 * @returns True when the child exists, is alive and is below WARM_STEER_CAP.
 */
export function canSteerWarmChild(
  client: RpcUnitClient | undefined,
  steersUsed: number,
): boolean {
  return client !== undefined && steersUsed < WARM_STEER_CAP && client.isAlive();
}

/**
 * Shut down a kept-alive child and clear the active-client registry
 * (idempotent: a dead or absent child only clears the registry entry).
 * @param client - The child to shut down (may be undefined).
 */
export async function shutdownWarmChild(client: RpcUnitClient | undefined): Promise<void> {
  if (!client) return;
  if (client.isAlive()) await client.shutdown(2_000);
  if (getActiveUnitClient() === client) setActiveUnitClient(undefined);
}

/** Result of one warm steer round: the NEW report, or failure diagnostics. */
export type SteerRoundResult = ImplementerReport & {
  error?: string;
  timedOut?: boolean;
};

/**
 * Steer a fix task into a kept-alive child and await a NEW report: only stdout
 * emitted AFTER the steer settles it (never the earlier report); timers re-arm per round.
 * @param client    - Live child from the previous attempt.
 * @param taskText  - Fix task text (buildFixTask output).
 * @param onEvent   - Optional sink for live stdout events (relay + digest).
 * @param timeoutMs - Per-round wall clock; 0 disables both timers.
 * @returns The new report, or error/timedOut diagnostics.
 */
export async function steerFixRound(
  client: RpcUnitClient,
  taskText: string,
  onEvent?: (event: Record<string, unknown>) => void,
  timeoutMs: number = getImplementerTimeoutMs(),
): Promise<SteerRoundResult> {
  const offset = client.rawStdout().length;
  const slice = () => client.rawStdout().slice(offset);
  let timedOut = false;
  let reportSeen = false;
  let exitCode = 0;
  let settle: () => void = () => {};
  const done = new Promise<void>((resolve) => {
    settle = resolve;
  });
  const checkReport = () => {
    if (!reportSeen && hasParseableReport(lastAssistantText(slice()))) {
      reportSeen = true;
      settle();
    }
  };
  const unsubEvents = client.onEvent((event) => {
    onEvent?.(event);
    checkReport();
  });
  const unsubExit = client.onExit((info) => {
    exitCode = info.code;
    if (!reportSeen) settle();
  });
  const timer =
    timeoutMs > 0
      ? setTimeout(() => {
          timedOut = true;
          client.kill();
        }, timeoutMs)
      : undefined;
  const softTimer =
    timeoutMs > 0
      ? setTimeout(
          () => client.steer(WRAP_UP_STEER_MESSAGE),
          Math.floor(timeoutMs * SOFT_DEADLINE_RATIO),
        )
      : undefined;
  client.steer(taskText);
  await done;
  if (timer) clearTimeout(timer);
  if (softTimer) clearTimeout(softTimer);
  unsubEvents();
  unsubExit();

  const report = parseImplementerReport(slice());
  if (timedOut) {
    const marker = `warm retry timed out after ${timeoutMs}ms`;
    const stderr = client.stderrText().trim();
    return { ...report, error: stderr ? `${stderr}\n${marker}` : marker, timedOut: true };
  }
  if (!reportSeen) {
    return {
      ...report,
      error:
        client.stderrText().trim() ||
        `unit child exited with code ${exitCode} without a new report after the steer`,
    };
  }
  return report;
}

export interface AttemptRecorderHooks {
  behaviorId: string;
  cwd: string;
  runUnit: UnitRunner;
  relay: (event: Record<string, unknown>) => void;
  recordFindings: (behaviorId: string, texts: string[] | undefined) => boolean;
  fingerprint: () => Promise<string>;
  head: () => Promise<string | null>;
  history: AttemptRecord[];
}

export interface AttemptRecorder {
  runFresh: (unit: UnitTask) => Promise<UnitAttempt>;
  runSteer: (client: RpcUnitClient, taskText: string) => Promise<UnitAttempt>;
  sealLast: (outcome: AttemptOutcome) => void;
  progress: () => boolean;
  headBefore: () => string | null;
}

/**
 * Build the per-behavior attempt recorder: fingerprint before each round,
 * record findings, classify outcomes, keep the halt-report history.
 * @param hooks - Behavior id, runner, relay, ledger and git callbacks.
 * @returns The recorder for one behavior's rounds.
 */
export function createAttemptRecorder(hooks: AttemptRecorderHooks): AttemptRecorder {
  let fingerprintBefore = "";
  let headBefore: string | null = null;
  let newFindings = false;
  let progress = false;

  const finish = async (
    out: UnitAttempt,
    startedAt: number,
    digest: ToolCallCollector,
  ): Promise<UnitAttempt> => {
    newFindings = hooks.recordFindings(hooks.behaviorId, out.findings);
    if (out.timedOut || out.missingReport) {
      const digestText = renderToolCallDigest(digest.entries());
      if (digestText) {
        newFindings = hooks.recordFindings(hooks.behaviorId, [digestText]) || newFindings;
      }
    }
    const outcome = classifyAttemptOutcome(out);
    progress = newFindings;
    if (outcome === "timeout" || outcome === "partial") {
      progress =
        classifyProgress({
          fingerprintBefore,
          fingerprintAfter: await hooks.fingerprint(),
          newFindings,
        }) || newFindings;
    }
    hooks.history.push({
      attempt: hooks.history.length + 1,
      outcome,
      durationSec: Math.max(0, Math.round((Date.now() - startedAt) / 1000)),
      progress,
      lastText: truncateAttemptText(out.error ?? out.summary ?? ""),
    });
    return out;
  };

  const beginRound = async () => {
    fingerprintBefore = await hooks.fingerprint();
    headBefore = await hooks.head();
    newFindings = false;
    return { startedAt: Date.now(), digest: createToolCallCollector() };
  };

  return {
    runFresh: async (unit) => {
      const { startedAt, digest } = await beginRound();
      const out = await hooks.runUnit(unit, hooks.cwd, undefined, (event) => {
        digest.record(event);
        hooks.relay(event);
      });
      return finish(out, startedAt, digest);
    },
    runSteer: async (client, taskText) => {
      const { startedAt, digest } = await beginRound();
      const out = await steerFixRound(client, taskText, (event) => {
        digest.record(event);
        hooks.relay(event);
      });
      return finish(out, startedAt, digest);
    },
    sealLast: (outcome) => {
      const last = hooks.history[hooks.history.length - 1];
      if (last) last.outcome = outcome;
    },
    progress: () => progress,
    headBefore: () => headBefore,
  };
}

export interface BehaviorCompletionDeps {
  pi: ExtensionAPI;
  ctx: ExtensionContext;
  state: WorkflowState;
  behavior: Behavior;
  result: OrchestratorResult;
  position: string;
  client?: RpcUnitClient;
}

/**
 * Complete a behavior without a commit (already implemented at HEAD): shut down
 * the child, mark the behavior done, persist state.
 * @param deps - Loop state mutated in place (behavior, workflow state, result).
 */
export async function completeAlreadySatisfied(deps: BehaviorCompletionDeps): Promise<void> {
  const { pi, ctx, state, behavior, result, position, client } = deps;
  behavior.status = "done";
  await shutdownWarmChild(client);
  result.satisfiedWithoutCommit.push(behavior.id);
  ctx.ui.setStatus("implement", `✦ ${behavior.id} (${position}): already satisfied`);
  state.lastMarkedHead = (await readGitHead(pi, ctx.cwd)) ?? state.lastMarkedHead;
  state.lastHalt = undefined;
  saveState(pi, state);
  updateUi(state, ctx);
  ctx.ui.notify(`${behavior.id} already satisfied at HEAD — no commit needed`, "info");
}

/**
 * Complete an out-of-repo behavior: done, left uncommitted, child shut down.
 * @param deps - Loop state mutated in place; `behavior.sourceFile` is required.
 */
export async function completeLeftUncommitted(deps: BehaviorCompletionDeps): Promise<void> {
  const { pi, ctx, state, behavior, result, position, client } = deps;
  behavior.status = "done";
  await shutdownWarmChild(client);
  result.leftUncommitted!.push({ behaviorId: behavior.id, sourceFile: behavior.sourceFile! });
  ctx.ui.setStatus("implement", `✦ ${behavior.id} (${position}): done (left uncommitted)`);
  state.lastHalt = undefined;
  saveState(pi, state);
  updateUi(state, ctx);
  ctx.ui.notify(
    `${behavior.id} done — left uncommitted (sourceFile outside repo: ${behavior.sourceFile}); commit it manually`,
    "info",
  );
}

/**
 * Manual-kind verification pause: pause for human approval, then shut the child down.
 * @param ctx      - Extension context (UI, pause window).
 * @param behavior - The manual behavior being verified.
 * @param client   - The kept-alive manual child.
 * @returns The pause outcome (approval, clock expiry, or cancellation).
 */
export async function runManualVerificationPause(
  ctx: ExtensionContext,
  behavior: Behavior,
  client: RpcUnitClient,
): Promise<PauseOutcome> {
  const outcome = await openVerificationPause(ctx, behavior);
  await shutdownWarmChild(client);
  return outcome;
}
