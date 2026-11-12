import { describe, it } from "vitest";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/** Load the guard extension against a mock pi; return only the tool_call hook. */
async function loadHook(guardFile?: string): Promise<
  (event: Record<string, unknown>) => Promise<{ block?: boolean; reason?: string } | undefined>
> {
  const mod = await import("../extensions/contract-guard/index.ts");
  const handlers = new Map<string, (event: Record<string, unknown>) => Promise<unknown>>();
  const pi = {
    on: (name: string, handler: (event: Record<string, unknown>) => Promise<unknown>) => {
      handlers.set(name, handler);
      return () => {};
    },
    registerTool: () => {},
  };
  const env = guardFile ? { PI_UNIT_FILE: guardFile } : {};
  mod.createContractGuardExtension(env)(pi as never);
  return handlers.get("tool_call") as (event: Record<string, unknown>) => Promise<
    { block?: boolean; reason?: string } | undefined
  >;
}

/** Write a valid guard payload pointing repoRoot at `root`. */
function writePayload(root: string): string {
  const dir = mkdtempSync(join(tmpdir(), "pi-search-scope-"));
  const file = join(dir, "contract-guard.json");
  writeFileSync(file, JSON.stringify({ repoRoot: root, files: [] }));
  return file;
}

/** Build a tool_call event with an optional path. */
function call(toolName: string, path?: string): Record<string, unknown> {
  return {
    type: "tool_call",
    toolCallId: "call-1",
    toolName,
    input: path === undefined ? {} : { path },
  };
}

describe("grep/find project-directory restriction (T3)", () => {
  it("blocks grep and find whose path is outside the repo root", async () => {
    const hook = await loadHook(writePayload("/repo"));
    for (const toolName of ["grep", "find"]) {
      for (const path of ["/home/user/notes.txt", "../gateway/mise.toml", "~/secrets.env"]) {
        const result = await hook(call(toolName, path));
        assert.equal(result?.block, true, `${toolName} ${path} must be blocked`);
        assert.match(
          result?.reason ?? "",
          /project directory/,
          `reason names the project-directory restriction (${toolName} ${path})`,
        );
      }
    }
  });

  it("allows in-repo, `.` and path-less searches", async () => {
    const hook = await loadHook(writePayload("/repo"));
    for (const toolName of ["grep", "find"]) {
      for (const path of [undefined, ".", "src", "/repo/src/a.ts"]) {
        assert.equal(await hook(call(toolName, path)), undefined, `${toolName} ${path ?? "(no path)"} passes`);
      }
    }
  });

  it("read and ls stay pure passthrough for out-of-repo paths", async () => {
    const hook = await loadHook(writePayload("/repo"));
    for (const toolName of ["read", "ls"]) {
      assert.equal(await hook(call(toolName, "/etc/passwd")), undefined, `${toolName} passes unchanged`);
    }
  });

  it("falls back to process.cwd() when the guard payload is missing", async () => {
    const hook = await loadHook();
    const outside = await hook(call("grep", "/definitely/not/the/project"));
    assert.equal(outside?.block, true, "an absolute path outside cwd is still blocked");
    assert.match(outside?.reason ?? "", /project directory/);
    assert.equal(await hook(call("grep", "src")), undefined, "in-repo relative search still passes");
  });
});
