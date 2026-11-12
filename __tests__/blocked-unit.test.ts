import { describe, expect, it } from "vitest";
import { parseImplementerReport } from "../extensions/implementer-report.ts";
import { blockedHaltText } from "../extensions/blocked-unit.ts";

function jsonl(report: Record<string, unknown>): string {
  const text = "done\n```json\n" + JSON.stringify(report) + "\n```";
  return JSON.stringify({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text }] } });
}

describe("blocked status", () => {
  it("parseReport keeps blocked with a valid blockedReason", () => {
    for (const reason of ["capability", "too-large", "missing-context"]) {
      const r = parseImplementerReport(jsonl({ summary: "s", status: "blocked", blockedReason: reason }));
      expect(r.status).toBe("blocked");
      expect(r.blockedReason).toBe(reason);
    }
  });

  it("parseReport drops any other blockedReason", () => {
    const r = parseImplementerReport(jsonl({ summary: "s", status: "blocked", blockedReason: "bored" }));
    expect(r.status).toBe("blocked");
    expect(r.blockedReason).toBeUndefined();
  });

  it("missing-context halt text points at the task description, not a split", () => {
    const text = blockedHaltText("T3", {
      status: "blocked",
      blockedReason: "missing-context",
      summary: "needs the mise usage variadic syntax",
    })!;
    expect(text).toContain("blockedReason: missing-context");
    expect(text).toContain("needs the mise usage variadic syntax");
    expect(text).toContain("task description");
    expect(text).toContain("/discuss -> /finalize");
    expect(text).not.toContain("split");
  });

  it("halt text names the blockedReason and the summary", () => {
    const text = blockedHaltText("T1", { status: "blocked", blockedReason: "too-large", summary: "task spans 9 files" });
    expect(text).toContain("too-large");
    expect(text).toContain("task spans 9 files");
    expect(blockedHaltText("T1", { status: "partial", summary: "x" })).toBeUndefined();
  });
});
