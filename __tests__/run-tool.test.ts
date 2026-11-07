import { describe, it, afterEach } from "vitest";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { generateTestExtension } from "../extensions/test-extension-template.ts";

interface ToolDef {
  name: string;
  execute: (...args: unknown[]) => Promise<{ content: Array<{ text: string }>; isError?: boolean }>;
}
interface ExecCall {
  cmd: string;
  args: string[];
  opts: { cwd: string };
}

const SUITES = [{ label: "javascript (npm run test)", argv: ["npm", "run", "test"] }];
const tmpDirs: string[] = [];
const prevUnit = process.env.PI_UNIT_FILE;

afterEach(() => {
  for (const d of tmpDirs.splice(0)) rmSync(d, { recursive: true, force: true });
  if (prevUnit === undefined) delete process.env.PI_UNIT_FILE;
  else process.env.PI_UNIT_FILE = prevUnit;
});

function tmp(): string {
  const dir = mkdtempSync(join(tmpdir(), "pi-run-"));
  tmpDirs.push(dir);
  return dir;
}

/** Load the generated extension with the given PI_UNIT_FILE and capture tools. */
async function load(unitFile: string | undefined): Promise<{ tools: Map<string, ToolDef>; calls: ExecCall[] }> {
  if (unitFile === undefined) delete process.env.PI_UNIT_FILE;
  else process.env.PI_UNIT_FILE = unitFile;
  const file = join(tmp(), "gen.mjs");
  writeFileSync(file, generateTestExtension(SUITES));
  const mod = (await import(/* @vite-ignore */ pathToFileURL(file).href)) as {
    default: (pi: unknown) => void;
  };
  const tools = new Map<string, ToolDef>();
  const calls: ExecCall[] = [];
  mod.default({
    registerTool: (def: ToolDef) => tools.set(def.name, def),
    exec: async (cmd: string, args: string[], opts: ExecCall["opts"]) => {
      calls.push({ cmd, args, opts });
      return { stdout: "lint ok", stderr: "", code: 0, killed: false };
    },
  });
  return { tools, calls };
}

function payload(): string {
  const file = join(tmp(), "unit.json");
  writeFileSync(
    file,
    JSON.stringify({
      repoRoot: "/proj",
      unit: { testFiles: [], commands: ["lint"] },
      commands: { lint: ["npx", "eslint", "."], build: ["npm", "run", "build"] },
    }),
  );
  return file;
}

describe("generated run tool", () => {
  it("registers run only when PI_UNIT_FILE is set", async () => {
    const without = await load(undefined);
    assert.ok(!without.tools.has("run"));
    assert.ok(without.tools.has("test"));
    const withUnit = await load(payload());
    assert.ok(withUnit.tools.has("run"));
  });

  it("executes the payload argv for a listed name via pi.exec", async () => {
    const { tools, calls } = await load(payload());
    const res = await tools.get("run")!.execute("id", { name: "lint" }, undefined, undefined, { cwd: "/x" });
    assert.equal(calls.length, 1);
    assert.equal(calls[0]!.cmd, "npx");
    assert.deepEqual(calls[0]!.args, ["eslint", "."]);
    assert.equal(calls[0]!.opts.cwd, "/proj");
    assert.equal(res.isError, undefined);
    assert.match(res.content[0]!.text, /^## lint\nexit 0\nlint ok/);
  });

  it("rejects names not listed for the task without executing", async () => {
    const { tools, calls } = await load(payload());
    for (const name of ["build", "rm", "__proto__"]) {
      const res = await tools.get("run")!.execute("id", { name }, undefined, undefined, { cwd: "/x" });
      assert.equal(res.isError, true);
      assert.match(res.content[0]!.text, /Nothing was run/);
    }
    assert.equal(calls.length, 0);
  });
});
