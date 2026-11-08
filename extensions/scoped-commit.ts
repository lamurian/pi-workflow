// Shared single-path commit mechanics. The implementation lives in
// test-extension-chore.ts so git commit keeps a single call site there.

export { commitScopedPath } from "./test-extension-chore.ts";
export type { ScopedCommitResult } from "./test-extension-chore.ts";
