// Kept-alive unit children support completion shutdowns, manual verification pauses and the
// attempt recorder. Hook-rejected fix rounds fresh-spawn instead (T6), so no warm-steer fix
// delivery lives here anymore (T7).

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { RpcUnitClient } from "./rpc-unit-client.ts";
import type { UnitTask } from "./implementer-runner.ts";
import type { UnitAttempt, UnitRunner, OrchestratorResult } from "./implement-loop.ts";
import type { Behavior, WorkflowState } from "./state.ts";
import type { AttemptOutcome, AttemptRecord } from "./halt-report.ts";
import { createToolCallCollector, renderToolCallDigest, type ToolCallCollector } from "./findings-ledger.ts";
import { classifyProgress } from "./unit-progress.ts";
import { truncateAttemptText } from "./halt-report.ts";
import { classifyAttemptOutcome } from "./halt-diagnosis.ts";
import { readGitHead } from "./git-ops.ts";
import { saveState, updateUi } from "./state.ts";
import { setTaskStatus } from "./task-status.ts";
import { getActiveUnitClient, setActiveUnitClient } from "./unit-client-registry.ts";
import { openVerificationPause, type PauseOutcome } from "./hitl-pause.ts";

/** Failure detail for a fix round the kept-alive child never picked up (T2). */
export const UNDELIVERED_STEER_ERROR =
  "fix round not delivered: the kept-alive child reports isStreaming false with no new stdout after the prompt";

/** Consecutive undelivered fix rounds that halt the run as infrastructure failure (T2). */
export const UNDELIVERED_HALT_THRESHOLD = 2;

/**
 * Halt error for repeated undelivered fix rounds: infrastructure failure, never a retry-budget message.
 * @param behaviorId - Behavior whose fix rounds were not delivered; rounds - consecutive undelivered rounds.
 * @returns The halt error text.
 */
export function buildUndeliveredHaltText(behaviorId: string, rounds: number): string {
  return (
    `Unit ${behaviorId}: ${rounds} consecutive fix rounds were not delivered — the kept-alive ` +
    `child stopped accepting steers (${UNDELIVERED_STEER_ERROR}). This is an infrastructure ` +
    `failure, not a verdict; the retry budget was not consumed. Re-run /implement to resume ` +
    `with a fresh child; if it repeats, restart the session.`
  );
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
      progress = classifyProgress({ fingerprintBefore,
        fingerprintAfter: await hooks.fingerprint(), newFindings }) || newFindings;
    }
    hooks.history.push({ attempt: hooks.history.length + 1, outcome,
      durationSec: Math.max(0, Math.round((Date.now() - startedAt) / 1000)), progress,
      lastText: truncateAttemptText(out.error ?? out.summary ?? "") });
    return out;
  };

  const beginRound = async () => {
    fingerprintBefore = await hooks.fingerprint(); headBefore = await hooks.head(); newFindings = false;
    return { startedAt: Date.now(), digest: createToolCallCollector() };
  };

  return {
    runFresh: async (unit) => {
      const { startedAt, digest } = await beginRound();
      const out = await hooks.runUnit(unit, hooks.cwd, undefined,
        (event) => { digest.record(event); hooks.relay(event); });
      return finish(out, startedAt, digest);
    },
    sealLast: (outcome) => { const last = hooks.history[hooks.history.length - 1]; if (last) last.outcome = outcome; },
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
  setTaskStatus(state, behavior.id, "done");
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
  setTaskStatus(state, behavior.id, "done");
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
export async function runManualVerificationPause(ctx: ExtensionContext, behavior: Behavior, client: RpcUnitClient): Promise<PauseOutcome> {
  const outcome = await openVerificationPause(ctx, behavior);
  await shutdownWarmChild(client);
  return outcome;
}
