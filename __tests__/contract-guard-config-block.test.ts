import { describe, expect, it } from "vitest";
import { checkToolAction } from "../extensions/contract-guard-core.ts";

describe("run-config block", () => {
  for (const path of [".pi/workflow.json", ".pi/sandbox.json"]) {
    for (const action of ["write", "edit", "delete_file"]) {
      it(`blocks ${action} on ${path} even when declared`, () => {
        const r = checkToolAction({
          action,
          path,
          cwd: "/repo",
          taskId: "T5",
          files: [{ path, status: action === "delete_file" ? "D" : "M", tasks: ["T5"] }],
        });
        expect(r.allowed).toBe(false);
        if (!r.allowed) {
          expect(r.reason).toContain("update_workflow_config");
          expect(r.reason).toContain("discussing phase");
        }
      });
    }
  }
});
