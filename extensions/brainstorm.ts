import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { loadContent, renderTemplate, detectDocType } from "./utils.ts";
import { createAdr, type Adr } from "./adr.ts";
import { ensureArchitectureMd, addAdrToArchitecture } from "./architecture.ts";
import { type WorkflowState, transitionTo, updateUi } from "./state.ts";
import { detectExistingHooks } from "./detect-hooks.ts";
import { loadWorkflowConfig } from "./paths.ts";
import { resolveCrossReferences } from "./cross-ref.ts";
import { relative } from "node:path";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";

/** Default brainstorming topic when none is provided. */
const DEFAULT_TOPIC = "Let's discuss the implementation requirements for this project.";

/** Maximum allowed lines for generated .md files. */
const MAX_DOC_LINES = 100;

/**
 * Maximum number of lines for generated markdown files.
 */
export const MAX_DOCUMENT_LINES = MAX_DOC_LINES;

/**
 * Check if a file path is within a protected document directory (ADR, spec, or plan).
 *
 * During brainstorming, the LLM should use commands (/adr new, /spec, /plan)
 * instead of writing directly to these directories. This ensures proper
 * sequential numbering and cross-referencing.
 *
 * Recognized directories:
 *   - docs/ADR/, docs/adr/ (any case)
 *   - ADR/ at project root
 *   - docs/specs/
 *   - docs/plans/
 *
 * @param filePath - Absolute or relative file path.
 * @returns "adr" | "spec" | "plan" if the path is in a document directory, or null.
 */
export function isDocumentDir(filePath: string): "adr" | "spec" | "plan" | null {
  const normal = filePath.replace(/\\/g, "/").toLowerCase();

  // Standard paths
  if (/\/docs\/specs\//.test(normal)) return "spec";
  if (/\/docs\/plans\//.test(normal)) return "plan";

  // ADR: match docs/adr/ or root-level adr/ as a path segment
  if (/\/docs\/adr\//.test(normal)) return "adr";
  const parts = normal.split("/");
  const adrIdx = parts.indexOf("adr");
  if (adrIdx !== -1 && adrIdx < parts.length - 1) {
    return "adr";
  }

  return null;
}

/**
 * Count the number of lines in a string.
 *
 * @param content - String content to count lines in.
 * @returns The number of lines.
 */
export function countLines(content: string): number {
  if (content.length === 0) return 0;
  return content.split("\n").length;
}

/**
 * Check if content exceeds the maximum allowed line count.
 *
 * @param content  - File content to check.
 * @param filePath - File path for error message context.
 * @returns A block reason string if over limit, or null if within limits.
 */
export function checkLineLimit(content: string, filePath: string): string | null {
  const lines = countLines(content);
  if (lines > MAX_DOC_LINES) {
    return `File "${filePath}" has ${lines} lines, exceeding the ${MAX_DOC_LINES}-line limit. ` +
      `Please split the content into multiple files or trim it down.`;
  }
  return null;
}

/**
 * Phase determined by the type of @file the user passes.
 *
 * - No recognized file ref → requirements phase (elicit → ADR)
 * - @docs/ADR/*.md       → specifying phase (ADR → spec)
 * - @docs/specs/*.md     → planning phase (spec → plan)
 */
type DetectedPhase = "requirements" | "specifying" | "planning";

/**
 * Detect the phase from command arguments by checking @file references.
 *
 * @param args - Raw command argument string.
 * @param cwd  - Project working directory.
 * @returns The detected phase and the resolved file path (if any).
 */
async function detectPhaseFromArgs(
  args: string,
  cwd: string,
): Promise<{ phase: DetectedPhase; filePath: string | null }> {
  const refRegex = /@(\S+)/g;
  let match: RegExpExecArray | null;
  let specPath: string | null = null;

  while ((match = refRegex.exec(args)) !== null) {
    const ref = match[1];
    // Resolve relative to cwd for type detection
    const resolved = ref.startsWith("/") ? ref : `${cwd}/${ref}`;
    const docType = detectDocType(resolved);
    if (docType === "adr") {
      return { phase: "specifying", filePath: ref };
    }
    if (docType === "spec") {
      return { phase: "planning", filePath: ref };
    }
    if (docType === "plan") {
      specPath = ref;
    }
  }

  // If a plan was referenced, treat it as planning (user wants to review before /implement)
  if (specPath) {
    return { phase: "planning", filePath: specPath };
  }

  return { phase: "requirements", filePath: null };
}

/**
 * Check whether the project needs initiation (AGENTS.md and directory structure).
 *
 * Returns a context string describing what's missing, or null if everything is in place.
 *
 * @param cwd - Project working directory.
 * @returns Initiation context string, or null if none needed.
 */
export async function checkProjectInitiation(cwd: string): Promise<string | null> {
  const parts: string[] = [];

  // Check for root AGENTS.md
  if (!existsSync(`${cwd}/AGENTS.md`)) {
    parts.push(
      "- **AGENTS.md** is missing. Create a root AGENTS.md (≤100 lines) describing the " +
        "project purpose, language conventions (casual business English), and agent instructions. " +
        "Then add per-directory AGENTS.md files (e.g., tests/AGENTS.md, docs/AGENTS.md) to explain " +
        "what each directory contains for agent navigation. The root AGENTS.md should " +
        "cross-reference these subdirectory AGENTS.md files.",
    );
  }

  // Check key project directories
  // pi packages (those with a "pi" field in package.json) use extensions/ as source — skip src/.
  const isPiPackage =
    existsSync(`${cwd}/package.json`);
  let hasPiField = false;
  if (isPiPackage) {
    try {
      const pkg = JSON.parse(await readFile(`${cwd}/package.json`, "utf-8"));
      hasPiField = !!pkg.pi;
    } catch {
      // Ignore parse errors — treat as non-pi package
    }
  }
  const keyDirs = [
    ...(hasPiField ? [] : ["src"] as const),
    "tests", "docs/ADR", "docs/specs", "docs/plans",
  ];
  const missingDirs: string[] = [];
  for (const dir of keyDirs) {
    const absDir = `${cwd}/${dir}`;
    if (!existsSync(absDir)) {
      missingDirs.push(dir);
    }
  }

  if (missingDirs.length > 0) {
    parts.push(
      `- The following project directories are missing: ${missingDirs.join(", ")}. ` +
        "Discuss the directory layout with the user, agree on structure, then scaffold them.",
    );
  }

  if (parts.length === 0) return null;

  return [
    "## Project Initiation Needed",
    "",
    "Before we dive into requirements, we need to set up the project foundation:",
    "",
    ...parts,
    "",
    "Walk through this with the user before proceeding to the ADR.",
  ].join("\n");
}

/**
 * Run a brainstorming session.
 *
 * Phase is determined by what the user references:
 * - No @file or topic string → requirements phase (with optional project initiation)
 * - @docs/ADR/xxx.md        → specifying phase
 * - @docs/specs/xxx.md      → planning phase
 *
 * @param args - Raw command arguments (topic and/or @file refs).
 * @param pi   - ExtensionAPI reference.
 * @param ctx  - Current extension context.
 */
export async function runBrainstorming(
  args: string,
  pi: ExtensionAPI,
  ctx: ExtensionContext,
): Promise<void> {
  const { phase, filePath } = await detectPhaseFromArgs(args, ctx.cwd);
  const workflowConfig = await loadWorkflowConfig(ctx.cwd);
  const skipQuestionnaire = workflowConfig.brainstorm?.skipQuestionnaire ?? false;

  // Build context from @file references
  let contextText = args.replace(/@\S+/g, "").trim() || DEFAULT_TOPIC;
  let crossRefContent = "";

  if (filePath) {
    const resolved = await resolveCrossReferences(filePath, ctx.cwd);
    if (resolved.errors.length > 0) {
      ctx.ui.notify(
        `Warning reading ${filePath}: ${resolved.errors.join(", ")}`,
        "warning",
      );
    }
    if (resolved.content) {
      crossRefContent = resolved.content;
      contextText = resolved.chain.length > 1
        ? `Referenced document: ${filePath}\n\nFull context:\n${resolved.content}`
        : `Referenced document: ${filePath}\n\n${resolved.content}`;
    }
  }

  // If skipCeremony is enabled (lightweight mode), go straight to implementing
  if (phase === "requirements" && workflowConfig.brainstorm?.skipCeremony) {
    const state: WorkflowState = {
      phase: "implementing",
      specText: contextText,
      adrFiles: [],
      specFiles: [],
      planFiles: [],
    };
    transitionTo(pi, state, "implementing");
    updateUi(state, ctx);
    ctx.ui.notify("Ceremony skipped. Entering implementation phase directly.", "info");
    pi.sendUserMessage(contextText, { deliverAs: "steer" });
    return;
  }

  // Check project initiation in requirements phase
  if (phase === "requirements") {
    const initiationContext = await checkProjectInitiation(ctx.cwd);
    if (initiationContext) {
      contextText = `${initiationContext}\n\n---\n\n${contextText}`;
    }
  }

  const state: WorkflowState = {
    phase,
    specText: contextText,
    adrFiles: filePath && phase === "specifying" ? [filePath] : [],
    specFiles: filePath && phase === "planning" ? [filePath] : [],
    planFiles: [],
  };

  transitionTo(pi, state, phase);
  updateUi(state, ctx);

  // Auto-detect existing hooks only during requirements phase
  if (phase === "requirements" && !skipQuestionnaire) {
    const existingHooks = await detectExistingHooks(ctx.cwd);
    const detectionLines: string[] = [];

    if (existingHooks.preCommit) {
      detectionLines.push(`- Pre-commit: ${existingHooks.preCommit.detail}`);
    }
    if (existingHooks.prePush) {
      detectionLines.push(`- Pre-push: ${existingHooks.prePush.detail}`);
    }
    if (detectionLines.length > 0) {
      ctx.ui.notify(
        `Detected existing hooks:\n${detectionLines.join("\n")}`,
        "info",
      );
    }
  }

  // Ensure ARCHITECTURE.md exists (requirements phase)
  if (phase === "requirements") {
    await ensureArchitectureMd(ctx.cwd);
  }

  ctx.ui.notify(
    `Starting ${phase} phase. I'll guide you through the process.`,
    "info",
  );

  // Kick off the LLM conversation
  pi.sendUserMessage(contextText, { deliverAs: "steer" });
}

/**
 * Build the phase-specific system prompt.
 *
 * @param phase - Current workflow phase.
 * @param skipQuestionnaire - Whether to omit env/hook questions (requirements only).
 * @returns The rendered system prompt string.
 */
export async function buildPhasePrompt(
  phase: string,
  skipQuestionnaire = false,
): Promise<string> {
  const promptFile = `phase-${phase}.md`;

  let template: string;
  try {
    template = await loadContent(promptFile);
  } catch {
    // Fallback to requirements prompt if phase file not found
    template = await loadContent("phase-requirements.md");
  }

  // Only requirements phase has the questionnaire section
  if (phase === "requirements") {
    const questionnaireSection = skipQuestionnaire
      ? ""
      : [
        "## Questionnaire",
        "",
        "Guide the user toward best practices for:",
        "- Pre-commit hooks (code quality gates, linting, formatting)",
        "- Pre-push hooks (CI validation, build, integration tests)",
        "- Environment management (secrets, dotenv, validation)",
        "",
        "Ask about their preferences but don't force things they don't need.",
      ].join("\n");
    return renderTemplate(template, { questionnaire_section: questionnaireSection });
  }

  return template;
}

/**
 * Create an ADR from brainstorming decisions and track it in ARCHITECTURE.md.
 *
 * @param adr     - The ADR data (status is set to "proposed" automatically).
 * @param cwd     - Project working directory.
 * @returns Absolute path to the created ADR file.
 */
export async function createAdrFromBrainstorm(
  adr: Omit<Adr, "status"> & { summary: string },
  cwd: string,
): Promise<string> {
  const fullAdr: Adr = {
    title: adr.title,
    description: adr.description,
    status: "proposed",
    remaining: adr.remaining ?? 0,
    date: adr.date,
    context: adr.context,
    decision: adr.decision,
    impact: adr.impact,
  };

  const adrPath = await createAdr(fullAdr, cwd);

  // Store the relative path for architecture tracking
  const relPath = relative(cwd, adrPath);
  await addAdrToArchitecture(cwd, relPath, adr.summary, "drafted");

  return adrPath;
}
