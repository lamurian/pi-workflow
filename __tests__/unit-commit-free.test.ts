// T6 — units are no longer asked to suggest a commit message:
// the unit prompt's report format, both task-text variants and the
// report-reminder steer must all be free of `suggestedCommit`.
import { describe, it } from "vitest";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { buildUnitTask } from "../extensions/unit-task-text.ts";
import { REPORT_REMINDER_MESSAGE } from "../extensions/report-reminder.ts";
import type { Behavior, ContractV2, TaskContract } from "../extensions/state.ts";

/** Read content/unit-prompt.md from disk. */
const loadPrompt = (): Promise<string> =>
  readFile(new URL("../content/unit-prompt.md", import.meta.url), "utf8");

/**
 * Extract the mandatory report-format section (heading to EOF).
 *
 * @param text - The full unit prompt.
 * @returns The section starting at the "## Report format (mandatory)" heading.
 */
const reportSection = (text: string): string => {
  const start = text.indexOf("## Report format (mandatory)");
  assert.notEqual(start, -1, "unit prompt has a Report format section");
  return text.slice(start);
};

/**
 * The last non-empty, trimmed line of a rendered text.
 *
 * @param text - Rendered task text.
 * @returns The final content line.
 */
const lastLine = (text: string): string =>
  text
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .pop() ?? "";

describe("unit prompt report format is commit-free (T6)", () => {
  it("the mandatory JSON report format no longer contains suggestedCommit", async () => {
    const prompt = await loadPrompt();
    assert.doesNotMatch(
      reportSection(prompt),
      /suggestedCommit/,
      "the report format must not ask units for a commit message",
    );
  });
});

describe("unit task text report instruction is commit-free (T6)", () => {
  const behavior: Behavior = {
    id: "T1",
    description: "x",
    expectedOutput: "y",
    kind: "test",
    status: "active",
  };
  const task: TaskContract = {
    title: "Commit Free",
    instruction: "do the thing",
    files: [{ path: "src/a.ts", status: "M" }],
    done: "tests pass",
    behaviors: [behavior],
  };
  const contract: ContractV2 = {
    title: "Commit Free",
    instruction: "do the thing",
    done: "tests pass",
    sources: [{ path: "src/a.ts", status: "M", tasks: ["T1"] }],
    tests: [],
    tasks: [{ id: "T1", description: "x", expectedOutput: ["y"], status: "active" }],
  };

  /**
   * Assert the task text ends with the report instruction and does not
   * name suggestedCommit in it.
   *
   * @param text  - The rendered task text.
   * @param label - Label used in failure messages.
   */
  const assertCommitFreeEnding = (text: string, label: string): void => {
    const end = lastLine(text);
    assert.match(end, /JSON report block/, `${label} ends with the report instruction`);
    assert.doesNotMatch(
      end,
      /suggestedCommit/,
      `${label} report instruction must not name suggestedCommit`,
    );
  };

  it("the full variant ends with the report instruction without suggestedCommit", () => {
    assertCommitFreeEnding(buildUnitTask(behavior, task), "full task text");
  });

  it("the slice variant ends with the report instruction without suggestedCommit", () => {
    assertCommitFreeEnding(
      buildUnitTask(behavior, task, { contract }),
      "slice task text",
    );
  });
});

describe("report-reminder steer is commit-free (T6)", () => {
  it("the reminder no longer names suggestedCommit", () => {
    assert.match(
      REPORT_REMINDER_MESSAGE,
      /JSON report block/,
      "the reminder still points at the mandatory report",
    );
    assert.doesNotMatch(
      REPORT_REMINDER_MESSAGE,
      /suggestedCommit/,
      "the reminder must not ask for a commit message",
    );
  });
});
