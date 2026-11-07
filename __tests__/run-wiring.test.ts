import { describe, it, expect } from "vitest";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { writeContractGuardFile } from "../extensions/contract-guard-file.ts";
import { deriveAllowlist } from "../extensions/contract-derive.ts";
import { buildImplementerArgs } from "../extensions/implementer-args.ts";
import { buildUnitTask } from "../extensions/unit-task-text.ts";
import type { RunPlan } from "../extensions/run-plan.ts";
import type { ContractV2, TaskContract } from "../extensions/state.ts";

const CONTRACT: ContractV2 = {
  title: "Run",
  instruction: "ctx",
  done: "pass",
  sources: [
    { path: "src/a.ts", status: "M", tasks: ["T1"] },
    { path: "src/b.ts", status: "M", tasks: ["T2"] },
  ],
  tests: [],
  tasks: [
    { id: "T1", description: "a", expectedOutput: ["x"], status: "active", commands: ["lint"] },
    { id: "T2", description: "b", expectedOutput: ["y"], status: "active" },
  ],
} as ContractV2;

const PLAN: RunPlan = {
  scoped: [],
  full: [],
  commands: { lint: ["npm", "run", "lint"], build: ["npm", "run", "build"] },
  configHash: "none",
};

const pi = {
  exec: async () => ({ stdout: "", stderr: "", code: 0, killed: false }),
} as unknown as ExtensionAPI;

function payload(taskId: string): Record<string, unknown> {
  const tmp = mkdtempSync(join(tmpdir(), "pi-run-wiring-"));
  return writeContractGuardFile(pi, tmp, deriveAllowlist(CONTRACT), "base", {
    contract: CONTRACT,
    taskId,
    runPlan: PLAN,
  }).then((p) => JSON.parse(readFileSync(p, "utf8"))) as unknown as Record<string, unknown>;
}

function toolsOf(args: string[]): string[] {
  return args[args.indexOf("--tools") + 1]!.split(",");
}

describe("run tool wiring (T19)", () => {
  it("payload carries exactly the task's commands from the run plan", async () => {
    const p1 = (await payload("T1")) as { commands: unknown; unit: { commands: unknown } };
    expect(p1.commands).toEqual({ lint: ["npm", "run", "lint"] });
    expect(p1.unit.commands).toEqual(["lint"]);
    const p2 = (await payload("T2")) as { commands: unknown };
    expect(p2.commands).toEqual({});
  });

  it("grants run only to units whose task lists commands and names them", () => {
    expect(toolsOf(buildImplementerArgs("", undefined, undefined, undefined, ["lint"]))).toContain("run");
    expect(toolsOf(buildImplementerArgs("", undefined))).not.toContain("run");
    const behavior = (id: string) => ({ id, description: "", expectedOutput: "", kind: "test" as const });
    const task = {} as TaskContract;
    expect(buildUnitTask(behavior("T1") as never, task, { contract: CONTRACT })).toMatch(/`run`.*lint/);
    expect(buildUnitTask(behavior("T2") as never, task, { contract: CONTRACT })).not.toMatch(/`run`/);
  });
});
