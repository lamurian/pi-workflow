import { describe, it } from "vitest";
import assert from "node:assert/strict";
import {
  deriveAllowlist,
  deriveOwnership,
  deriveUnitScope,
} from "../extensions/contract-derive.ts";
import type { ContractV2 } from "../extensions/state.ts";

/**
 * A representative validated ContractV2: T1 owns one source plus one test
 * (shared source with T2), T2 owns a shared source, a root-level source and
 * two test files in the same dir, T3 is manual — it owns a source but has
 * no tests refs.
 */
function v2Contract(): ContractV2 {
  return {
    title: "Derivation module",
    instruction: "shared context only",
    done: "suite green",
    sources: [
      { path: "extensions/contract-derive.ts", status: "A", tasks: ["T1"] },
      { path: "extensions/shared.ts", tasks: ["T1", "T2"] },
      { path: "main.go", tasks: ["T2"] },
      { path: "docs/manual-note.md", status: "M", tasks: ["T3"] },
    ],
    tests: [
      { path: "__tests__/contract-derive.test.ts", status: "A", tasks: ["T1"] },
      { path: "__tests__/shared.test.ts", tasks: ["T2"] },
      { path: "__tests__/shared-2.test.ts", tasks: ["T2"] },
    ],
    tasks: [
      { id: "T1", description: "derive module", expectedOutput: ["ok"], status: "active" },
      { id: "T2", description: "shared view", expectedOutput: ["ok"], status: "active" },
      { id: "T3", description: "manual note", expectedOutput: ["ok"], status: "active" },
    ],
  };
}

/**
 * Recursively freeze an object graph. A purity probe: any mutation attempt
 * inside the derived functions would throw a TypeError against a frozen input.
 *
 * @param value - The object graph to freeze.
 * @returns The same graph, deeply frozen.
 */
function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === "object") {
    for (const key of Object.getOwnPropertyNames(value)) {
      deepFreeze((value as Record<string, unknown>)[key]);
    }
    Object.freeze(value);
  }
  return value;
}

describe("deriveAllowlistIsUnion", () => {
  it("returns the union of sources and tests with path, status and refs", () => {
    const contract = v2Contract();
    const allow = deriveAllowlist(contract);
    assert.equal(allow.length, contract.sources.length + contract.tests.length);
    assert.deepEqual(allow, [
      { path: "extensions/contract-derive.ts", status: "A", refs: ["T1"] },
      { path: "extensions/shared.ts", refs: ["T1", "T2"] },
      { path: "main.go", refs: ["T2"] },
      { path: "docs/manual-note.md", status: "M", refs: ["T3"] },
      { path: "__tests__/contract-derive.test.ts", status: "A", refs: ["T1"] },
      { path: "__tests__/shared.test.ts", refs: ["T2"] },
      { path: "__tests__/shared-2.test.ts", refs: ["T2"] },
    ]);
  });

  it("is pure: a frozen contract is never mutated and outputs never alias it", () => {
    const contract = deepFreeze(v2Contract());
    const first = deriveAllowlist(contract);
    first.push({ path: "evil.ts", refs: ["T1"] });
    first[0]!.refs.push("T9");
    const second = deriveAllowlist(contract);
    assert.notEqual(second[0], first[0]);
    assert.equal(second.length, contract.sources.length + contract.tests.length);
    assert.deepEqual(second[0]!.refs, ["T1"]);
    assert.deepEqual(second.at(-1)!.path, "__tests__/shared-2.test.ts");
  });
});

describe("deriveUnitScopeFiltersByTaskRef", () => {
  it("keeps only entries whose tasks include the task id", () => {
    const contract = v2Contract();
    const scope = deriveUnitScope(contract, "T2");
    assert.deepEqual(
      scope.sources.map((e) => e.path),
      ["extensions/shared.ts", "main.go"],
    );
    assert.deepEqual(
      scope.tests.map((e) => e.path),
      ["__tests__/shared.test.ts", "__tests__/shared-2.test.ts"],
    );
    // Entries keep their full task refs — the scope is a filter view.
    assert.deepEqual(scope.sources[0]!.tasks, ["T1", "T2"]);
    // A task id declared nowhere yields an empty scope.
    assert.deepEqual(deriveUnitScope(contract, "T9"), {
      sources: [],
      tests: [],
      testFiles: [],
      packages: [],
    });
  });

  it("derives testFiles as the owned non-D test paths", () => {
    const contract = v2Contract();
    contract.tests.push({ path: "__tests__/gone.test.ts", status: "D", tasks: ["T1"] });
    const scope = deriveUnitScope(contract, "T1");
    assert.deepEqual(
      scope.testFiles,
      ["__tests__/contract-derive.test.ts"],
      "D-status test paths are excluded from testFiles",
    );
    assert.deepEqual(
      deriveUnitScope(contract, "T2").testFiles,
      ["__tests__/shared.test.ts", "__tests__/shared-2.test.ts"],
      "testFiles lists the owned test paths in contract order",
    );
  });

  it("derives packages as the unique dirs of the owned test paths", () => {
    // Both T2 test files live in __tests__ → one unique package dir.
    assert.deepEqual(deriveUnitScope(v2Contract(), "T2").packages, ["__tests__"]);
  });

  it("yields empty packages for a task with no tests refs", () => {
    const scope = deriveUnitScope(v2Contract(), "T3");
    // T3 owns a source (docs/manual-note.md) but has no tests refs:
    // empty packages ⇒ no test gate (manual-ness is derived).
    assert.deepEqual(
      scope.sources.map((e) => e.path),
      ["docs/manual-note.md"],
    );
    assert.deepEqual(scope.tests, []);
    assert.deepEqual(scope.packages, []);
  });

  it("is pure: a frozen contract is never mutated and outputs never alias it", () => {
    const contract = deepFreeze(v2Contract());
    const first = deriveUnitScope(contract, "T2");
    first.sources.push({ path: "evil.ts", tasks: ["T2"] });
    first.tests[0]!.tasks.push("T9");
    first.testFiles.push("evil.test.ts");
    first.packages.push("evil-dir");
    const second = deriveUnitScope(contract, "T2");
    assert.equal(second.sources.length, 2);
    assert.equal(second.tests.length, 2);
    assert.deepEqual(second.tests[0]!.tasks, ["T2"]);
    assert.deepEqual(second.testFiles, [
      "__tests__/shared.test.ts",
      "__tests__/shared-2.test.ts",
    ]);
    assert.deepEqual(second.packages, ["__tests__"]);
  });
});

describe("deriveOwnershipMapsRefs", () => {
  it("maps each path to its owning task ids", () => {
    const ownership = deriveOwnership(v2Contract());
    assert.ok(ownership instanceof Map);
    assert.equal(ownership.size, 7);
    assert.deepEqual(ownership.get("extensions/contract-derive.ts"), ["T1"]);
    assert.deepEqual(ownership.get("extensions/shared.ts"), ["T1", "T2"]);
    assert.deepEqual(ownership.get("main.go"), ["T2"]);
    assert.deepEqual(ownership.get("docs/manual-note.md"), ["T3"]);
    assert.deepEqual(ownership.get("__tests__/shared.test.ts"), ["T2"]);
  });

  it("is pure: a frozen contract is never mutated and outputs never alias it", () => {
    const contract = deepFreeze(v2Contract());
    const first = deriveOwnership(contract);
    first.get("extensions/shared.ts")!.push("T9");
    first.set("evil.ts", ["T1"]);
    const second = deriveOwnership(contract);
    assert.equal(second.size, 7);
    assert.deepEqual(second.get("extensions/shared.ts"), ["T1", "T2"]);
    assert.equal(second.has("evil.ts"), false);
  });
});
