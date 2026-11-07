import { describe, expect, it } from "vitest";
import { retryRedSuite } from "../extensions/gate-retry.ts";

const red = (tail: string) => ({ label: "js", passed: false, tail });
const owned = ["__tests__/mine.test.ts"];

describe("retryRedSuite", () => {
  it("passes flaky suite and names first-run failing paths", async () => {
    const o = await retryRedSuite(
      red("FAIL __tests__/mine.test.ts > x"),
      async () => ({ label: "js", passed: true, tail: "ok" }),
      owned,
    );
    expect(o.kind).toBe("flaky");
    expect(o.result.passed).toBe(true);
    expect(o.note).toContain("__tests__/mine.test.ts");
  });

  it("defers foreign twice-red failures to the final gate", async () => {
    const t = "FAIL __tests__/other.test.ts > y";
    const o = await retryRedSuite(red(t), async () => red(t), owned);
    expect(o.kind).toBe("foreign");
    expect(o.result.passed).toBe(true);
    expect(o.note).toContain("final gate");
    expect(o.note).toContain("__tests__/other.test.ts");
  });

  it("stays red for owned or unparseable failures", async () => {
    const t = "FAIL __tests__/mine.test.ts > z";
    const a = await retryRedSuite(red(t), async () => red(t), owned);
    expect(a.kind).toBe("owned");
    expect(a.result.passed).toBe(false);
    const b = await retryRedSuite(red("boom"), async () => red("boom"), owned);
    expect(b.kind).toBe("owned");
    expect(b.result.passed).toBe(false);
  });
});
