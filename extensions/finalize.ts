import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { loadState, transitionTo, updateUi } from "./state.ts";
import type { FileEntry } from "./state.ts";
import { validateContract, preserveContractDoneStatuses } from "./contract-v2-validate.ts";
import { checkTaskBreadth } from "./contract-breadth.ts";
import { collectBehaviorWarnings, deriveTaskContract } from "./contract-v1-view.ts";
import { loadWorkflowConfig, resolveMaxPathsPerTask } from "./paths.ts";
import { detectTestSuites, projectFacts } from "./test-tool-detect.ts";
import { ensureTestTool } from "./test-tool-ensure.ts";
import { isTestPath } from "./test-scan-profiles.ts";
import { deriveMatches, type DeriveResult } from "./test-scan-derive.ts";
import { crossCheck } from "./test-scan-check.ts";
import { renderEvidence } from "./test-scan-render.ts";
import { loadContent } from "./utils.ts";

/** Fixed find excludes for the contract scan. */
const SCAN_EXCLUDES = ["node_modules", ".git", "dist", "build", "coverage", ".venv", "vendor"];
/** Scan exec budget: enumerate + read is local I/O, 5s covers cold caches. */
const SCAN_BUDGET_MS = 5000;
/** Per-file size cap for JS-side reads; larger files are skipped, not fatal. */
const MAX_SCAN_FILE_BYTES = 256 * 1024;
/** Tracked-path read budget: one git ls-tree, 5s covers cold caches. */
const TRACKED_BUDGET_MS = 5000;
/** Rejection text for the legacy files/behaviors save_task payload. */
const LEGACY_PAYLOAD_REJECTION =
  "save_task rejected: the legacy files/behaviors payload is not " +
  "accepted — call save_task with the contract v2 payload " +
  "{ title, instruction, done, sources, tests, tasks } where each " +
  "sources/tests entry is { path, status?, tasks } and each tasks " +
  "entry is { id, description, expectedOutput[], status? } (see content/finalize-prompt.md).";

/** Read a file JS-side with size cap and binary sniffing; null when skipped. */
function readCapped(full: string): string | null {
  try {
    const stat = statSync(full);
    if (!stat.isFile() || stat.size > MAX_SCAN_FILE_BYTES) return null;
    const buf = readFileSync(full);
    if (buf.subarray(0, 1024).includes(0)) return null; // binary sniff
    return buf.toString("utf8");
  } catch {
    return null;
  }
}

/**
 * Read the repo-relative paths tracked at HEAD (T10): the input the derived
 * v1 view needs to render a path M when tracked and A when untracked.
 *
 * @param pi  - ExtensionAPI reference (for exec access).
 * @param cwd - Repository working directory.
 * @returns The tracked path set; empty when git is unavailable (everything
 *          then renders as A).
 */
async function readTrackedPaths(pi: ExtensionAPI, cwd: string): Promise<Set<string>> {
  try {
    const res = await pi.exec("git", ["ls-tree", "-r", "--name-only", "HEAD"], {
      cwd,
      timeout: TRACKED_BUDGET_MS,
    });
    if (res.code !== 0) return new Set();
    return new Set(
      (res.stdout ?? "")
        .split("\n")
        .map((l) => l.trim().replace(/^\.\//, ""))
        .filter(Boolean),
    );
  } catch {
    return new Set();
  }
}

/**
 * Run the deterministic contract scan for a drafted contract.
 *
 * Enumerates files via `find` (fixed excludes), reads matched test files and
 * contract entries JS-side (size caps, binary sniff), derives per-entry
 * findings with the matched language profile, and cross-checks them against
 * the declared files. Pure decision logic lives in the test-scan modules.
 *
 * @param pi    - ExtensionAPI reference (for exec access).
 * @param cwd   - Working directory to scan.
 * @param files - The contract's declared file entries ({ path, status }).
 * @returns Evidence + advisory warnings, or null when the scan is unavailable
 *          (exec failure, non-zero exit, empty listing) — callers degrade to
 *          "scan unavailable" without blocking the save.
 */
export async function runContractScan(
  pi: ExtensionAPI,
  cwd: string,
  files: readonly FileEntry[],
): Promise<{ evidence: string[]; warnings: string[] } | null> {
  try {
    const findArgs = [".", "-type", "f"];
    for (const ex of SCAN_EXCLUDES) findArgs.push("-not", "-path", `*/${ex}/*`);
    const res = await pi.exec("find", findArgs, { cwd, timeout: SCAN_BUDGET_MS });
    if (res.code !== 0) return null;
    const listing = (res.stdout ?? "")
      .split("\n")
      .map((l) => l.trim().replace(/^\.\//, ""))
      .filter(Boolean);
    if (listing.length === 0) return null;
    const onDisk = new Set(listing);
    const paths = files.map((f) => f.path);
    const contents = new Map<string, string>();
    for (const p of listing) {
      if (!isTestPath(p) && !paths.includes(p)) continue;
      const text = readCapped(join(cwd, p));
      if (text !== null) contents.set(p, text);
    }
    const findings = new Map<string, DeriveResult>();
    for (const f of files) findings.set(f.path, deriveMatches(f.path, contents));
    const result = crossCheck(files, findings, onDisk);
    return { evidence: result.evidence, warnings: result.warnings };
  } catch {
    return null;
  }
}

/**
 * Finalize the discussion: steer the agent to draft the task contract.
 *
 * Valid only from the discussing phase. Loads finalize-prompt.md, appends
 * the optional engineer's note, and hands the prompt to the agent as a
 * steer. The agent drafts the contract and calls save_task; the extension
 * performs the phase transition there.
 *
 * @param args - Optional note folded into the prompt as an Engineer's note.
 * @param pi   - ExtensionAPI reference.
 * @param ctx  - Extension context.
 */
export async function runFinalize(
  args: string,
  pi: ExtensionAPI,
  ctx: ExtensionContext,
): Promise<void> {
  const state = loadState(ctx);
  if (!state || state.phase !== "discussing") {
    ctx.ui.notify(
      "/finalize is only valid during the discussing phase. Run /discuss first.",
      "warning",
    );
    return;
  }
  let prompt = await loadContent("finalize-prompt.md");
  const note = args.trim();
  if (note) {
    prompt +=
      `\n\n## Engineer's note\n\n${note}` +
      "\n\nFold this note into the contract where relevant.";
  }
  pi.sendUserMessage(prompt, { deliverAs: "steer" });
}

/**
 * Register the `save_task` AI tool.
 *
 * The agent calls save_task to persist a drafted or revised contract v2
 * payload ({ title, instruction, done, sources, tests, tasks }). The
 * extension validates it deterministically, stores it directly as
 * `state.contractV2` (so no declared path is ever ownerless), derives the
 * v1 TaskContract view older consumers read into `state.task`, and
 * transitions the workflow to the finalizing phase. The legacy
 * files/behaviors payload is rejected with a reason naming the v2 fields.
 * Idempotent: safe to call again while already finalizing to update the
 * contract (done statuses are preserved by task id).
 *
 * @param pi - ExtensionAPI reference.
 */
export function registerSaveTaskTool(pi: ExtensionAPI): void {
  pi.registerTool({
    name: "save_task",
    label: "Save Task",
    description:
      "Persist the task contract. Call once the contract is drafted or " +
      "revised. Validates the payload, stores the task, and transitions " +
      "the workflow to the finalizing phase.",

    parameters: Type.Object(
      {
        title: Type.String({ description: "Short task title" }),
        instruction: Type.String({ description: "What to implement" }),
        done: Type.Optional(Type.String({ description: "Definition of done" })),
        sources: Type.Optional(
          Type.Array(Type.Unknown(), {
            description: "Implementation files: { path, status?, tasks }",
          }),
        ),
        tests: Type.Optional(
          Type.Array(Type.Unknown(), {
            description: "Test/fixture files: { path, status?, tasks }",
          }),
        ),
        tasks: Type.Optional(
          Type.Array(Type.Unknown(), {
            description: "Task units: { id, description, expectedOutput[], status? }",
          }),
        ),
        files: Type.Optional(
          Type.Unknown({ description: "Legacy allowlist — rejected; use sources/tests/tasks" }),
        ),
        behaviors: Type.Optional(
          Type.Unknown({ description: "Legacy behaviors — rejected; use tasks" }),
        ),
      },
      { additionalProperties: true },
    ),

    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const state = loadState(ctx);
      if (!state || (state.phase !== "discussing" && state.phase !== "finalizing")) {
        return {
          content: [
            { type: "text", text: "save_task requires the discussing or finalizing phase." },
          ],
          details: {},
          isError: true,
        };
      }
      const raw = params as Record<string, unknown>;
      const legacy = raw.files !== undefined || raw.behaviors !== undefined;
      if (legacy || raw.sources === undefined || raw.tests === undefined || raw.tasks === undefined) {
        return {
          content: [{ type: "text", text: LEGACY_PAYLOAD_REJECTION }],
          details: {},
          isError: true,
        };
      }
      const result = validateContract(raw);
      if (!result.ok) {
        return {
          content: [{ type: "text", text: `save_task rejected: ${result.reason}` }],
          details: {},
          isError: true,
        };
      }
      // T10: validated contract stored directly; done statuses preserved from the prior v2 contract by task id.
      const preserved = preserveContractDoneStatuses(state.contractV2, result.contract);
      // T1: per-task path cap — reject over-broad tasks before mutating state.
      const workflow = await loadWorkflowConfig(ctx.cwd);
      const tooBroad = checkTaskBreadth(preserved.contract, resolveMaxPathsPerTask(workflow));
      if (tooBroad !== null) {
        return { content: [{ type: "text", text: `save_task rejected: ${tooBroad}` }], details: {}, isError: true };
      }
      state.contractV2 = preserved.contract;
      const tracked = await readTrackedPaths(pi, ctx.cwd);
      state.task = deriveTaskContract(preserved.contract, tracked);
      const behaviorWarnings = state.task.behaviors.flatMap(collectBehaviorWarnings);
      // T3/T7: ensure the test tool after validation (orchestrator-owned file,
      // never injected). Precedence: config -> external `test` -> detection -> none.
      const detection = await detectTestSuites(projectFacts(ctx.cwd), workflow);
      const ensured = await ensureTestTool(pi, ctx.cwd, detection);
      const { source, suites, fullSuites } = ensured;
      state.testTool = { source, suites, fullSuites };
      const scan = await runContractScan(pi, ctx.cwd, state.task.files);
      const allWarnings = [...behaviorWarnings, ...(detection.warnings ?? []), ...(scan?.warnings ?? [])];
      const entering = state.phase === "discussing";
      transitionTo(pi, state, "finalizing");
      updateUi(state, ctx);
      if (entering) {
        ctx.ui.notify(
          `Contract saved. Phase: finalizing — review the contract, run /implement when ready. ` +
            `(warnings: ${allWarnings.length})`,
          "info",
        );
      }
      let text =
        "Task saved. Phase: finalizing (read-only). " +
        "Wait for the user to run /implement once the contract is approved.";
      if (scan === null) {
        text += "\n\nNote: scan unavailable — apply judgment from the discussion.";
      } else if (scan.evidence.length > 0) {
        text +=
          "\n\n## Test scan evidence (advisory)\n" +
          renderEvidence(scan.evidence)
            .split("\n")
            .map((l) => `- ${l}`)
            .join("\n");
      }
      // T3: echo the test-tool detection evidence line.
      text += `\n${ensured.message}`;
      if (preserved.preserved.length > 0) {
        text += `\n\nPreserved done behaviors: ${preserved.preserved.join(", ")}`;
      }
      if (allWarnings.length > 0) {
        text +=
          "\n\nWarnings (advisory — the contract was saved):\n" +
          allWarnings.map((w) => `warning: ${w}`).join("\n");
      }
      return {
        content: [{ type: "text", text }],
        details: {},
      };
    },
  });
}
