import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { loadState, transitionTo, updateUi } from "./state.ts";
import { validateTask } from "./task-contract.ts";
import { isTestPath, deriveMatches, crossCheck, type DeriveResult } from "./test-scan.ts";
import { loadContent } from "./utils.ts";

// ─── Deterministic contract scan (T3) ───────────────────────────────────

/** Fixed find excludes for the contract scan. */
const SCAN_EXCLUDES = ["node_modules", ".git", "dist", "build", "coverage", ".venv", "vendor"];
/** Scan exec budget: enumerate + read is local I/O, 5s covers cold caches. */
const SCAN_BUDGET_MS = 5000;
/** Per-file size cap for JS-side reads; larger files are skipped, not fatal. */
const MAX_SCAN_FILE_BYTES = 256 * 1024;

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
 * Run the deterministic contract scan for a drafted contract.
 *
 * Enumerates files via `find` (fixed excludes), reads matched test files and
 * contract entries JS-side (size caps, binary sniff), derives per-entry
 * findings with the matched language profile, and cross-checks them against
 * the declared files. Pure decision logic lives in test-scan.ts.
 *
 * @param pi    - ExtensionAPI reference (for exec access).
 * @param cwd   - Working directory to scan.
 * @param files - The contract's declared files entries.
 * @returns Evidence + advisory warnings, or null when the scan is unavailable
 *          (exec failure, non-zero exit, empty listing) — callers degrade to
 *          "scan unavailable" without blocking the save.
 */
export async function runContractScan(
  pi: ExtensionAPI,
  cwd: string,
  files: string[],
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
    const contents = new Map<string, string>();
    for (const p of listing) {
      if (!isTestPath(p) && !files.includes(p)) continue;
      const text = readCapped(join(cwd, p));
      if (text !== null) contents.set(p, text);
    }
    const findings = new Map<string, DeriveResult>();
    for (const f of files) findings.set(f, deriveMatches(f, contents));
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
 * The agent calls save_task to persist a drafted or revised task contract.
 * The extension validates the payload deterministically, stores the task,
 * and transitions the workflow to the finalizing phase. Idempotent: safe
 * to call again while already finalizing to update the contract.
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

    parameters: Type.Object({
      title: Type.String({ description: "Short task title" }),
      instruction: Type.String({ description: "What to implement" }),
      files: Type.Array(Type.String(), { description: "Files affected" }),
      done: Type.String({ description: "Definition of done" }),
      behaviors: Type.Array(
        Type.Object({
          id: Type.String({ description: "Stable behavior id, e.g. T1" }),
          description: Type.String({ description: "Behavior under test" }),
          expectedOutput: Type.String({ description: "Expected output" }),
          kind: Type.String({ description: "test | manual" }),
          status: Type.String({ description: "active | removed | done" }),
          sourceFile: Type.Optional(
            Type.String({ description: "File that surfaces this behavior" }),
          ),
        }),
        { description: "Behaviors covered by the task contract" },
      ),
    }),

    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const state = loadState(ctx);
      if (!state || (state.phase !== "discussing" && state.phase !== "finalizing")) {
        return {
          content: [
            {
              type: "text",
              text: "save_task requires the discussing or finalizing phase.",
            },
          ],
          isError: true,
        };
      }
      const result = validateTask(params);
      if (!result.ok) {
        return {
          content: [{ type: "text", text: `save_task rejected: ${result.reason}` }],
          isError: true,
        };
      }
      const warnings = result.warnings;
      const scan = await runContractScan(pi, ctx.cwd, result.task.files);
      const allWarnings = [...warnings, ...(scan?.warnings ?? [])];
      const entering = state.phase === "discussing";
      state.task = result.task;
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
          scan.evidence.map((e) => `- ${e}`).join("\n");
      }
      if (allWarnings.length > 0) {
        text +=
          "\n\nWarnings (advisory — the contract was saved):\n" +
          allWarnings.map((w) => `warning: ${w}`).join("\n");
      }
      return {
        content: [{ type: "text", text }],
      };
    },
  });
}
