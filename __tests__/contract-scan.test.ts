import { describe, it, afterEach } from "vitest";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { runContractScan } from "../extensions/contract-scan.ts";

const tmpDirs: string[] = [];
afterEach(() => {
  while (tmpDirs.length) fs.rmSync(tmpDirs.pop()!, { recursive: true, force: true });
});

function tmpProject(files: Record<string, string>): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-cscan-"));
  tmpDirs.push(dir);
  for (const [rel, content] of Object.entries(files)) {
    const full = path.join(dir, rel);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, content);
  }
  return dir;
}

function piWith(exec: ExtensionAPI["exec"]): ExtensionAPI {
  return { exec } as unknown as ExtensionAPI;
}

describe("runContractScan (git-aware)", () => {
  it("lists via git ls-files and never surfaces gitignored paths", async () => {
    const dir = tmpProject({
      "src/a.ts": "export const a = 1;\n",
      "tests/a.test.ts": "import { a } from '../src/a'\n",
      ".pixi/envs/x/a.test.ts": "import { a } from '../src/a'\n",
    });
    const calls: Array<[string, string[]]> = [];
    const pi = piWith(async (cmd: string, args: string[] = []) => {
      calls.push([cmd, args]);
      return { stdout: "src/a.ts\ntests/a.test.ts\n", stderr: "", code: 0, killed: false };
    });

    const res = await runContractScan(pi, dir, [{ path: "src/a.ts", status: "M" }]);

    assert.deepEqual(calls[0], ["git", ["ls-files", "--cached", "--others", "--exclude-standard"]]);
    assert.ok(res);
    const all = [...res.evidence, ...res.warnings].join("\n");
    assert.doesNotMatch(all, /\.pixi/);
    assert.match(all, /tests\/a\.test\.ts/);
  });

  it("returns null when git exits non-zero", async () => {
    const pi = piWith(async () => ({ stdout: "src/a.ts\n", stderr: "", code: 128, killed: false }));
    assert.equal(await runContractScan(pi, "/tmp", [{ path: "src/a.ts", status: "M" }]), null);
  });

  it("returns null when git returns no paths", async () => {
    const pi = piWith(async () => ({ stdout: "\n", stderr: "", code: 0, killed: false }));
    assert.equal(await runContractScan(pi, "/tmp", [{ path: "src/a.ts", status: "M" }]), null);
  });
});
