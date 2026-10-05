# Finalize the Task Contract

You are drafting the atomic implementation contract from this discussion.

## Steps

1. Derive the task from the chat history. The conversation is the source of truth.
2. Draft the contract and call `save_task` with all fields.
3. `save_task` returns deterministic scan evidence and advisory warnings. Classify each evidence item (see Test classification) and revise the contract if the evidence surfaces test paths you missed. You may read files to confirm a specific fact — an exact path, an existing signature, or an `unverified` evidence item — but the discussion stays the primary source.
4. Call `save_task` again with the revised contract. Iterate until the evidence and warnings are clean or consciously accepted.

## Fields

- `title` — short task name.
- `instruction` — what to implement.
- `files` — files affected. Declare every test path the contract updates or removes here (see Test classification).
- `done` — definition of done (manual verification for non-test work).
- `behaviors[]` — each behavior: `id`, `description`, `expectedOutput`, `kind`, `status`, optional `sourceFile`.

## Co-location rule (atomic green commits)

**One behavior = test + implementation in the same commit — never split.**

- `kind: "test"` means *verified-by-test*: the behavior carries the observable outcome AND the test that verifies it. The commit lands green because test and implementation ship together.
- A behavior whose `expectedOutput` describes test artifacts only ("test file contains 3 cases", "tests covering edge cases") is invalid: such a commit is **red by construction** — a test without its implementation. Rewrite the `expectedOutput` as the observable behavior the test asserts.
- Behaviors must be **independently green-committable**: each behavior's commit passes the project's pre-commit hooks on its own. No test-before-implementation splits, no scaffold-only behaviors.
- Test updates never form their own behavior. When a behavior supersedes or removes existing tests, fold the test change into that same behavior's `instruction` and commit.

## Test classification

`save_task` returns **scan evidence**: per-`files`-entry match lines with method and confidence tags (`[symbol, high]`, `[basename, low]`, `unverified`), plus advisory warnings (`undeclared-referencing`, `declared-not-found`, `no-evidence`). Classify every evidence item:

- **preserved** — the test asserts behavior the contract keeps. Do not declare it; the guard protects it automatically.
- **superseded** — the test asserts old behavior the contract changes. Declare the path in `files`, and describe the required test update in the superseding behavior's `instruction` (folded, never its own behavior).
- **obsolete** — the test covers behavior the contract removes. Declare the path in `files`; for pure-removal contracts describe the removal in a manual behavior ("remove legacy path + its tests; suite green").
- **out-of-scope** — the test is already dead or broken for reasons unrelated to this contract. Report it to the user as a recommendation for a separate `/discuss`. Never fold it into this contract.

An `unverified` confidence tag means derivation found no hit (default export, indirect reference, or no affected tests). Confirm by reading the test files or declare known paths directly in `files` — never assume `unverified` means "no tests affected".

## Rules

- Behaviors that carry the business rules are testable. Scaffolding, scripts, and config are manual.
- Declare superseded and obsolete test paths in `files`. Undeclared test paths are protected by the staged-diff guard: deleting or skipping them halts implementation.
- Set `status: "active"` for all behaviors in the contract.
- Be specific. Vague `expectedOutput` cannot be tested.
- Advisory warnings never block the save, but read every one — each names a contract-quality issue you can fix before `/implement`.
