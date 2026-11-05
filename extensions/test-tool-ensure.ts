// Registry-aware generation of the local test extension. Decision rule:
// a `test` tool from ANOTHER path owns the name -> stop (existing); the file
// carries the GENERATED marker -> regenerate in place; the file exists without
// the marker -> hand-written, never overwritten, reported; else generate.
// The generated extension is ORCHESTRATOR-OWNED (T7): it is never declared in
// the contract, never auto-injected into any allowlist, and units may not
// write it — the orchestrator regenerates and commits it itself.
//
// Related modules: test-extension-constants.ts (marker, path, budgets),
// test-extension-template*.ts (generated source), test-gate-run.ts /
// test-gate-report.ts (orchestrator gates), test-extension-chore.ts (commit).

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type {
  TestSuite,
  TestSuiteDetection,
  TestSuiteSource,
} from "./test-tool-detect.ts";
import type { WorkflowState } from "./state.ts";
import { GENERATED_MARKER, TEST_EXTENSION_RELATIVE } from "./test-extension-constants.ts";
import { generateTestExtension } from "./test-extension-template.ts";
import { commitTestExtensionChore, type ChoreCommitResult } from "./test-extension-chore.ts";

/** Result of the ensure step for one save_task run (T7: no files entry). */
export interface EnsureTestToolResult {
  /** Where the effective test tool came from (persisted as state.testTool.source). */
  source: TestSuiteSource;
  /** Suites the generated tool runs (empty when none or an external tool owns the name). */
  suites: TestSuite[];
  /** Full-gate suites (empty when none or an external tool owns the name). */
  fullSuites: TestSuite[];
  /** Absolute path of the generated file — present only when a file was written. */
  path?: string;
  /** One-line detection evidence for the save_task output. */
  message: string;
}

/**
 * Resolve the generated test extension path for a working directory.
 *
 * @param cwd - Repository working directory.
 * @returns The absolute path of `.pi/extensions/test.ts`, or undefined when absent.
 */
export function resolveTestExtensionPath(cwd: string): string | undefined {
  const full = join(resolve(cwd), ".pi", "extensions", "test.ts");
  return existsSync(full) ? full : undefined;
}

/**
 * Registry-aware ensure step: generate or regenerate `.pi/extensions/test.ts`.
 *
 * Decision rule (precedence order):
 * 1. `pi.getAllTools()` shows a `test` tool from ANOTHER path -> stop; the
 *    external tool owns the name (source `existing`).
 * 2. No suites (source `none`) -> nothing to run, warn.
 * 3. The file exists WITHOUT the GENERATED marker -> hand-written: never
 *    overwritten, reported (source `existing`).
 * 4. The file carries the marker -> regenerate in place; else generate fresh.
 *
 * The generated extension is orchestrator-owned (T7): nothing is returned that
 * a caller could declare in a contract allowlist, and no git query runs.
 *
 * @param pi        - ExtensionAPI (tool registry).
 * @param cwd       - Repository working directory.
 * @param detection - Suite detection result (config override or manifest scan).
 * @returns The ensure outcome: effective source, suites, written path (when a
 *          file was written) and a one-line evidence message.
 */
export async function ensureTestTool(
  pi: ExtensionAPI,
  cwd: string,
  detection: TestSuiteDetection,
): Promise<EnsureTestToolResult> {
  const targetPath = join(resolve(cwd), ".pi", "extensions", "test.ts");

  // 1. Registry: an external `test` tool already owns the name.
  const tools = typeof pi.getAllTools === "function" ? pi.getAllTools() : [];
  const existing = tools.find((tool) => tool.name === "test");
  if (existing && resolve(existing.sourceInfo.path) !== targetPath) {
    return {
      source: "existing",
      suites: [],
      fullSuites: [],
      message:
        `test tool already registered from ${existing.sourceInfo.path} — ` +
        "no generation, the existing tool owns the name",
    };
  }

  // 2. Nothing to run.
  if (detection.source === "none" || detection.suites.length === 0) {
    return {
      source: "none",
      suites: [],
      fullSuites: [],
      message: "no test tool: no test suites detected (no manifest matched)",
    };
  }

  // 3. Existing file: marker decides regenerate vs hand-written refusal.
  let existingContent: string | null = null;
  if (existsSync(targetPath)) {
    try {
      existingContent = readFileSync(targetPath, "utf8");
    } catch {
      existingContent = null; // Unreadable: fall through and regenerate.
    }
  }
  if (existingContent !== null && !existingContent.includes(GENERATED_MARKER)) {
    return {
      source: "existing",
      suites: [],
      fullSuites: [],
      message:
        `test tool not generated: ${TEST_EXTENSION_RELATIVE} exists without the ` +
        "GENERATED marker (hand-written) — left untouched",
    };
  }

  // 4. Generate or regenerate.
  const content = generateTestExtension(detection.suites);
  mkdirSync(dirname(targetPath), { recursive: true });
  writeFileSync(targetPath, content);
  const verb = existingContent === null ? "generated" : "regenerated";
  const suiteList = detection.suites.map((suite) => suite.label).join(", ");
  return {
    source: detection.source,
    suites: detection.suites,
    fullSuites: detection.full ?? [],
    path: targetPath,
    message:
      `test tool ${verb}: ${TEST_EXTENSION_RELATIVE} — runs ` +
      `${detection.suites.length} suite(s): ${suiteList}`,
  };
}

// ── Implement-start ensure + chore commit (T9) ──────────────────────────────

/** Outcome of the /implement-start test-extension ensure step (T9). */
export interface StartEnsureResult {
  /**
   * "landed" = the regenerated file was committed alone; "skipped" = nothing
   * to commit (no file written, or the file is unchanged); "failed" = the
   * caller must halt before any unit spawns.
   */
  kind: ChoreCommitResult["kind"];
  /** One-line evidence message from the ensure step. */
  message: string;
  /** Halt text when the chore commit failed (empty otherwise). */
  investigation: string;
}

/**
 * Run the ensure step at /IMPLEMENT START and land the chore commit (T9).
 *
 * Regenerates `.pi/extensions/test.ts` from the session's recorded suites
 * (`state.testTool`, recorded by save_task; sessions without recorded suites
 * skip the step entirely — no re-detection) — the file is orchestrator-owned
 * and never writable by a unit. When the generated file changed it is
 * committed alone as `chore: regenerate test extension` via
 * commitTestExtensionChore: a path-limited commit that contains only the
 * generated path and leaves any other staged work staged (never swept in,
 * never a reason to halt).
 *
 * @param pi    - ExtensionAPI (tool registry + exec).
 * @param cwd   - Repository working directory.
 * @param state - Workflow state (supplies the recorded test suites).
 * @returns The ensure/chore outcome: kind, evidence message and the halt
 *          investigation when the chore commit failed.
 */
export async function ensureTestExtensionAtStart(
  pi: ExtensionAPI,
  cwd: string,
  state: Pick<WorkflowState, "testTool">,
): Promise<StartEnsureResult> {
  const recorded = state.testTool?.suites ?? [];
  if (recorded.length === 0) {
    return {
      kind: "skipped",
      message: "no test tool recorded in state.testTool — no start-time regeneration",
      investigation: "",
    };
  }
  const detection: TestSuiteDetection = {
    source: state.testTool?.source ?? "detected",
    suites: recorded,
    full: state.testTool?.fullSuites ?? recorded,
  };
  const ensured = await ensureTestTool(pi, cwd, detection);
  if (!ensured.path) {
    return { kind: "skipped", message: ensured.message, investigation: "" };
  }
  const chore = await commitTestExtensionChore(pi, cwd, TEST_EXTENSION_RELATIVE);
  return {
    kind: chore.kind,
    message: `${ensured.message} — chore commit: ${chore.kind}`,
    investigation: chore.investigation,
  };
}
