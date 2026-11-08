import { describe, it } from "vitest";
import assert from "node:assert/strict";
import { isSplitChild, parseSplitProposal, splitOrHalt, runSplitChild, type RuntimeSplitOptions } from "../extensions/split-planner.ts";

const PROPOSAL = '```json\n{"tasks":[{"description":"a","expectedOutput":["x"],"paths":["a.ts"]},{"description":"b","expectedOutput":["y"],"paths":["b.ts"]}]}\n```';

function setup(
  opts: {
    vetoed?: boolean;
    saveOk?: boolean;
    behaviorId?: string;
    /** Injected confirm behavior (throw / resolve with no answer). */
    confirm?: () => Promise<boolean | undefined>;
    /** Injected planner behavior (throw / return unparseable output). */
    planner?: () => Promise<string>;
  } = {},
) {
  const calls: { payload: Record<string, unknown>; caller: string; dry: boolean }[] = [];
  const confirms: { timeout?: number }[] = [];
  const state = { phase: "implementing", task: { behaviors: [{ id: "T1" }] }, contractV2: { tasks: [{ id: "T1" }] } } as never;
  const ctx = {
    cwd: "/tmp",
    ui: {
      notify: () => {},
      confirm: async (_t: string, _m: string, o?: { timeout?: number }) => {
        confirms.push(o ?? {});
        if (opts.confirm) return opts.confirm();
        return opts.vetoed ?? false;
      },
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
    planner: opts.planner ?? (async () => PROPOSAL), save: save as never,
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

  it("appends the veto reason to the halt text on veto", async () => {
    const { calls, options } = setup({ vetoed: true });
    const res = await splitOrHalt(options, "too large", { halt: async (t) => t, runChild: async () => "child" });
    assert.equal(res, "too large\nRuntime split not applied: vetoed");
    assert.equal(calls.length, 1);
  });

  it("appends the save_task rejection text to the halt text when the proposal is rejected", async () => {
    const { options } = setup({ saveOk: false });
    const res = await splitOrHalt(options, "too large", { halt: async (t) => t, runChild: async () => "child" });
    assert.equal(res, "too large\nRuntime split not applied: rejected");
  });

  it("appends the underlying planner error when the planner fails", async () => {
    const { options } = setup({ planner: async () => { throw new Error("boom"); } });
    const res = await splitOrHalt(options, "too large", { halt: async (t) => t, runChild: async () => "child" });
    assert.equal(res, "too large\nRuntime split not applied: planner failed: Error: boom");
  });

  it("appends the missing-proposal reason when the planner returns no proposal", async () => {
    const { options } = setup({ planner: async () => "not a proposal" });
    const res = await splitOrHalt(options, "too large", { halt: async (t) => t, runChild: async () => "child" });
    assert.equal(res, "too large\nRuntime split not applied: planner returned no proposal");
  });

  it("a throwing confirm is treated as no veto and the split proceeds", async () => {
    const { options } = setup({ confirm: async () => { throw new Error("ui down"); } });
    const ran: string[] = [];
    const res = await splitOrHalt(options, "too large", { halt: async (t) => t, runChild: async (id) => { ran.push(id); return undefined; } });
    assert.equal(res, undefined);
    assert.deepEqual(ran, ["T1.1", "T1.2"]);
  });

  it("a confirm resolving after its timeout with no answer proceeds with the split", async () => {
    const { options } = setup({
      confirm: async () => {
        await new Promise((r) => setTimeout(r, 10));
        return undefined;
      },
    });
    const ran: string[] = [];
    const res = await splitOrHalt(options, "too large", { halt: async (t) => t, runChild: async (id) => { ran.push(id); return undefined; } });
    assert.equal(res, undefined);
    assert.deepEqual(ran, ["T1.1", "T1.2"]);
  });

  it("a split child halts instead of splitting again", async () => {
    const { calls, options } = setup({ behaviorId: "T1.1" });
    const res = await splitOrHalt(options, "timeout halt", { halt: async (t) => t, runChild: async () => undefined });
    assert.equal(res, "timeout halt");
    assert.equal(calls.length, 0);
    assert.equal(isSplitChild("T1.1"), true);
    assert.equal(isSplitChild("T1"), false);
  });

  it("runs split children once against the replaced state.task and persists done", async () => {
    const state = { task: { behaviors: [{ id: "T1.1", status: "active" }, { id: "T1.2", status: "active" }] } } as never as { task: { behaviors: { id: string; status: string }[] } };
    const ran: string[] = []; let saves = 0;
    const run = async (c: { id: string }) => { ran.push(c.id); return undefined; };
    for (const id of ["T1.1", "T1.2"]) await runSplitChild(state as never, id, run as never, () => saves++);
    for (const id of ["T1.1", "T1.2"]) await runSplitChild(state as never, id, run as never, () => saves++);
    assert.deepEqual(ran, ["T1.1", "T1.2"]);
    assert.equal(saves, 2);
    assert.ok(state.task.behaviors.every((b) => b.status === "done"));
  });

  it("a halt during child k leaves k onward active", async () => {
    const state = { task: { behaviors: [{ id: "T1.1", status: "active" }, { id: "T1.2", status: "active" }, { id: "T1.3", status: "active" }] } } as never as { task: { behaviors: { id: string; status: string }[] } };
    const run = async (c: { id: string }) => (c.id === "T1.2" ? "halt" : undefined);
    let res: unknown;
    for (const id of ["T1.1", "T1.2", "T1.3"]) { res = await runSplitChild(state as never, id, run as never, () => {}); if (res) break; }
    assert.equal(res, "halt");
    assert.deepEqual(state.task.behaviors.filter((b) => b.status === "active").map((b) => b.id), ["T1.2", "T1.3"]);
  });

  it("runSplitChild marks a completed child done in state.contractV2", async () => {
    const state = { task: { behaviors: [{ id: "T1.1", status: "active" }] }, contractV2: { tasks: [{ id: "T1.1", status: "active" }] } } as never as { contractV2: { tasks: { id: string; status: string }[] } };
    await runSplitChild(state as never, "T1.1", (async () => undefined) as never, () => {});
    assert.equal(state.contractV2.tasks[0].status, "done");
  });

  it("parses the last json block", () => {
    assert.equal(parseSplitProposal(PROPOSAL)?.length, 2);
    assert.equal(parseSplitProposal("nope"), undefined);
  });
});
