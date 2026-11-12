import { describe, it } from "vitest";
import assert from "node:assert/strict";
import { buildPlannerTask, isSplitChild, parseSplitProposal, splitOrHalt, runSplitChild, type RuntimeSplitOptions } from "../extensions/split-planner.ts";

const PROPOSAL = '```json\n{"tasks":[{"description":"a","expectedOutput":[1,0],"paths":["a.ts"]},{"description":"b","expectedOutput":[0],"paths":["b.ts"]}]}\n```';

function setup(
  opts: {
    vetoed?: boolean;
    saveOk?: boolean;
    behaviorId?: string;
    /** Injected confirm behavior (throw / resolve with no answer). */
    confirm?: () => Promise<boolean | undefined>;
    /** Injected planner behavior (throw / return unparseable output); receives the task text. */
    planner?: (taskText: string) => Promise<string>;
    /** Dry-run save rejections: the i-th dry call rejects with texts[i]; later calls succeed. */
    dryRejectTexts?: string[];
  } = {},
) {
  const calls: { payload: Record<string, unknown>; caller: string; dry: boolean }[] = [];
  const confirms: { timeout?: number }[] = [];
  const state = {
    phase: "implementing",
    task: { behaviors: [{ id: "T1" }] },
    contractV2: {
      tasks: [
        {
          id: "T1",
          description: "parent task",
          expectedOutput: ["alpha assertion", "beta assertion"],
          status: "active",
        },
      ],
    },
  } as never;
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
  let dryCount = 0;
  const save = async (s: { task: { behaviors: { id: string }[] } }, payload: Record<string, unknown>, o: { caller: string }) => {
    const dry = s !== state;
    calls.push({ payload, caller: o.caller, dry });
    if (opts.saveOk === false) return { ok: false, text: "rejected" };
    if (dry) {
      const text = opts.dryRejectTexts?.[dryCount];
      dryCount += 1;
      if (text !== undefined) return { ok: false, text };
    }
    s.task.behaviors = [{ id: "T1.1" }, { id: "T1.2" }];
    return { ok: true, text: "ok" };
  };
  const plannerTexts: string[] = [];
  const innerPlanner = opts.planner ?? (async () => PROPOSAL);
  const options: RuntimeSplitOptions = {
    pi: {} as never, ctx, state, behaviorId: opts.behaviorId ?? "T1", trigger: "timeout",
    planner: async (taskText) => { plannerTexts.push(taskText); return innerPlanner(taskText); },
    save: save as never,
  };
  return { calls, confirms, plannerTexts, options };
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

  it("maps child expectedOutput indices to the parent's exact assertion strings before save_task", async () => {
    const { calls, options } = setup();
    await splitOrHalt(options, "too large", { halt: async (t) => t, runChild: async () => undefined });
    assert.equal(calls.length, 2);
    assert.deepEqual(calls[0]!.payload.tasks, [
      { description: "a", expectedOutput: ["beta assertion", "alpha assertion"], paths: ["a.ts"] },
      { description: "b", expectedOutput: ["alpha assertion"], paths: ["b.ts"] },
    ]);
    assert.deepEqual(calls[1]!.payload.tasks, calls[0]!.payload.tasks);
  });

  it("never submits a proposal with a non-integer or out-of-range index and the reason names it", async () => {
    const cases: ReadonlyArray<readonly [indices: string, named: string]> = [
      ['"x"', '"x"'],
      ["7", "7"],
      ["0.5", "0.5"],
      ["-1", "-1"],
    ];
    for (const [indices, named] of cases) {
      const { calls, options } = setup({
        planner: async () => `{"tasks":[{"description":"a","expectedOutput":[${indices}],"paths":["a.ts"]}]}`,
      });
      const res = await splitOrHalt(options, "too large", { halt: async (t) => t, runChild: async () => "child" });
      assert.equal(calls.length, 0, `index ${indices} never reaches save_task`);
      assert.equal(
        res,
        `too large\nRuntime split not applied: invalid expectedOutput index ${named} in child 1`,
      );
    }
  });

  it("buildPlannerTask numbers the parent's assertions from 0 and appends the behavior's findings ledger", () => {
    const state = {
      phase: "implementing",
      contractV2: {
        tasks: [
          {
            id: "T1",
            description: "parent task",
            expectedOutput: ["alpha assertion", "beta assertion"],
            status: "active",
          },
        ],
      },
      findings: [
        { behaviorId: "T1", text: "lint lives in .golangci.yml" },
        { behaviorId: "global", text: "shared fact from the orchestrator" },
        { behaviorId: "T2", text: "private fact of another behavior" },
      ],
    } as never;
    const text = buildPlannerTask(state, "T1", "timeout");
    assert.match(text, /\n0: alpha assertion/);
    assert.match(text, /\n1: beta assertion/);
    assert.ok(!text.includes("private fact of another behavior"));
    assert.match(text, /## Known findings from earlier units/);
    assert.match(text, /- \[T1\] lint lives in \.golangci\.yml/);
    assert.match(text, /- \[global\] shared fact from the orchestrator/);
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
    const { options, plannerTexts } = setup({ saveOk: false });
    const res = await splitOrHalt(options, "too large", { halt: async (t) => t, runChild: async () => "child" });
    assert.equal(res, "too large\nRuntime split not applied: rejected");
    assert.equal(plannerTexts.length, 2, "the rejection triggers exactly one repair re-run");
  });

  it("appends the underlying planner error when the planner fails", async () => {
    const { options } = setup({ planner: async () => { throw new Error("boom"); } });
    const res = await splitOrHalt(options, "too large", { halt: async (t) => t, runChild: async () => "child" });
    assert.equal(res, "too large\nRuntime split not applied: planner failed: Error: boom");
  });

  it("appends the missing-proposal reason when the planner returns no proposal", async () => {
    const { options, plannerTexts } = setup({ planner: async () => "not a proposal" });
    const res = await splitOrHalt(options, "too large", { halt: async (t) => t, runChild: async () => "child" });
    assert.equal(res, "too large\nRuntime split not applied: planner returned no proposal");
    assert.equal(plannerTexts.length, 2, "the missing proposal triggers exactly one repair re-run");
  });

  it("re-runs the planner with the dry-run rejection reason and applies a valid second proposal", async () => {
    const second = '```json\n{"tasks":[{"description":"c","expectedOutput":[0],"paths":["c.ts"]}]}\n```';
    let plannerRuns = 0;
    const { calls, plannerTexts, options } = setup({
      dryRejectTexts: ["first rejection"],
      planner: async () => (++plannerRuns === 1 ? PROPOSAL : second),
    });
    const ran: string[] = [];
    const res = await splitOrHalt(options, "too large", { halt: async (t) => t, runChild: async (id) => { ran.push(id); return undefined; } });
    assert.equal(plannerTexts.length, 2, "the planner is called a second time");
    assert.match(plannerTexts[1]!, /first rejection/, "the second task text carries the rejection reason");
    assert.equal(res, undefined, "the second proposal applies");
    assert.deepEqual(ran, ["T1.1", "T1.2"]);
    const applied = calls.filter((c) => !c.dry);
    assert.equal(applied.length, 1, "exactly one real save applies the split");
    assert.deepEqual(applied[0]!.payload.tasks, [
      { description: "c", expectedOutput: ["alpha assertion"], paths: ["c.ts"] },
    ]);
  });

  it("a failing second proposal ends the round with its reason and no third planner call", async () => {
    const { plannerTexts, options } = setup({
      dryRejectTexts: ["first rejection", "second rejection"],
    });
    const res = await splitOrHalt(options, "too large", { halt: async (t) => t, runChild: async () => "child" });
    assert.equal(plannerTexts.length, 2, "the planner is not called a third time");
    assert.ok(
      typeof res === "string" && res.endsWith("Runtime split not applied: second rejection"),
      `halt text ends with the second reason: ${String(res)}`,
    );
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
