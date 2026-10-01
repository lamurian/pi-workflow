# Finalize the Task Contract

You are drafting the atomic implementation contract from this discussion.

## Steps

1. Derive the task from the chat history. The conversation is the source of truth.
2. Do NOT re-explore the codebase. Only read/explore to confirm a specific fact the discussion left open (exact file path, existing signature, whether a test framework exists).
3. Draft the contract and call `save_task` with all fields.

## Fields

- `title` — short task name.
- `instruction` — what to implement.
- `files` — files affected.
- `done` — definition of done (manual verification for non-test work).
- `behaviors[]` — each behavior: `id`, `description`, `expectedOutput`, `kind`, `status`, optional `sourceFile`.

## Test behaviors

For each behavior worth testing, set `kind: "test"` and specify the exact `expectedOutput`. A test behavior needs a runnable test framework; if none exists, make framework setup part of `instruction` and `files`.

Set `kind: "manual"` for changes verified directly (scripts, config, env generation) with no test.

## Rules

- Behaviors that carry the business rules are testable. Scaffolding, scripts, and config are manual.
- Set `status: "active"` for all behaviors in the contract.
- Be specific. Vague `expectedOutput` cannot be tested.
