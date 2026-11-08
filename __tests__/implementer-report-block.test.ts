import { describe, expect, it } from "vitest";
import { extractReportBlock, parseImplementerReport } from "../extensions/implementer-report.ts";
import { hasParseableReport } from "../extensions/implementer-runner.ts";

const F = "```";
const toStdout = (text: string): string =>
  JSON.stringify({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text }] } });

describe("extractReportBlock", () => {
  const prose = `I end with a ${F}json block, not ${F}text fences.\n${F}json\n{"summary":"real","status":"complete"}\n${F}`;

  it("parseImplementerReport reads the final block past prose fences", () => {
    const r = parseImplementerReport(toStdout(prose));
    expect(r.summary).toBe("real");
    expect(r.status).toBe("complete");
  });

  it("hasParseableReport accepts prose mentioning json fence", () => {
    expect(hasParseableReport(`See the ${F}json block below.\n${F}json\n{"summary":"x"}\n${F}`)).toBe(true);
  });

  it("returns the last of two valid blocks", () => {
    const t = `${F}json\n{"summary":"first"}\n${F}\n${F}json\n{"summary":"second"}\n${F}`;
    expect(extractReportBlock(t)?.summary).toBe("second");
  });
});
