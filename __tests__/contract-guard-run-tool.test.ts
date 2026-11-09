import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { createRunTool } from "../extensions/contract-guard/run-tool.ts";
import { createContractGuardExtension, guardToolCall } from "../extensions/contract-guard/index.ts";

function payloadFile(): string {
  const dir = mkdtempSync(join(tmpdir(), "run-tool-"));
  const file = join(dir, "unit.json");
  writeFileSync(
    file,
    JSON.stringify({
      repoRoot: "/repo",
      allowlist: [],
      unit: { id: "T1", commands: ["lint", "ghost"] },
      commands: { lint: ["npm", "run", "lint"], other: ["echo"] },
    }),
  );
  return file;
}

const ctx = { cwd: "/elsewhere" };

describe("contract-guard run tool", () => {
  it("executes a listed command via pi.exec in repoRoot", async () => {
    const exec = vi.fn().mockResolvedValue({ stdout: "out", stderr: "", code: 2, killed: false });
    const tool = createRunTool({ exec } as never, { PI_UNIT_FILE: payloadFile() });
    const res = await tool.execute("id", { name: "lint" }, undefined, undefined, ctx);
    expect(exec).toHaveBeenCalledWith("npm", ["run", "lint"], expect.objectContaining({ cwd: "/repo" }));
    expect(res.content[0]?.text.startsWith("## lint\nexit 2")).toBe(true);
    expect(res.content[0]?.text).toContain("out");
    expect(res.isError).toBe(true);
  });

  it("succeeds on exit 0 with legacy env fallback", async () => {
    const exec = vi.fn().mockResolvedValue({ stdout: "ok", stderr: "", code: 0, killed: false });
    const tool = createRunTool({ exec } as never, { PI_CONTRACT_GUARD_FILE: payloadFile() });
    const res = await tool.execute("id", { name: "lint" }, undefined, undefined, ctx);
    expect(res.content[0]?.text.startsWith("## lint\nexit 0")).toBe(true);
    expect(res.isError).toBeFalsy();
  });

  it("rejects unlisted or argv-less names without exec", async () => {
    const exec = vi.fn();
    const tool = createRunTool({ exec } as never, { PI_UNIT_FILE: payloadFile() });
    for (const name of ["other", "ghost"]) {
      const res = await tool.execute("id", { name }, undefined, undefined, ctx);
      expect(res.isError).toBe(true);
      expect(res.content[0]?.text).toContain("is not listed for this task (allowed: lint, ghost)");
    }
    expect(exec).not.toHaveBeenCalled();
  });

  it("registers run next to delete_file and lets run pass the hook", async () => {
    const names: string[] = [];
    const pi = { on: vi.fn(), registerTool: (t: { name: string }) => names.push(t.name), exec: vi.fn() };
    createContractGuardExtension({})(pi as never);
    expect(names).toEqual(expect.arrayContaining(["delete_file", "run"]));
    expect(await guardToolCall({}, { toolName: "run", input: { name: "x" } })).toBeUndefined();
  });
});
