# Finalize the Task Contract

You are drafting the atomic implementation contract (contract v2) from this discussion.

## Steps

1. Derive the task from the chat history. The conversation is the source of truth.
2. Draft the contract and call `save_task` with all fields.
3. `save_task` returns a per-task summary (id → sources → tests → assertion count), deterministic scan evidence and advisory warnings. Classify each evidence item (see Test classification) and revise the contract if the evidence surfaces test paths you missed. You may read files to confirm a specific fact — an exact path, an existing signature, or an `unverified` evidence item — but the discussion stays the primary source.
4. Call `save_task` again with the revised contract. Iterate until the evidence and warnings are clean or consciously accepted.

## Fields (contract v2: sources, tests, tasks)

The contract is normalized: `sources` and `tests` are the two path lists and the single source of truth — the guard's allowlist, each unit's scope and the path ownership map are all derived from them. Declare each fact exactly once; never restate a path list anywhere else.

- `title` — short task name.
- `instruction` — shared context only: what the contract implements overall. Never put file lists here; paths belong in `sources`/`tests`.
- `done` — aggregate definition of done (manual verification for non-test work).
- `sources[]` — implementation files. Each entry: `{ path, status?, tasks }`.
- `tests[]` — test and fixture files. Each entry: `{ path, status?, tasks }`.
  - `tasks` — the ids of the tasks that own this path. Ownership is per path and strict: a unit may write or edit only paths whose `tasks` include its own task id, and may `delete_file` only a `status: "D"` path its task owns. Shared files name several task ids — overlapping refs are legal and first-class.
  - `status` — optional per-path FACT: absent = write-authorized (`A`/`M` is a display qualifier computed from git at save time, never enforced); `"D"` = delete authority, granted only to the tasks in `tasks` — so every `D` entry must name at least one owning task.
- `tasks[]` — task units, each `{ id, description, expectedOutput, status }`:
  - `expectedOutput` is an ARRAY — one entry per assertion. The task's tests must prove exactly these entries, no more and no fewer: per-task `expectedOutput` is the test's contract.
  - `status` — `active` for everything new (`done` survives a re-finalize via preservation; `removed` drops a task).
  - A task with no path refs is a pure-manual task and fine as is. A task with no `tests` refs derives an empty test scope and therefore no test gate — manual-ness is derived, never a declared field.

The generated test extension `.pi/extensions/test.ts` is **orchestrator-owned**: never declare it in `sources` or `tests` and never expect `save_task` to inject it into a path list — the orchestrator regenerates and commits it itself, and the in-turn guard blocks units from writing it unconditionally.

## Hard invariants (save_task rejects — blocking)

Each rejection below names the invariant; fix the contract and call `save_task` again:

- **dangling taskRef** — every `tasks` ref in a path entry resolves to a declared task id;
- **duplicate path** — no path appears twice within one array;
- **both lists** — no path in both `sources` and `tests`; each path belongs to exactly one list;
- **D entry with empty tasks** — every `status: "D"` entry names at least one owning task;
- **empty expectedOutput** — every task lists at least one assertion;
- **duplicate task id** — task ids are unique;
- **task too broad** — a task may own at most `finalize.maxPathsPerTask` paths (default 10) across `sources` and `tests`; the cap counts distinct paths for every task whose status is not `done` (a shared path counts for each owner, `D` entries count), and save_task rejects naming each over-limit task, its count and the limit.

Advisory only, never blocking: a task with no path refs (pure-manual), overlapping refs on shared files, and an `A`/`M` status that disagrees with git — status is display-only.

## Per-task expectedOutput drafting rules

- One entry = one assertion = one thing the task's tests prove. Split a compound sentence into separate entries instead of packing several assertions into one line.
- Write observable behavior ("returns X for Y", "rejects Z", "persists W") — never a description of test files: the entry is what the test asserts.
- Draft assertions the task can actually prove: an entry no test could assert is a contract defect, not a wording problem.
- Declare facts once, derive views: paths only in `sources`/`tests`, assertions only in `expectedOutput` — the guard, the unit payload and both test gates read those declarations and derive everything else.

## Co-location rule (atomic green commits)

**One behavior = test + implementation in the same commit — never split.**

- A verified-by-test task carries the observable outcome AND the test that verifies it (its `tests` refs name that test file). The commit lands green because test and implementation ship together.
- A task whose `expectedOutput` describes test artifacts only ("test file contains 3 cases", "tests covering edge cases") is invalid: such a commit is **red by construction** — a test without its implementation. Rewrite the `expectedOutput` as the observable behavior the test asserts.
- Tasks must be **independently green-committable**: each task's commit passes the project's pre-commit hooks on its own. No test-before-implementation splits, no scaffold-only tasks.
- Test updates never form their own behavior. When a task supersedes or removes existing tests, fold the test change into that same task and commit.

## Test classification

`save_task` returns **scan evidence**: per-path match lines with method and confidence tags (`[symbol, high]`, `[basename, low]`, `unverified`), plus advisory warnings (`undeclared-referencing`, `declared-not-found`, `no-evidence`). Classify every evidence item:

- **preserved** — the test asserts behavior the contract keeps. Do not declare it; the guard protects it automatically.
- **superseded** — the test asserts old behavior the contract changes. Declare the test path in `tests` (implementation paths go in `sources`) with `status: "M"` — or `"D"` when the contract removes it — and describe the required test update in the superseding task (folded, never its own task).
- **obsolete** — the test covers behavior the contract removes. Declare the path in `tests` with status `D`; for pure-removal contracts describe the removal in a manual task ("remove legacy path + its tests; suite green").
- **out-of-scope** — the test is already dead or broken for reasons unrelated to this contract. Report it to the user as a recommendation for a separate `/discuss`. Never fold it into this contract.

Declare every test path the contract **updates or removes** — the superseded and obsolete test files — in `tests` with its status. Undeclared test paths are protected by the staged-diff guard: deleting or skipping them halts implementation.

A collapsed `[basename, low]` fan-out line (one summary line counting many matches, e.g. `src/messages/en/research.json: 88 test files match [basename, low] — e.g. … — too generic to enumerate`) is **one item**, not 88. Treat it as generic-basename noise: the basename matched incidentally, not because the tests exercise the entry. Do not enumerate or classify the sampled paths individually; grep-verify only if the entry is plausibly affected by the contract's change.

An `unverified` confidence tag means derivation found no hit (default export, indirect reference, or no affected tests). Confirm by reading the test files or declare known paths directly in `tests`/`sources` — never assume `unverified` means "no tests affected".

## Drafting rules

1. **Index-membership manual tasks sequence before all implementation tasks.** Untrack, rename and every other `D`-entry task are index-membership work: a `D` declaration only materializes when `git rm --cached` is staged, so a D task ordered after implementation tasks trips the allowlist guard of every commit before it. List these manual tasks first in `tasks[]` so the loop runs them first.
2. **Never ship a unit-side hard block before the orchestrator capability that satisfies it.** If the contract implies an unconditional guard block, the orchestrator-side capability that satisfies it must exist in the same release — otherwise the block's message must name the manual fallback a unit can use. A block with no owner deadlocks the run.

## Rules

- Tasks that carry the business rules are testable. Scaffolding, scripts, and config are manual.
- Declare superseded and obsolete test paths in `tests`/`sources` with their status. Undeclared test paths are protected by the staged-diff guard: deleting or skipping them halts implementation.
- Set `status: "active"` for all tasks in the contract.
- Be specific. Vague `expectedOutput` cannot be tested.
- Advisory warnings never block the save, but read every one — each names a contract-quality issue you can fix before `/implement`.
