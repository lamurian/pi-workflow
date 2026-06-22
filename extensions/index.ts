import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { isToolCallEventType } from "@earendil-works/pi-coding-agent";
import { loadState, updateUi, type WorkflowState } from "./state.ts";
import { runBrainstorming, buildPhasePrompt, isDocumentDir, checkLineLimit } from "./brainstorm.ts";
import { runDiscussion } from "./discuss.ts";
import { startTdd, NO_INPUT_WARNING, registerCompleteImplementationTool, resolveImplementSpec } from "./implement.ts";
import { getAdrContext } from "./adr-detect.ts";
import { readArchitecture } from "./architecture.ts";
import { registerAdrCommand, registerSpecCommand, registerPlanCommand } from "./commands.ts";
import { registerExploreCommand, registerExploreTool } from "./explore.ts";
import { registerAdrTool } from "./adr-tool.ts";
import { registerSpecTool } from "./spec-tool.ts";
import { registerPlanTool } from "./plan-tool.ts";
import { registerWorkflowTransitionTool } from "./workflow-transition.ts";
import { registerValidateTool } from "./validate-tool.ts";
import { registerBatchTools } from "./batch-tools.ts";
import { checkToolPhaseGate } from "./phase-gates.ts";
import { parseArgs, getSkillsDir, detectDocType, stripFileRefs } from "./utils.ts";
import { setupAutocomplete } from "./autocomplete.ts";
import { handlePreCompact, handlePostCompact } from "./compaction.ts";
import { loadWorkflowConfig } from "./paths.ts";
import { resolveCrossReferences } from "./cross-ref.ts";
import { readFile } from "node:fs/promises";
import { statSync, existsSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";

export default function (pi: ExtensionAPI): void {
  let state: WorkflowState | null = null;

  // ─── Resources Discovery ────────────────────────────────────
  pi.on("resources_discover", async () => {
    return { skillPaths: [getSkillsDir()] };
  });

  // ─── Session Lifecycle ──────────────────────────────────────
  pi.on("session_start", async (_event, ctx) => {
    state = loadState(ctx);
    updateUi(state, ctx);
    setupAutocomplete(ctx, ctx.cwd);
  });

  // ─── Compaction Preservation ─────────────────────────────────
  pi.on("session_before_compact", async (event, ctx) => {
    const result = await handlePreCompact(event, ctx);
    if (result) return result;
  });

  pi.on("session_compact", async (event, ctx) => {
    await handlePostCompact(event, ctx);
    state = loadState(ctx);
  });

  // ─── Context Injection ──────────────────────────────────────
  pi.on("before_agent_start", async (event, ctx) => {
    const adrContext = await getAdrContext(ctx.cwd);
    let systemExtra = "";
    if (adrContext) {
      systemExtra += `\n\n### Project Documents\n${adrContext}`;
    }

    // Always read fresh state from session to avoid stale module-level cache
    // after transitionTo() calls from brainstorm/discuss command handlers.
    const currentState = loadState(ctx);

    if (!currentState || currentState.phase === "idle") {
      if (systemExtra) return { systemPrompt: `${event.systemPrompt}${systemExtra}` };
      return;
    }

    // Phase-specific protocol prompt
    const phase = currentState.phase;
    const phasePrompt = await buildPhasePrompt(
      phase,
      phase === "requirements"
        ? (await loadWorkflowConfig(ctx.cwd)).brainstorm?.skipQuestionnaire ?? false
        : true, // only requirements phase has questionnaire
    );

    const topic = currentState.specText ? `\n\nTopic: ${currentState.specText}` : "";

    return {
      systemPrompt: `${event.systemPrompt}\n\n${phasePrompt}${topic}${systemExtra}`,
    };
  });

  // ─── Register Commands ──────────────────────────────────────
  registerAdrCommand(pi);
  registerSpecCommand(pi);
  registerPlanCommand(pi);
  registerExploreCommand(pi);
  registerExploreTool(pi);

  // ─── Register AI Tools ────────────────────────────────────────
  registerAdrTool(pi);
  registerSpecTool(pi);
  registerPlanTool(pi);
  registerWorkflowTransitionTool(pi);
  registerValidateTool(pi);
  registerBatchTools(pi);
  registerCompleteImplementationTool(pi);

  // ── Phase-based edit restrictions ───────────────────────────
  pi.on("tool_call", async (event, ctx) => {
    const currentState = loadState(ctx);
    if (!currentState || currentState.phase === "idle") return;

    if (currentState.phase === "discussing") {
      // /discuss: no file edits allowed
      if (isToolCallEventType("write", event) || isToolCallEventType("edit", event)) {
        return {
          block: true,
          reason: "The /discuss command does not allow file editing. " +
            "Discuss the approach first, then use /implement to execute the agreed plan."
        };
      }
      return;
    }

    // /brainstorm phases (requirements, specifying, planning): only .md files
    const isBrainstormPhase = currentState.phase === "requirements" ||
      currentState.phase === "specifying" ||
      currentState.phase === "planning";

    if (!isBrainstormPhase) return;

    // Skip all gating when skipCeremony is enabled (lightweight change mode)
    try {
      const wfConfig = await loadWorkflowConfig(ctx.cwd);
      if (wfConfig.brainstorm?.skipCeremony) return;
    } catch {
      // Ignore config errors — fall through to normal gating
    }

    // ── Phase-based gating for document creation tools ──────
    const gateResult = checkToolPhaseGate(
      event.toolName,
      currentState.phase,
    );
    if (gateResult) {
      return {
        block: true,
        reason: gateResult.reason,
      };
    }

    if (isToolCallEventType("write", event)) {
      const path: string = event.input.path ?? "";
      if (!path.endsWith(".md")) {
        return {
          block: true,
          reason: `During /brainstorm you can only write .md files (ADRs, specs, plans). ` +
            `Blocked write to "${path}". Use /implement for code changes.`
        };
      }

      // Block direct writes to ADR/spec/plan directories — use commands instead
      const docType = isDocumentDir(path);
      if (docType === "adr") {
        return {
          block: true,
          reason: `During /brainstorm, do NOT write ADR files directly. ` +
            `Use /adr new <title> instead to create "${path}". ` +
            `This ensures proper sequential numbering (001-slug.md) and cross-referencing.`
        };
      }
      if (docType === "spec") {
        return {
          block: true,
          reason: `During /brainstorm, do NOT write spec files directly. ` +
            `Use /spec <adrNumber> <title> instead to create "${path}".`
        };
      }
      if (docType === "plan") {
        return {
          block: true,
          reason: `During /brainstorm, do NOT write plan files directly. ` +
            `Use /plan <specNumber> <title> instead to create "${path}".`
        };
      }

      // Enforce line count limit for .md files
      const content: string = event.input.content ?? "";
      const lineLimitReason = checkLineLimit(content, path);
      if (lineLimitReason) {
        return { block: true, reason: lineLimitReason };
      }
    }

    if (isToolCallEventType("edit", event)) {
      const path: string = event.input.path ?? "";
      if (!path.endsWith(".md")) {
        return {
          block: true,
          reason: `During /brainstorm you can only edit .md files (ADRs, specs, plans). ` +
            `Blocked edit to "${path}". Use /implement for code changes.`
        };
      }

      // Block editing documents in ADR/spec/plan directories
      const docType = isDocumentDir(path);
      if (docType) {
        return {
          block: true,
          reason: `During /brainstorm, do NOT edit document files directly. ` +
            `Use the appropriate command (/adr, /spec, /plan) or wait until the implementing phase.`
        };
      }

      // Enforce line count limit for .md edits
      // For edits, we check the new text — the combined old/new isn't directly available,
      // so we check each edit's newText
      const edits: Array<{ newText: string }> = event.input.edits ?? [];
      for (const edit of edits) {
        const lineLimitReason = checkLineLimit(edit.newText, path);
        if (lineLimitReason) {
          return { block: true, reason: lineLimitReason };
        }
      }
    }

    return;
  });

  // ── /discuss ───────────────────────────────────────────────
  pi.registerCommand("discuss", {
    description:
      "Discuss an issue, bug, chore, or small fix with the engineer. " +
      "Usage: /discuss <topic>",
    handler: async (args, ctx) => {
      await runDiscussion(args, pi, ctx);
    },
  });

  // ── /brainstorm ─────────────────────────────────────────────
  pi.registerCommand("brainstorm", {
    description:
      "Start or continue a brainstorming session. " +
      "Usage: /brainstorm <topic> | /brainstorm @docs/ADR/<file> | /brainstorm @docs/specs/<file>",
    handler: async (args, ctx) => {
      await runBrainstorming(args, pi, ctx);
    },
  });

  // ── /implement ──────────────────────────────────────────────
  pi.registerCommand("implement", {
    description:
      "TDD implementation. Usage: /implement @docs/plans/<file> | /implement <path-to-plan>",
    handler: async (args, ctx) => {
      const trimmed = args.trim();

      // ── Phase 1: Extract @file references ──────────────────
      const refRegex = /@(\S+)/g;
      const refs: string[] = [];
      let match: RegExpExecArray | null;
      while ((match = refRegex.exec(trimmed)) !== null) {
        refs.push(match[1]);
      }

      // ── Phase 2: Determine plan path and spec text ──────────
      // Priority: @docs/plans/X ref > plain path > discussion > ADR
      let planAbs: string | undefined;
      let spec: string | undefined;

      // Strategy A: @-prefixed plan reference
      if (refs.length > 0) {
        const planRef = refs.find((r) => {
          const abs = isAbsolute(r) ? r : resolve(ctx.cwd, r);
          return detectDocType(abs) === "plan";
        });

        if (planRef) {
          planAbs = isAbsolute(planRef) ? planRef : resolve(ctx.cwd, planRef);
          const resolved = await resolveCrossReferences(planRef, ctx.cwd);
          if (resolved.errors.length > 0) {
            ctx.ui.notify(
              `Warning resolving references: ${resolved.errors.join(", ")}`,
              "warning",
            );
          }
          // Read plan content for the spec if resolve didn't produce it
          if (resolved.content) {
            spec = resolved.content;
          } else {
            const planContent = await readFile(planAbs, "utf-8");
            spec = planContent;
          }
        } else {
          // Non-plan @-refs: read file contents as spec
          const { fileContents } = await parseArgs(args, ctx.cwd);
          if (fileContents.length > 0) {
            spec = fileContents.join("\n\n---\n\n");
          }
        }
      }

      // Strategy B: plain path (no @ prefix) — check if it's a file
      if (!planAbs && !spec && trimmed) {
        const maybePath = isAbsolute(trimmed) ? trimmed : resolve(ctx.cwd, trimmed);
        try {
          if (existsSync(maybePath) && statSync(maybePath).isFile()) {
            planAbs = maybePath;
            const planContent = await readFile(planAbs, "utf-8");

            // Resolve cross-references if it's a plan
            if (detectDocType(planAbs) === "plan") {
              const resolved = await resolveCrossReferences(planAbs, ctx.cwd);
              spec = resolved.content || planContent;
            } else {
              spec = planContent;
            }
          }
        } catch {
          // Not a valid file — fall through to free-form topic
        }
      }

      // Strategy C: bare /implement — resolve spec from session
      if (!planAbs && !spec) {
        const topic = stripFileRefs(trimmed);

        if (!topic) {
          // Use the new priority chain: assistant msg > discussion > ADR
          const resolvedSpec = await resolveImplementSpec(ctx);
          if (resolvedSpec) {
            spec = resolvedSpec;
          } else {
            ctx.ui.notify(NO_INPUT_WARNING, "warning");
            return;
          }
        } else {
          // Free-form topic text
          spec = topic;
        }
      }

      // ── Phase 3: Start TDD — plan stays in place until finalized ──
      if (!spec) {
        ctx.ui.notify("No specification resolved. Nothing to implement.", "warning");
        return;
      }

      // Pass planAbs so complete_implementation can find it later
      await startTdd(spec, pi, ctx, planAbs);
    },
  });

  // ── /status ─────────────────────────────────────────────────
  pi.registerCommand("status", {
    description: "Show current workflow phase and document status",
    handler: async (_args, ctx) => {
      const current = loadState(ctx) ?? state;
      if (!current || current.phase === "idle") {
        const entries = await readArchitecture(ctx.cwd);
        if (entries.length > 0) {
          const lines = entries.map((e) => `${e.filePath}: ${e.status} — ${e.summary}`);
          ctx.ui.notify(`ADR Status:\n${lines.join("\n")}`, "info");
        } else {
          ctx.ui.notify("No active workflow. Start with /brainstorm.", "info");
        }
        return;
      }

      const lines: string[] = [`Phase: ${current.phase.replace(/_/g, " ")}`];
      if (current.adrFiles.length > 0) lines.push(`ADRs: ${current.adrFiles.join(", ")}`);
      if (current.specFiles.length > 0) lines.push(`Specs: ${current.specFiles.join(", ")}`);
      if (current.planFiles.length > 0) lines.push(`Plans: ${current.planFiles.join(", ")}`);
      if (current.lastTestResults) {
        const r = current.lastTestResults;
        lines.push(
          `Tests: ${r.passed} passed, ${r.failed} failed` +
            (r.coveragePercent != null ? `, ${r.coveragePercent}% coverage` : ""),
        );
      }

      const entries = await readArchitecture(ctx.cwd);
      if (entries.length > 0) {
        lines.push("", "ARCHITECTURE.md:");
        for (const e of entries) lines.push(`  ${e.filePath}: ${e.status} — ${e.summary}`);
      }

      ctx.ui.notify(lines.join("\n"), "info");
    },
  });
}
