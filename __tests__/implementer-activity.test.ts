import { describe, expect, it, vi } from "vitest";
import { relayImplementerEvent } from "../extensions/implementer-activity.ts";

function setup() {
  const appendEntry = vi.fn();
  const pi = { appendEntry } as never;
  const ctx = { ui: { setStatus: vi.fn(), notify: vi.fn() } } as never;
  return { appendEntry, pi, ctx };
}

describe("implementer activity log", () => {
  it("persists tool names for turns with tool calls", () => {
    const { appendEntry, pi, ctx } = setup();
    relayImplementerEvent(pi, ctx, "T1", "1/1", {
      type: "turn_end",
      message: {
        content: [
          { type: "toolCall", name: "read" },
          { type: "toolCall", name: "edit" },
        ],
      },
    });
    const text = appendEntry.mock.calls[0][1].text as string;
    expect(text).toContain("read");
    expect(text).toContain("edit");
    expect(text).not.toContain("working with tools");
  });

  it("keeps responding wording without tool calls", () => {
    const { appendEntry, pi, ctx } = setup();
    relayImplementerEvent(pi, ctx, "T1", "1/1", {
      type: "turn_end",
      message: { content: [{ type: "text", text: "hi" }] },
    });
    expect(appendEntry.mock.calls[0][1].text).toBe("responding…");
  });

  it("persists token usage on assistant messages", () => {
    const { appendEntry, pi, ctx } = setup();
    relayImplementerEvent(pi, ctx, "T1", "1/1", {
      type: "message_end",
      message: {
        role: "assistant",
        content: [{ type: "text", text: "done" }],
        usage: { input: 1234, output: 56 },
      },
    });
    const text = appendEntry.mock.calls[0][1].text as string;
    expect(text).toContain("done");
    expect(text).toContain("in=1234");
    expect(text).toContain("out=56");
  });
});
