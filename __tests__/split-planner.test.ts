import { describe, it } from "vitest";
import assert from "node:assert/strict";
import { isSplitChild, parseSplitProposal, splitOrHalt, type RuntimeSplitOptions } from "../extensions/split-planner.ts";

const PROPOSAL = '```json\n{"tasks":[{"description":"a","expectedOutput":["x"],"paths":["a.ts"]},{"description":"b","expectedOutput":["y"],"paths":["b.ts"]}]}\n```';

function setup(opts: { vetoed?: boolean; saveOk?: boolean; behaviorId?: string } = {}) {
  const calls: { payload: Record<string, unknown>; caller: string; dry: boolean }[] = [];
  const confirms: { timeout?: number }[] = [];
  const state = { phase: "implementing", task: { behaviors: [{ id: "T1" }] }, contractV2: { tasks: [{ id: "T1" }] } } as never;
  const ctx = {
    cwd: "/tmp",
    ui: {
      notify: () => {},
      confirm: async (_t: string, _m: string, o?: { timeout?: number }) => { confirms.push(o ?? {}); return opts.vetoed ?? false; },
    },
  } as never;
  const save = async (s: { task: { behaviors: { id: string }[] } }, payload: Record<string, unknown>, o: { caller: string }) => {
    calls.push({ payload, caller: o.caller, dry: s !== state });
    if (opts.saveOk === false) return { ok: false, text: "rejected" };
    s.task.behaviors = [{ id: "T1.1" }, { id: "T1.2" }];
    return { ok: true, text: "ok" };
  };
  const options: RuntimeSplitOptions = {
    pi: {} as never, ctx, state, behaviorId: opts.behaviorId ?? "T1", trigger: "timeout",
    planner: async () => PROPOSAL, save: save as never,
  };
  return { calls, confirms, options };
}

describe("runtime split planner", () => {
  it("submits the proposal through save_task with operation split and caller orchestrator", async () => {
    const { calls, options } = setup();
    await splitOrHalt(options, "too large", { halt: async (t) => t, runChild: async () => undefined });
    assert.equal(calls.length, 2);
    assert.equal(calls[0].dry, true);
    for (const c of calls) {
      assert.equal(c.payload.operation, "split");
      assert.equal(c.payload.parentId, "T1");
      assert.equal(c.caller, "orchestrator");
    }
  });

  it("applies after a 60s veto window without veto and runs children in order", async () => {
    const { confirms, options } = setup();
    const ran: string[] = [];
    const res = await splitOrHalt(options, "too large", { halt: async (t) => t, runChild: async (id) => { ran.push(id); return undefined; } });
    assert.equal(res, undefined);
    assert.equal(confirms[0].timeout, 60_000);
    assert.deepEqual(ran, ["T1.1", "T1.2"]);
  });

  it("halts with the existing text on veto", async () => {
    const { calls, options } = setup({ vetoed: true });
    const res = await splitOrHalt(options, "too large", { halt: async (t) => t, runChild: async () => "child" });
    assert.equal(res, "too large");
    assert.equal(calls.length, 1);
  });

  it("halts with the existing text when the proposal is rejected", async () => {
    const { options } = setup({ saveOk: false });
    const res = await splitOrHalt(options, "too large", { halt: async (t) => t, runChild: async () => "child" });
    assert.equal(res, "too large");
  });

  it("a split child halts instead of splitting again", async () => {
    const { calls, options } = setup({ behaviorId: "T1.1" });
    const res = await splitOrHalt(options, "timeout halt", { halt: async (t) => t, runChild: async () => undefined });
    assert.equal(res, "timeout halt");
    assert.equal(calls.length, 0);
    assert.equal(isSplitChild("T1.1"), true);
    assert.equal(isSplitChild("T1"), false);
  });

  it("parses the last json block", () => {
    assert.equal(parseSplitProposal(PROPOSAL)?.length, 2);
    assert.equal(parseSplitProposal("nope"), undefined);
  });
});
