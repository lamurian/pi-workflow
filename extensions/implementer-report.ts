// The argv builder cluster (buildImplementerArgs, getImplementerTools,
// contractGuardExtensionPath) lives in implementer-args.ts; re-exported
// here so existing imports keep working unchanged.
export {
  buildImplementerArgs,
  contractGuardExtensionPath,
  getImplementerTools,
} from "./implementer-args.ts";

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

/** Provider-error markers: the provider rejected the requested model (B2/B3). */
export const PROVIDER_ERROR_RE = /deprecated|ModelDeprecated|HTTP\s*410/i;

/**
 * Provider-failure evidence (B4): the child's model call failed at the
 * provider — a 400/5xx colon form, an upstream error, or a server_error
 * payload — without the rejection markers above.
 */
export const PROVIDER_FAILURE_RE = /\b[45]\d{2}\s*:|upstream|server_error/i;

/**
 * Decide whether a settled `agent_end` event must abort the attempt (B2): a
 * run that ends with `willRetry: false` having produced no report, no tool
 * activity and no usable assistant text is a dead run — the provider
 * rejected the model, so waiting out the wall clock only burns the budget.
 * Runs with tool activity, a report, or plain non-marker prose never abort —
 * the wrap-up steer keeps recovering those.
 *
 * @param event    - The stdout event; only `agent_end` with `willRetry: false` decides.
 * @param activity - Per-attempt flags: report seen, tool activity seen, assistant text.
 * @returns `abort` plus the provider message extracted from the event messages.
 */
export function shouldAbortDeadRun(
  event: Record<string, unknown>,
  activity: { reportSeen: boolean; toolActivitySeen: boolean; assistantText: string },
): { abort: boolean; providerMessage?: string } {
  if (event.type !== "agent_end" || event.willRetry !== false) return { abort: false };
  if (activity.reportSeen || activity.toolActivitySeen) return { abort: false };
  const text = agentEndText(event) || activity.assistantText.trim();
  // The decision stays content-only (B3): plain prose never aborts, empty content does.
  if (text && !PROVIDER_ERROR_RE.test(text)) return { abort: false };
  // Evidence rides the error, not the decision: pi's failure shape puts the
  // provider error in errorMessage with content: [], which the scan above never sees.
  return { abort: true, providerMessage: agentEndErrorMessage(event) || text || undefined };
}

/** The last `errorMessage` carried by an `agent_end` message (pi's failure shape). */
function agentEndErrorMessage(event: Record<string, unknown>): string | undefined {
  const messages = Array.isArray(event.messages) ? event.messages : [];
  for (let i = messages.length - 1; i >= 0; i--) {
    const error = (messages[i] as { errorMessage?: unknown } | null)?.errorMessage;
    if (typeof error === "string" && error.trim()) return error.trim();
  }
  return undefined;
}

/**
 * Assemble the dead-run error payload: the provider message first (the
 * errorMessage when present, else the content text), then child stderr when
 * non-empty, then a raw stdout tail capped at the same 400-character budget
 * as the timeout path.
 *
 * @param providerMessage - errorMessage or content text from the settled run, if any.
 * @param stderr          - Captured child stderr.
 * @param stdout          - Raw JSONL stdout captured from the child.
 * @returns The joined error detail for the attempt.
 */
export function buildDeadRunError(
  providerMessage: string | undefined,
  stderr: string,
  stdout: string,
): string {
  const head = providerMessage
    ? `unit produced no report and no tool activity — the provider rejected the model:\n${providerMessage}`
    : "unit ended at agent_end (willRetry=false) having produced no report, no tool activity and no assistant output";
  return [
    head,
    stderr.trim() ? `--- child stderr ---\n${stderr.trim()}` : "",
    stdout.trim() ? `--- raw stdout tail ---\n${stdout.trim().slice(-400)}` : "",
  ]
    .filter(Boolean)
    .join("\n\n");
}

/** Text blocks of the last message carrying text in an `agent_end` event. */
function agentEndText(event: Record<string, unknown>): string {
  const messages = Array.isArray(event.messages) ? event.messages : [];
  for (let i = messages.length - 1; i >= 0; i--) {
    const content = (messages[i] as { content?: unknown } | null)?.content;
    if (!Array.isArray(content)) continue;
    const parts = content
      .map((block) => (block as { text?: unknown }).text)
      .filter((text): text is string => typeof text === "string" && text.trim() !== "");
    if (parts.length > 0) return parts.join("\n").trim();
  }
  return "";
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

