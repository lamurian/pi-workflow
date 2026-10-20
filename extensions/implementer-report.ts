// ─── Implementer subprocess (orchestrator units) ─────────────────────────────

/** Tools granted to an implementer subprocess: read + filesystem + bash only. */
const DEFAULT_IMPLEMENTER_TOOLS = "read,write,edit,bash";

/** A sandbox-blocked command reported by an implementer unit. */
export interface BlockedCommand {
  /** The exact command the sandbox refused to run. */
  command: string;
  /** Why the unit needs it (optional). */
  reason?: string;
  /** True when the unit cannot implement or verify the behavior without it. */
  mustRunNow: boolean;
}

/** Structured report extracted from an implementer subprocess output. */
export interface ImplementerReport {
  /** One or two sentences on what the unit changed and how it verified. */
  summary: string;
  /** Conventional commit subject suggested by the unit (no behavior id). */
  suggestedCommit?: string;
  /** Commands the sandbox blocked, classified by urgency by the unit. */
  blockedCommands?: BlockedCommand[];
  /** Completion state: "partial" when wrapping up unfinished work, "complete" when done. */
  status?: "complete" | "partial";
  /** Short reusable facts (file paths, signatures, verified tool behavior) for later units. */
  findings?: string[];
  /** What a follow-up unit should do next after a partial wrap-up. */
  nextSteps?: string;
  /** True when the behavior is already implemented at HEAD and needs no commit. */
  alreadySatisfied?: boolean;
}

/**
 * Resolve the tool allowlist for implementer subprocesses.
 *
 * Defaults to `read,write,edit,bash`; the `PI_IMPLEMENTER_TOOLS` env var
 * overrides the full list for environments where tool names differ (e.g.
 * a renamed shell tool) or a tighter grant is wanted.
 *
 * @param env - Environment map (defaults to `process.env`); injectable for tests.
 * @returns Comma-separated tool names for `--tools`.
 */
export function getImplementerTools(
  env: Record<string, string | undefined> = process.env,
): string {
  const raw = env.PI_IMPLEMENTER_TOOLS?.trim();
  return raw ? raw : DEFAULT_IMPLEMENTER_TOOLS;
}

/**
 * Build the argv array for an implementer subprocess.
 *
 * Spawns a long-lived `pi --mode rpc` child: the task text travels over
 * stdin as a JSONL `prompt` command (never in argv), keeping stdin open
 * for later steering. Lean flags skip extension/skill/session loading for
 * fast startup and determinism. Tools are restricted to the implementer
 * allowlist (default `read,write,edit,bash`) — the unit cannot commit or
 * touch workflow state; the orchestrator owns both. Does NOT pass --model
 * so the subprocess uses the user's default model.
 *
 * @param systemPrompt - Literal unit prompt text (from content/unit-prompt.md).
 * @returns Array of CLI arguments for the implementer subprocess.
 */
export function buildImplementerArgs(systemPrompt: string): string[] {
  const args: string[] = [
    "--mode", "rpc",
    "--no-session",
    "--no-extensions",
    "--no-skills",
    "--offline",
    "--thinking", "minimal",
    "--tools", getImplementerTools(),
  ];
  if (systemPrompt.trim()) {
    args.push("--append-system-prompt", systemPrompt);
  }
  return args;
}

/**
 * Extract the last assistant text from JSON-mode event output.
 *
 * Malformed JSON lines (e.g. from a killed process) are skipped.
 * Exported so unit diagnostics can use it as retry context instead of
 * raw JSONL.
 *
 * @param stdout - Raw JSONL output from the subprocess.
 * @returns The last assistant message text, or "" when none parsed.
 */
export function lastAssistantText(stdout: string): string {
  let last = "";
  for (const line of stdout.split("\n")) {
    if (!line.trim()) continue;
    try {
      const event = JSON.parse(line) as {
        type?: string;
        message?: { role?: string; content?: Array<{ type?: string; text?: string }> };
      };
      if (
        (event.type === "message_end" || event.type === "tool_result_end") &&
        event.message?.role === "assistant"
      ) {
        const parts = event.message.content
          ?.filter((c) => c.type === "text" && c.text)
          .map((c) => c.text as string);
        if (parts && parts.length > 0) last = parts.join("\n").trim();
      }
    } catch {
      // Skip malformed JSON lines (truncated writes from killed processes).
    }
  }
  return last;
}

/**
 * Validate a raw `blockedCommands` value into BlockedCommand entries.
 *
 * Defensive by contract: non-array values yield undefined; non-object
 * entries, missing/non-string `command`, and non-boolean `mustRunNow`
 * drop the offending entry. Never throws.
 *
 * @param raw - The unparsed `blockedCommands` value from the JSON block.
 * @returns Validated entries, or undefined when none survive.
 */
function parseBlockedCommands(raw: unknown): BlockedCommand[] | undefined {
  if (!Array.isArray(raw)) return undefined;
  const entries: BlockedCommand[] = [];
  for (const item of raw) {
    if (typeof item !== "object" || item === null) continue;
    const candidate = item as Record<string, unknown>;
    if (typeof candidate.command !== "string" || !candidate.command) continue;
    if (typeof candidate.mustRunNow !== "boolean") continue;
    entries.push({
      command: candidate.command,
      ...(typeof candidate.reason === "string" ? { reason: candidate.reason } : {}),
      mustRunNow: candidate.mustRunNow,
    });
  }
  return entries.length > 0 ? entries : undefined;
}

/**
 * Parse the optional `status` field: only "complete" | "partial" survive;
 * anything else is omitted.
 *
 * @param raw - The unparsed `status` value from the JSON block.
 * @returns The validated status, or undefined when absent or invalid.
 */
function parseReportStatus(raw: unknown): "complete" | "partial" | undefined {
  return raw === "complete" || raw === "partial" ? raw : undefined;
}

/**
 * Parse the optional `findings` field: string entries only; non-string
 * entries are dropped; an empty (or non-array) value is omitted.
 *
 * @param raw - The unparsed `findings` value from the JSON block.
 * @returns The surviving string findings, or undefined when none survive.
 */
function parseReportFindings(raw: unknown): string[] | undefined {
  if (!Array.isArray(raw)) return undefined;
  const findings = raw.filter((item): item is string => typeof item === "string");
  return findings.length > 0 ? findings : undefined;
}

/**
 * Parse implementer JSON-mode output into a structured report.
 *
 * Reads the final fenced ```json block from the last assistant message.
 * Tolerates malformed JSON lines and killed processes: when no block or
 * only a broken block is found, falls back to the whole message text (or
 * an empty summary). `blockedCommands` is validated entry-by-entry and
 * dropped when malformed. Never throws.
 *
 * @param stdout - Raw JSONL output from the implementer subprocess.
 * @returns The parsed report; optional fields absent when unavailable or invalid.
 */
export function parseImplementerReport(stdout: string): ImplementerReport {
  const text = lastAssistantText(stdout);
  if (!text) return { summary: "" };
  const jsonMatch = text.match(/```json\s*([\s\S]*?)```/);
  if (jsonMatch) {
    try {
      const parsed = JSON.parse(jsonMatch[1]!) as Record<string, unknown>;
      if (typeof parsed.summary === "string") {
        const blockedCommands = parseBlockedCommands(parsed.blockedCommands);
        const status = parseReportStatus(parsed.status);
        const findings = parseReportFindings(parsed.findings);
        return {
          summary: parsed.summary,
          ...(typeof parsed.suggestedCommit === "string"
            ? { suggestedCommit: parsed.suggestedCommit }
            : {}),
          ...(blockedCommands ? { blockedCommands } : {}),
          ...(status ? { status } : {}),
          ...(findings ? { findings } : {}),
          ...(typeof parsed.nextSteps === "string" ? { nextSteps: parsed.nextSteps } : {}),
          ...(typeof parsed.alreadySatisfied === "boolean"
            ? { alreadySatisfied: parsed.alreadySatisfied }
            : {}),
        };
      }
    } catch {
      // Broken JSON block — fall through to whole-message summary.
    }
  }
  return { summary: text.trim() };
}

