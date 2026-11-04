import { describe, it } from "vitest";
import assert from "node:assert/strict";
import {
  resolveSlopConfig,
  type SlopConfig,
} from "../extensions/slop-config.ts";

describe("resolveSlopConfig", () => {
  // ── defaults ────────────────────────────────────────────

  it("returns defaults for undefined raw and empty env", () => {
    assert.deepEqual(resolveSlopConfig(undefined, {}), {
      mode: "advisory",
      fetchFallback: true,
      codeFailBelow: 80,
      proseGate: 25,
    } satisfies SlopConfig);
  });

  // ── valid modes ─────────────────────────────────────────

  it("accepts each of off, advisory, baseline, hard as mode", () => {
    for (const mode of ["off", "advisory", "baseline", "hard"] as const) {
      const cfg = resolveSlopConfig({ mode }, {});
      assert.equal(cfg.mode, mode);
    }
  });

  it("falls back to advisory for an unrecognized mode", () => {
    assert.equal(resolveSlopConfig({ mode: "aggressive" }, {}).mode, "advisory");
    assert.equal(resolveSlopConfig({ mode: 42 }, {}).mode, "advisory");
    assert.equal(resolveSlopConfig({ mode: null }, {}).mode, "advisory");
  });

  // ── numeric thresholds ──────────────────────────────────

  it("falls back to 80 / 25 for non-numeric thresholds", () => {
    const cfg = resolveSlopConfig(
      { codeFailBelow: "high", proseGate: null },
      {},
    );
    assert.equal(cfg.codeFailBelow, 80);
    assert.equal(cfg.proseGate, 25);
  });

  it("accepts numeric thresholds", () => {
    const cfg = resolveSlopConfig(
      { codeFailBelow: 70, proseGate: 30 },
      {},
    );
    assert.equal(cfg.codeFailBelow, 70);
    assert.equal(cfg.proseGate, 30);
  });

  // ── partial overrides ───────────────────────────────────

  it("a partial object overrides only the fields it provides", () => {
    assert.deepEqual(resolveSlopConfig({ mode: "hard" }, {}), {
      mode: "hard",
      fetchFallback: true,
      codeFailBelow: 80,
      proseGate: 25,
    } satisfies SlopConfig);

    assert.deepEqual(resolveSlopConfig({ fetchFallback: false, proseGate: 40 }, {}), {
      mode: "advisory",
      fetchFallback: false,
      codeFailBelow: 80,
      proseGate: 40,
    } satisfies SlopConfig);
  });

  it("ignores non-object raw values", () => {
    assert.deepEqual(resolveSlopConfig("nonsense", {}), {
      mode: "advisory",
      fetchFallback: true,
      codeFailBelow: 80,
      proseGate: 25,
    } satisfies SlopConfig);
    assert.deepEqual(resolveSlopConfig(null, {}), {
      mode: "advisory",
      fetchFallback: true,
      codeFailBelow: 80,
      proseGate: 25,
    } satisfies SlopConfig);
  });

  // ── env override ────────────────────────────────────────

  it("env PI_SLOP_GATE with a valid mode overrides the configured mode", () => {
    assert.equal(
      resolveSlopConfig({ mode: "baseline" }, { PI_SLOP_GATE: "hard" }).mode,
      "hard",
    );
    assert.equal(
      resolveSlopConfig(undefined, { PI_SLOP_GATE: "off" }).mode,
      "off",
    );
  });

  it("an invalid PI_SLOP_GATE value is ignored and the configured mode stands", () => {
    assert.equal(
      resolveSlopConfig({ mode: "baseline" }, { PI_SLOP_GATE: "sideways" }).mode,
      "baseline",
    );
    assert.equal(
      resolveSlopConfig(undefined, { PI_SLOP_GATE: "" }).mode,
      "advisory",
    );
  });

  it("env override changes only the mode, not the other fields", () => {
    const cfg = resolveSlopConfig(
      { mode: "baseline", proseGate: 35 },
      { PI_SLOP_GATE: "hard" },
    );
    assert.deepEqual(cfg, {
      mode: "hard",
      fetchFallback: true,
      codeFailBelow: 80,
      proseGate: 35,
    } satisfies SlopConfig);
  });
});
