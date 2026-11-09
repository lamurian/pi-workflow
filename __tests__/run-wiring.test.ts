import { describe, it, expect } from "vitest";
import { chmodSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { writeContractGuardFile } from "../extensions/contract-guard-file.ts";
import { deriveAllowlist } from "../extensions/contract-derive.ts";
import { buildImplementerArgs } from "../extensions/implementer-args.ts";
import { buildUnitTask } from "../extensions/unit-task-text.ts";
import type { RunPlan } from "../extensions/run-plan.ts";
import type { ContractV2, TaskContract, WorkflowState } from "../extensions/state.ts";
import { mockPi } from "./helpers/implement-harness.ts";

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

// T3: the production spawn chain (createDefaultUnitRunner -> runImplementerUnit
// -> spawnRpcUnitClient -> buildImplementerArgs) must forward the task's
// command names and the run plan end-to-end. The leaf functions are covered
// above; this exercises the wiring between them with a real child spawn.
describe("spawn wiring (T3): runCommands + runPlan reach the unit", () => {
  /** Contract whose T3 task lists a command absent from PLAN (not plan-backed). */
  const SPAWN_CONTRACT: ContractV2 = {
    title: "Spawn",
    instruction: "ctx",
    done: "pass",
    sources: [
      { path: "src/a.ts", status: "M", tasks: ["T1"] },
      { path: "src/b.ts", status: "M", tasks: ["T2"] },
      { path: "src/c.ts", status: "M", tasks: ["T3"] },
    ],
    tests: [],
    tasks: [
      { id: "T1", description: "a", expectedOutput: ["x"], status: "active", commands: ["lint"] },
      { id: "T2", description: "b", expectedOutput: ["y"], status: "active" },
      { id: "T3", description: "c", expectedOutput: ["z"], status: "active", commands: ["deploy"] },
    ],
  } as ContractV2;

  it("grants run and fills the payload only for plan-backed task commands", async () => {
    const dir = mkdtempSync(join(tmpdir(), "pi-spawn-wiring-"));
    const argvFile = join(dir, "argv.txt");
    const reportFile = join(dir, "report.jsonl");
    const fake = join(dir, "fake-pi.sh");
    const reportText =
      'done.\n```json\n{"summary": "implemented", "suggestedCommit": "feat(x): done"}\n```';
    writeFileSync(
      reportFile,
      JSON.stringify({
        type: "message_end",
        message: { role: "assistant", content: [{ type: "text", text: reportText }] },
      }) + "\n",
    );
    // Fake pi: record argv, answer prompts with the report, exit on abort.
    writeFileSync(
      fake,
      "#!/bin/sh\n" +
        'printf "%s\\n" "$@" > "$PI_ARGV_FILE"\n' +
        "while IFS= read -r line; do\n" +
        "  case \"$line\" in\n" +
        `    *'"type":"prompt"'*) cat "$PI_REPORT_FILE" ;;\n` +
        `    *'"type":"abort"'*) exit 0 ;;\n` +
        "  esac\n" +
        "done\nexit 0\n",
    );
    chmodSync(fake, 0o755);

    const state = {
      phase: "implementing",
      specText: "topic",
      baselineHead: "base",
      contractV2: SPAWN_CONTRACT,
      runPlan: PLAN,
      task: {
        title: "Spawn Task",
        instruction: "do it",
        files: [{ path: "src/a.ts", status: "M" }],
        done: "pass",
        behaviors: [],
      },
    } as unknown as WorkflowState;

    const prev = {
      PI_BIN: process.env.PI_BIN,
      PI_ARGV_FILE: process.env.PI_ARGV_FILE,
      PI_REPORT_FILE: process.env.PI_REPORT_FILE,
    };
    process.env.PI_BIN = fake;
    process.env.PI_ARGV_FILE = argvFile;
    process.env.PI_REPORT_FILE = reportFile;

    try {
      const { createDefaultUnitRunner } = await import("../extensions/unit-runner-default.ts");
      const runner = createDefaultUnitRunner(mockPi(), state, state.task!);
      const payloadPath = join(dir, ".pi", "workflow", "contract-guard.json");

      const spawnOnce = async (behaviorId: string): Promise<{ tools: string[]; payload: Record<string, unknown> }> => {
        const report = await runner(
          { behaviorId, taskText: `unit ${behaviorId}`, kind: "test" },
          dir,
          undefined,
          () => {},
        );
        expect(report.error, `unit ${behaviorId} must settle cleanly`).toBeUndefined();
        const argv = readFileSync(argvFile, "utf8").split("\n");
        const payload = JSON.parse(readFileSync(payloadPath, "utf8")) as Record<string, unknown>;
        await report.client?.shutdown();
        return { tools: toolsOf(argv), payload };
      };

      // T1 lists `lint`, backed by PLAN.commands -> granted and filled.
      const t1 = await spawnOnce("T1");
      expect(t1.tools).toContain("run");
      expect(t1.payload.commands).toEqual({ lint: ["npm", "run", "lint"] });
      expect((t1.payload.unit as { commands: unknown }).commands).toEqual(["lint"]);

      // T2 lists no commands -> no grant, empty payload tables.
      const t2 = await spawnOnce("T2");
      expect(t2.tools).not.toContain("run");
      expect(t2.payload.commands).toEqual({});
      expect((t2.payload.unit as { commands: unknown }).commands).toEqual([]);

      // T3 lists `deploy`, which PLAN does not declare -> not granted, not listed.
      const t3 = await spawnOnce("T3");
      expect(t3.tools).not.toContain("run");
      expect(t3.payload.commands).toEqual({});
      expect((t3.payload.unit as { commands: unknown }).commands).toEqual([]);
    } finally {
      for (const key of ["PI_BIN", "PI_ARGV_FILE", "PI_REPORT_FILE"] as const) {
        if (prev[key] === undefined) delete process.env[key];
        else process.env[key] = prev[key];
      }
    }
  }, 60_000);
});
