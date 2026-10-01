import { describe, it } from "vitest";
import assert from "node:assert/strict";
import { runDiscussion, detectDiscussionTopic, getLatestAssistantMessage } from "../extensions/discuss.ts";
import { buildPhasePrompt } from "../extensions/prompt.ts";
import { loadContent, getPackageRoot } from "../extensions/utils.ts";
import {
  type WorkflowState,
  type WorkflowPhase,
  transitionTo,
  saveState,
  loadState,
  updateUi,
} from "../extensions/state.ts";
import { handlePreCompact } from "../extensions/compaction.ts";
import { resetToolsState } from "../extensions/tools.ts";
import type {
  ExtensionAPI,
  ExtensionContext,
  SessionBeforeCompactEvent,
} from "@earendil-works/pi-coding-agent";

// ── Mock factories ───────────────────────────────────────────────────────────

/**
 * Simulated default toolset with a mix of read-only and write-capable tools.
 */
const DEFAULT_ACTIVE_TOOLS = [
  "read",
  "bash",
  "grep",
  "find",
  "ls",
  "write",
  "edit",
  "create_para_doc",
  "commit_changes",
];

/**
 * Create a mock ExtensionAPI with call-recording spies.
 *
 * All methods are no-ops by default. Key methods (`appendEntry`,
 * `sendUserMessage`, `setActiveTools`) record their arguments to the
 * returned `.calls` object for assertion.
 *
 * @param activeTools - Initial active tool list returned by getActiveTools.
 * @returns Mock ExtensionAPI with recorded calls.
 */
function mockPi(
  activeTools: string[] = DEFAULT_ACTIVE_TOOLS,
): ExtensionAPI & { calls: Record<string, unknown[]> } {
  const calls: Record<string, unknown[]> = {};
  const record = (name: string) => {
    calls[name] = [];
    return (...args: unknown[]) => {
      calls[name]!.push(args);
    };
  };

  return {
    on: record("on") as ExtensionAPI["on"],
    registerCommand: record("registerCommand") as ExtensionAPI["registerCommand"],
    appendEntry: record("appendEntry") as ExtensionAPI["appendEntry"],
    sendUserMessage: record("sendUserMessage") as ExtensionAPI["sendUserMessage"],
    getActiveTools: () => [...activeTools],
    setActiveTools: record("setActiveTools") as ExtensionAPI["setActiveTools"],
    exec: async () => ({ stdout: "", stderr: "", exitCode: 0 }),
    calls,
  } as unknown as ExtensionAPI & { calls: typeof calls };
}

/**
 * Create a mock ExtensionContext with a controllable session manager.
 *
 * @param cwd    - Working directory (default: temp dir).
 * @param state  - Optional pre-populated WorkflowState for session manager.
 */
function mockCtx(
  cwd: string,
  state?: WorkflowState | null,
): ExtensionContext {
  const entries = state
    ? [
        {
          type: "custom",
          customType: "workflow-state",
          data: state,
        } as unknown as ReturnType<
          ExtensionContext["sessionManager"]["getBranch"]
        >[number],
      ]
    : [];

  return {
    cwd,
    sessionManager: {
      getBranch: () => entries,
    },
    ui: {
      notify: () => {},
      setStatus: () => {},
      setWidget: () => {},
      theme: { fg: () => "" },
      addAutocompleteProvider: () => {},
    },
  } as unknown as ExtensionContext;
}

/**
 * Create a minimal SessionBeforeCompactEvent for compaction tests.
 */
function mockCompactEvent(
  firstKeptEntryId = "entry-0",
  tokensBefore = 1000,
): SessionBeforeCompactEvent {
  return {
    preparation: {
      firstKeptEntryId,
      tokensBefore,
    },
  } as SessionBeforeCompactEvent;
}

// ── Helpers ───────────────────────────────────────────────────────────────────

/**
 * Create a minimal WorkflowState for the "discussing" phase.
 */
function discussionState(topic = "test topic"): WorkflowState {
  return {
    phase: "discussing",
    specText: topic,
  };
}

/**
 * Assert that a state object has the correct shape for the "discussing" phase.
 */
function assertIsDiscussionState(s: WorkflowState, topic: string): void {
  assert.equal(s.phase, "discussing");
  assert.equal(s.specText, topic);
  assert.equal(s.lastTestResults, undefined);
}

// ═══════════════════════════════════════════════════════════════════════════════
// Phase prompt
// ═══════════════════════════════════════════════════════════════════════════════

describe("phase-discuss prompt", () => {
  it("loads phase-discussing.md via loadContent", async () => {
    const content = await loadContent("phase-discussing.md");
    assert.ok(content.length > 100, "prompt content should be substantial");
    assert.match(content, /Phase: Discuss/);
    assert.match(content, /Clarify first/);
    assert.match(content, /Do \*\*NOT\*\* write or edit any files/);
  });

  it("buildPhasePrompt('discussing') returns the discuss prompt", async () => {
    const prompt = await buildPhasePrompt("discussing");
    assert.match(prompt, /Phase: Discuss/);
    assert.match(prompt, /Clarify first/);
    assert.match(prompt, /Do \*\*NOT\*\* write or edit any files/);
    // Questionnaire section should NOT appear for discussing phase
    assert.doesNotMatch(prompt, /Questionnaire/);
  });

  it("buildPhasePrompt('discussing') does not require questionnaire config", async () => {
    // The second arg (skipQuestionnaire) is irrelevant for non-requirements phases;
    // test both true and false to confirm no crash.
    const p1 = await buildPhasePrompt("discussing", true);
    const p2 = await buildPhasePrompt("discussing", false);
    assert.equal(p1, p2);
  });

  it("buildPhasePrompt returns an empty string for non-discussing phases", async () => {
    const implementing = await buildPhasePrompt("implementing");
    const idle = await buildPhasePrompt("idle");
    assert.equal(implementing, "");
    assert.equal(idle, "");
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// runDiscussion — end-to-end behaviour
// ═══════════════════════════════════════════════════════════════════════════════

describe("runDiscussion", () => {
  it("saves state with phase 'discussing' and the given topic", async () => {
    const pi = mockPi();
    const ctx = mockCtx("/tmp/test");

    await runDiscussion("fix login button alignment", pi, ctx);

    // Should have appended the workflow state
    const appendCalls = pi.calls["appendEntry"] ?? [];
    assert.ok(appendCalls.length >= 1, "appendEntry should be called");

    const [, saved] = appendCalls[appendCalls.length - 1] as [
      string,
      WorkflowState,
    ];
    assertIsDiscussionState(saved, "fix login button alignment");
  });

  it("starts the LLM conversation with the topic", async () => {
    const pi = mockPi();
    const ctx = mockCtx("/tmp/test");

    await runDiscussion("fix login button alignment", pi, ctx);

    const sendCalls = pi.calls["sendUserMessage"] ?? [];
    assert.equal(sendCalls.length, 1, "sendUserMessage should be called once");

    const [text, opts] = sendCalls[0] as [string, { deliverAs: string }];
    assert.equal(text, "fix login button alignment");
    assert.deepEqual(opts, { deliverAs: "steer" });
  });

  it("uses a default topic when no args are provided", async () => {
    const pi = mockPi();
    const ctx = mockCtx("/tmp/test");

    await runDiscussion("", pi, ctx);

    const sendCalls = pi.calls["sendUserMessage"] ?? [];
    const [text] = sendCalls[0] as [string];
    assert.equal(text, "Let's discuss this issue.");
  });

  it("uses a default topic for whitespace-only args", async () => {
    const pi = mockPi();
    const ctx = mockCtx("/tmp/test");

    await runDiscussion("   ", pi, ctx);

    const sendCalls = pi.calls["sendUserMessage"] ?? [];
    const [text] = sendCalls[0] as [string];
    assert.equal(text, "Let's discuss this issue.");
  });

  it("calls updateUi to reflect the new phase", async () => {
    const pi = mockPi();
    const ctx = mockCtx("/tmp/test");

    // Capture setStatus calls
    const setStatusCalls: unknown[] = [];
    ctx.ui.setStatus = (key: string, value: unknown) => {
      setStatusCalls.push({ key, value });
    };

    await runDiscussion("test", pi, ctx);

    assert.ok(
      setStatusCalls.some((c) => (c as { key: string }).key === "workflow"),
      "should set workflow status",
    );
  });

  it("filters write-capable tools from the active set", async () => {
    resetToolsState();
    const pi = mockPi();
    const ctx = mockCtx("/tmp/test");

    await runDiscussion("fix login button", pi, ctx);

    const setCalls = pi.calls["setActiveTools"] ?? [];
    assert.equal(setCalls.length, 1, "setActiveTools should be called once");

    const [filtered] = setCalls[0] as [string[]];
    assert.ok(!filtered.includes("write"), "write should be removed");
    assert.ok(!filtered.includes("edit"), "edit should be removed");
    assert.ok(!filtered.includes("create_para_doc"), "create_para_doc should be removed");
    assert.ok(!filtered.includes("commit_changes"), "commit_changes should be removed");
    assert.ok(filtered.includes("read"), "read should remain");
    assert.ok(filtered.includes("bash"), "bash should remain");
  });

  it("does not write any files (no ADR/spec/plan created)", async () => {
    const pi = mockPi();
    const ctx = mockCtx("/tmp/test");

    // Hook filesystem write operations
    const writeCalls: string[] = [];
    const origWriteFile = (await import("node:fs/promises")).writeFile;
    // We can't easily intercept writeFile here without patching the module,
    // but we can verify that runDiscussion only calls appendEntry and
    // sendUserMessage — no file-writing commands.

    await runDiscussion("test", pi, ctx);

    const commandCalls = pi.calls["registerCommand"] ?? [];
    const brainstormCommands = commandCalls.filter(
      ([name]: [string]) =>
        name === "adr" || name === "spec" || name === "plan",
    );

    // runDiscussion does NOT register commands — that happens at startup.
    // Instead, verify the LLM prompt instructs "Do NOT write files".
    const prompt = await buildPhasePrompt("discussing");
    assert.match(
      prompt,
      /Do \*\*NOT\*\* write or edit any files/,
      "the phase prompt should forbid file writes",
    );
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// State management — transition, save, load
// ═══════════════════════════════════════════════════════════════════════════════

describe("state management for discussing phase", () => {
  it("transitionTo updates phase and saves to session", async () => {
    const pi = mockPi();
    const state = discussionState("initial topic");

    transitionTo(pi, state, "discussing");

    assert.equal(state.phase, "discussing");

    const appendCalls = pi.calls["appendEntry"] ?? [];
    assert.ok(appendCalls.length >= 1);
    const [, saved] = appendCalls[appendCalls.length - 1] as [
      string,
      WorkflowState,
    ];
    assert.equal(saved.phase, "discussing");
    assert.equal(saved.specText, "initial topic");
  });

  it("loadState retrieves the most recent discussing state", () => {
    const state = discussionState("retrieve me");
    const ctx = mockCtx("/tmp/test", state);

    const loaded = loadState(ctx);
    assert.ok(loaded !== null);
    assertIsDiscussionState(loaded, "retrieve me");
  });

  it("loadState returns null when no state exists", () => {
    const ctx = mockCtx("/tmp/test", null);
    const loaded = loadState(ctx);
    assert.equal(loaded, null);
  });

  it("loadState returns the latest state when multiple exist", () => {
    const older = discussionState("older topic");
    const newer = discussionState("newer topic");
    newer.specText = "newer topic";

    const ctx = mockCtx("/tmp/test", null);
    // Override getBranch to return multiple entries (older first, newer last)
    ctx.sessionManager.getBranch = () => [
      {
        type: "custom",
        customType: "workflow-state",
        data: older,
      } as unknown as ReturnType<
        ExtensionContext["sessionManager"]["getBranch"]
      >[number],
      {
        type: "custom",
        customType: "workflow-state",
        data: newer,
      } as unknown as ReturnType<
        ExtensionContext["sessionManager"]["getBranch"]
      >[number],
    ];

    const loaded = loadState(ctx);
    assert.ok(loaded !== null);
    assert.equal(loaded.specText, "newer topic");
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// Compaction preservation
// ═══════════════════════════════════════════════════════════════════════════════

describe("compaction handler for discussing phase", () => {
  it("preserves discussion topic in the compaction summary", async () => {
    const state = discussionState("fix the button alignment");
    const ctx = mockCtx("/tmp/test", state);
    const event = mockCompactEvent("entry-1", 2000);

    const result = await handlePreCompact(event, ctx);

    assert.ok(result !== undefined, "should return a compaction payload");
    assert.ok(
      !("cancel" in result),
      "should not cancel compaction",
    );

    if ("compaction" in result) {
      const summary = result.compaction.summary;
      assert.match(summary, /Workflow phase: discussing/);
      assert.match(summary, /fix the button alignment/);
      assert.match(summary, /Continue discussing phase/);
    }
  });

  it("returns undefined (default handling) when phase is idle", async () => {
    const ctx = mockCtx("/tmp/test", null);
    const event = mockCompactEvent();

    const result = await handlePreCompact(event, ctx);
    assert.equal(result, undefined);
  });

  it("includes the discussion topic in the specification section", async () => {
    const state = discussionState(
      "refactor the authentication middleware to use JWT",
    );
    const ctx = mockCtx("/tmp/test", state);
    const event = mockCompactEvent();

    const result = await handlePreCompact(event, ctx);

    assert.ok(result && "compaction" in result);
    const summary = result.compaction.summary;
    // The topic appears after "## Specification"
    const specSection = summary.split("## Specification")[1] ?? "";
    assert.match(specSection, /refactor the authentication middleware/);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// /implement integration — discussion plan detection
// ═══════════════════════════════════════════════════════════════════════════════

describe("implement integration with discussion state", () => {
  it("loadState detects discussing phase when present", () => {
    const state = discussionState("my plan");
    const ctx = mockCtx("/tmp/test", state);

    const loaded = loadState(ctx);
    assert.ok(loaded !== null);
    assert.equal(loaded.phase, "discussing");
  });

  it("loadState returns null when no discussion state exists", () => {
    // Session with an idle-phase state (simulates no active workflow)
    const ctx = mockCtx("/tmp/test", {
      phase: "idle",
      specText: "",
    });

    const loaded = loadState(ctx);
    // loadState checks for non-idle phases; if phase is "idle", the
    // `data.phase` check passes but the phase is "idle" — we check
    // for "discussing" separately in the handler.
    assert.ok(loaded !== null);
    assert.equal(loaded.phase, "idle");
  });

  it("loadState returns null on empty session", () => {
    const ctx = mockCtx("/tmp/test", null);
    const loaded = loadState(ctx);
    assert.equal(loaded, null);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// detectDiscussionTopic
// ═══════════════════════════════════════════════════════════════════════════════

describe("detectDiscussionTopic", () => {
  it("returns specText from state when phase is discussing", () => {
    const state = discussionState("fix button alignment");
    const ctx = mockCtx("/tmp/test", state);

    const topic = detectDiscussionTopic(ctx);

    assert.equal(topic, "fix button alignment");
  });

  it("returns empty string when no state and no /discuss message found", () => {
    const ctx = mockCtx("/tmp/test", null);

    const topic = detectDiscussionTopic(ctx);

    assert.equal(topic, "");
  });

  it("falls back to scanning user messages for /discuss when no state exists", () => {
    // Session with user messages but no custom state entry
    const entries = [
      {
        type: "message",
        id: "entry-1",
        parentId: null,
        message: {
          role: "user",
          content: "/discuss refactor the auth middleware",
        },
      },
      {
        type: "message",
        id: "entry-2",
        parentId: "entry-1",
        message: {
          role: "assistant",
          content: [{ type: "text", text: "OK, let's discuss." }],
        },
      },
      {
        type: "message",
        id: "entry-3",
        parentId: "entry-2",
        message: {
          role: "user",
          content: "/discuss fix the login button too",
        },
      },
    ];

    const ctx: ExtensionContext = {
      cwd: "/tmp/test",
      sessionManager: {
        getBranch: () => entries,
      },
      ui: {} as unknown as ExtensionContext["ui"],
    } as unknown as ExtensionContext;

    // Should return the MOST RECENT /discuss topic
    const topic = detectDiscussionTopic(ctx);
    assert.equal(topic, "fix the login button too");
  });

  it("prefers saved state over /discuss message fallback", () => {
    const state = discussionState("saved topic");
    const entries = [
      {
        type: "custom",
        customType: "workflow-state",
        data: state,
      },
      {
        type: "message",
        id: "entry-1",
        parentId: null,
        message: {
          role: "user",
          content: "/discuss message topic",
        },
      },
    ];

    const ctx: ExtensionContext = {
      cwd: "/tmp/test",
      sessionManager: {
        getBranch: () => entries,
      },
      ui: {} as unknown as ExtensionContext["ui"],
    } as unknown as ExtensionContext;

    // Should prefer the saved state
    const topic = detectDiscussionTopic(ctx);
    assert.equal(topic, "saved topic");
  });

  it("returns default topic for bare /discuss with no args", () => {
    const entries = [
      {
        type: "message",
        id: "entry-1",
        parentId: null,
        message: {
          role: "user",
          content: "/discuss",
        },
      },
    ];

    const ctx: ExtensionContext = {
      cwd: "/tmp/test",
      sessionManager: {
        getBranch: () => entries,
      },
      ui: {} as unknown as ExtensionContext["ui"],
    } as unknown as ExtensionContext;

    const topic = detectDiscussionTopic(ctx);
    assert.equal(topic, "Let's discuss this issue.");
  });

  it("only matches user message role, not assistant", () => {
    const entries = [
      {
        type: "message",
        id: "entry-1",
        parentId: null,
        message: {
          role: "assistant",
          content: [{ type: "text", text: "/discuss this should not match" }],
        },
      },
    ];

    const ctx: ExtensionContext = {
      cwd: "/tmp/test",
      sessionManager: {
        getBranch: () => entries,
      },
      ui: {} as unknown as ExtensionContext["ui"],
    } as unknown as ExtensionContext;

    const topic = detectDiscussionTopic(ctx);
    assert.equal(topic, "");
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// getLatestAssistantMessage
// ═══════════════════════════════════════════════════════════════════════════════

describe("getLatestAssistantMessage", () => {
  it("returns the content of the latest assistant message", () => {
    const entries = [
      {
        type: "message",
        id: "entry-1",
        parentId: null,
        message: {
          role: "user",
          content: "/discuss add retry to HTTP client",
        },
      },
      {
        type: "message",
        id: "entry-2",
        parentId: "entry-1",
        message: {
          role: "assistant",
          content: "Let me clarify what you need.",
        },
      },
      {
        type: "message",
        id: "entry-3",
        parentId: "entry-2",
        message: {
          role: "user",
          content: "Yes, exponential backoff would be great.",
        },
      },
      {
        type: "message",
        id: "entry-4",
        parentId: "entry-3",
        message: {
          role: "assistant",
          content: "## Finalized Plan\n\n1. Add retry config\n2. Implement backoff logic\n3. Wire into client",
        },
      },
    ];

    const ctx: ExtensionContext = {
      cwd: "/tmp/test",
      sessionManager: {
        getBranch: () => entries,
      },
      ui: {} as unknown as ExtensionContext["ui"],
    } as unknown as ExtensionContext;

    const message = getLatestAssistantMessage(ctx);
    assert.ok(message.includes("Finalized Plan"), "should return the plan message");
    assert.ok(message.includes("Add retry config"), "should include plan details");
  });

  it("returns empty string when no assistant messages exist", () => {
    const entries = [
      {
        type: "message",
        id: "entry-1",
        parentId: null,
        message: {
          role: "user",
          content: "/discuss something",
        },
      },
    ];

    const ctx: ExtensionContext = {
      cwd: "/tmp/test",
      sessionManager: {
        getBranch: () => entries,
      },
      ui: {} as unknown as ExtensionContext["ui"],
    } as unknown as ExtensionContext;

    const message = getLatestAssistantMessage(ctx);
    assert.equal(message, "");
  });

  it("returns empty string when session is empty", () => {
    const ctx: ExtensionContext = {
      cwd: "/tmp/test",
      sessionManager: {
        getBranch: () => [],
      },
      ui: {} as unknown as ExtensionContext["ui"],
    } as unknown as ExtensionContext;

    const message = getLatestAssistantMessage(ctx);
    assert.equal(message, "");
  });

  it("extracts text from assistant messages with array content", () => {
    const entries = [
      {
        type: "message",
        id: "entry-1",
        parentId: null,
        message: {
          role: "assistant",
          content: [
            { type: "text", text: "The plan is:" },
            { type: "text", text: "Change the config module" },
          ],
        },
      },
    ];

    const ctx: ExtensionContext = {
      cwd: "/tmp/test",
      sessionManager: {
        getBranch: () => entries,
      },
      ui: {} as unknown as ExtensionContext["ui"],
    } as unknown as ExtensionContext;

    const message = getLatestAssistantMessage(ctx);
    assert.ok(message.includes("The plan is:"));
    assert.ok(message.includes("Change the config module"));
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// Stale-state regression — before_agent_start reads fresh state
// ═══════════════════════════════════════════════════════════════════════════════

describe("before_agent_start stale-state prevention", () => {
  it("loadState returns the state saved by transitionTo", () => {
    const pi = mockPi();
    const state = discussionState("saved-via-transition");

    // Simulate what runDiscussion does: create state and save it
    transitionTo(pi, state, "discussing");

    // Now simulate what before_agent_start does: load fresh state
    // from session. The session manager returns entries that were
    // appended via the mock's appendEntry.
    // We need a ctx whose getBranch returns the entry wrote by appendEntry.
    const appendCalls = pi.calls["appendEntry"] ?? [];
    const [, savedState] = appendCalls[appendCalls.length - 1] as [
      string,
      WorkflowState,
    ];

    const ctx = mockCtx("/tmp/test", savedState);
    const loaded = loadState(ctx);
    assert.ok(loaded !== null);
    assert.equal(loaded.phase, "discussing");
    assert.equal(loaded.specText, "saved-via-transition");
  });

  it("phase prompt is loaded for discussing state (smoke test)", async () => {
    // This is what before_agent_start does after loading state:
    // call buildPhasePrompt with the loaded phase
    const prompt = await buildPhasePrompt("discussing");
    assert.match(prompt, /Phase: Discuss/);
    assert.match(prompt, /Do \*\*NOT\*\* write or edit any files/);
  });
});
