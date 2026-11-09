import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { createRunTool } from "../extensions/contract-guard/run-tool.ts";
import { createContractGuardExtension, guardToolCall } from "../extensions/contract-guard/index.ts";
import { DEFAULT_SUITE_TIMEOUT_MS, OUTPUT_TAIL_CHARS } from "../extensions/test-extension-constants.ts";

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

  it("exec timeout follows PI_TEST_TIMEOUT_MS when it is a positive number", async () => {
    const exec = vi.fn().mockResolvedValue({ stdout: "ok", stderr: "", code: 0, killed: false });
    const tool = createRunTool({ exec } as never, {
      PI_UNIT_FILE: payloadFile(),
      PI_TEST_TIMEOUT_MS: "1234",
    });
    await tool.execute("id", { name: "lint" }, undefined, undefined, ctx);
    expect(exec).toHaveBeenCalledWith(
      "npm",
      ["run", "lint"],
      expect.objectContaining({ cwd: "/repo", timeout: 1234 }),
    );
  });

  it("exec timeout falls back to DEFAULT_SUITE_TIMEOUT_MS when PI_TEST_TIMEOUT_MS is unset or not a positive number", async () => {
    const envs = [
      { PI_UNIT_FILE: payloadFile() },
      { PI_UNIT_FILE: payloadFile(), PI_TEST_TIMEOUT_MS: "0" },
      { PI_UNIT_FILE: payloadFile(), PI_TEST_TIMEOUT_MS: "abc" },
    ];
    for (const env of envs) {
      const exec = vi.fn().mockResolvedValue({ stdout: "ok", stderr: "", code: 0, killed: false });
      const tool = createRunTool({ exec } as never, env);
      await tool.execute("id", { name: "lint" }, undefined, undefined, ctx);
      expect(exec).toHaveBeenCalledWith(
        "npm",
        ["run", "lint"],
        expect.objectContaining({ cwd: "/repo", timeout: DEFAULT_SUITE_TIMEOUT_MS }),
      );
    }
  });

  it("caps long output at OUTPUT_TAIL_CHARS with a leading ellipsis; short output unchanged", async () => {
    const filler = "A".repeat(OUTPUT_TAIL_CHARS);
    const exec = vi.fn().mockResolvedValue({
      stdout: "x".repeat(100) + filler,
      stderr: "",
      code: 0,
      killed: false,
    });
    const tool = createRunTool({ exec } as never, { PI_UNIT_FILE: payloadFile() });
    const long = await tool.execute("id", { name: "lint" }, undefined, undefined, ctx);
    const longText = long.content[0]?.text ?? "";
    expect(longText).toContain(`\n…${filler}`);
    expect(longText.endsWith(filler)).toBe(true);

    const shortExec = vi.fn().mockResolvedValue({ stdout: "tiny", stderr: "", code: 0, killed: false });
    const shortTool = createRunTool({ exec: shortExec } as never, { PI_UNIT_FILE: payloadFile() });
    const short = await shortTool.execute("id", { name: "lint" }, undefined, undefined, ctx);
    const shortText = short.content[0]?.text ?? "";
    expect(shortText).toContain("tiny");
    expect(shortText).not.toContain("…");
  });
});
