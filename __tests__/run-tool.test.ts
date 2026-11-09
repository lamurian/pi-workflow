// T2: the generated test extension registers ONLY the `test` tool. The
// pinned-command `run` tool moved to the child contract guard
// (extensions/contract-guard/run-tool.ts, tested in
// __tests__/contract-guard-run-tool.test.ts) so a unit child can never hit
// the `Tool "run" conflicts` extension-load error.
import { describe, it, afterEach } from "vitest";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { generateTestExtension } from "../extensions/test-extension-template.ts";
import type { TestSuite } from "../extensions/test-tool-detect.ts";

interface ToolDef {
  name: string;
}

const SUITES: TestSuite[] = [{ label: "javascript (npm run test)", argv: ["npm", "run", "test"] }];

/** The npm + go detection behind __tests__/fixtures/test-extension.golden.txt. */
const GOLDEN_SUITES: TestSuite[] = [
  { label: "javascript (npm run test)", argv: ["npm", "run", "test"] },
  { label: "go (go test ./...)", argv: ["go", "test", "./..."] },
];

const tmpDirs: string[] = [];
const prevUnit = process.env.PI_UNIT_FILE;

afterEach(() => {
  for (const d of tmpDirs.splice(0)) rmSync(d, { recursive: true, force: true });
  if (prevUnit === undefined) delete process.env.PI_UNIT_FILE;
  else process.env.PI_UNIT_FILE = prevUnit;
});

function tmp(): string {
  const dir = mkdtempSync(join(tmpdir(), "pi-gen-tools-"));
  tmpDirs.push(dir);
  return dir;
}

/** Load the generated extension with the given PI_UNIT_FILE; return registered tool names. */
async function registeredTools(unitFile: string | undefined): Promise<string[]> {
  if (unitFile === undefined) delete process.env.PI_UNIT_FILE;
  else process.env.PI_UNIT_FILE = unitFile;
  const file = join(tmp(), "gen.mjs");
  writeFileSync(file, generateTestExtension(SUITES));
  const mod = (await import(/* @vite-ignore */ pathToFileURL(file).href)) as {
    default: (pi: unknown) => void;
  };
  const names: string[] = [];
  mod.default({
    registerTool: (def: ToolDef) => {
      names.push(def.name);
    },
    exec: async () => ({ stdout: "", stderr: "", code: 0, killed: false }),
  });
  return names;
}

describe("generated extension tool set", () => {
  it("registers only the `test` tool when PI_UNIT_FILE is unset", async () => {
    assert.deepEqual(await registeredTools(undefined), ["test"]);
  });

  it("registers only the `test` tool when PI_UNIT_FILE is set", async () => {
    const file = join(tmp(), "unit.json");
    writeFileSync(file, JSON.stringify({ repoRoot: "/proj", unit: { commands: ["lint"] } }));
    assert.deepEqual(await registeredTools(file), ["test"]);
  });

  it("generation output is byte-identical to the golden fixture", () => {
    const golden = readFileSync(
      fileURLToPath(new URL("./fixtures/test-extension.golden.txt", import.meta.url)),
      "utf8",
    );
    assert.equal(generateTestExtension(GOLDEN_SUITES), golden);
  });
});
