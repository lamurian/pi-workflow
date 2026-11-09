// Type-only: the v1 TaskContract shape and the normalized contract v2
// (tasks/sources/tests), split out of state.ts and re-exported from there.

/** Lifecycle of one behavior in the task contract. */
export type BehaviorStatus = "active" | "removed" | "done";

/** Whether a behavior is verified by a test or by manual verification. */
export type BehaviorKind = "test" | "manual";

/** One testable behavior in the task contract. */
export interface Behavior {
  /** Stable behavior id, e.g. "T1". */
  id: string;
  /** The behavior under test. */
  description: string;
  /** The expected output when the behavior is implemented. */
  expectedOutput: string;
  /** test (TDD) or manual (definition-of-done verification). */
  kind: BehaviorKind;
  /** Lifecycle status. */
  status: BehaviorStatus;
  /** File that surfaces this behavior. */
  sourceFile?: string;
}

/** Status of a declared file in the contract's authoritative allowlist. */
export type FileStatus = "A" | "M" | "D";

/** One declared file in the contract's authoritative allowlist. */
export interface FileEntry {
  /** Repo-relative path. */
  path: string;
  /** A = added, M = modified, D = deleted. */
  status: FileStatus;
}

/** The atomic implementation contract produced by /finalize. */
export interface TaskContract {
  /** Short task title. */
  title: string;
  /** What to implement. */
  instruction: string;
  /** Authoritative file allowlist: every file the task adds, modifies or deletes. */
  files: FileEntry[];
  /** Definition of done. */
  done: string;
  /** Behaviors covered by the task. */
  behaviors: Behavior[];
}

/** One declared path in a v2 contract list (sources or tests). */
export interface PathEntry {
  /** Repo-relative path. */
  path: string;
  /**
   * Per-path FACT (optional): absent = write-authorized (A/M is a derived
   * display qualifier, never enforced); D = delete authority, granted only
   * to the tasks in its `tasks` refs.
   */
  status?: FileStatus;
  /** Task ids that own this path (shared files name several). */
  tasks: string[];
}

/** Lifecycle status of a v2 task unit. */
export type TaskStatus = "active" | "done" | "removed";

/** One task unit in the v2 contract. */
export interface TaskUnit {
  /** Stable task id, e.g. "T1". */
  id: string;
  /** What the task implements. */
  description: string;
  /** One entry per assertion the task's tests must prove. */
  expectedOutput: string[];
  /** Lifecycle status. */
  status: TaskStatus;
  /** Command names the task needs; each must be declared in implement.commands. */
  commands?: string[];
  /**
   * Optional commit message for the task, in conventional
   * `type(scope): description` form, single line, <=75 chars, unique per
   * non-removed task, and never containing a declared task id.
   */
  commit?: string;
}

/** The normalized v2 contract: the path lists are the single source of truth. */
export interface ContractV2 {
  /** Short task title. */
  title: string;
  /** Shared context only — never file lists. */
  instruction: string;
  /** Aggregate definition of done. */
  done: string;
  /** Implementation files. */
  sources: PathEntry[];
  /** Test/fixture files. */
  tests: PathEntry[];
  /** Task units. */
  tasks: TaskUnit[];
}
