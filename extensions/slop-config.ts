// ── Slop gate configuration ──────────────────────────────────────────────────

/** Supported slop gate modes. */
export type SlopMode = "off" | "advisory" | "baseline" | "hard";

/**
 * Resolved slop gate configuration.
 *
 * Produced by {@link resolveSlopConfig}, which fills in defaults and
 * validates raw config values, so every field is present and well-typed.
 */
export interface SlopConfig {
  /** Gate behavior mode. @default "advisory" */
  mode: SlopMode;
  /** Fall back to network fetch when local detection is inconclusive. @default true */
  fetchFallback: boolean;
  /** Minimum score below which code output fails the gate. @default 80 */
  codeFailBelow: number;
  /** Minimum score below which prose output fails the gate. @default 25 */
  proseGate: number;
}

const SLOP_MODES: readonly string[] = ["off", "advisory", "baseline", "hard"];

const DEFAULT_SLOP: SlopConfig = {
  mode: "advisory",
  fetchFallback: true,
  codeFailBelow: 80,
  proseGate: 25,
};

/** Environment variable that overrides the configured mode. */
export const SLOP_MODE_ENV_VAR = "PI_SLOP_GATE";

/**
 * Type guard for valid slop modes.
 *
 * @param value - Value to check.
 * @returns True when value is one of "off", "advisory", "baseline", "hard".
 */
function isSlopMode(value: unknown): value is SlopMode {
  return typeof value === "string" && SLOP_MODES.includes(value);
}

/**
 * Type guard for finite numbers (rejects NaN, Infinity, and numerics
 * encoded as strings).
 *
 * @param value - Value to check.
 * @returns True when value is a finite number.
 */
function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

/**
 * Resolve the slop gate configuration from raw config and environment.
 *
 * Semantics:
 * - Defaults: `{ mode: "advisory", fetchFallback: true, codeFailBelow: 80, proseGate: 25 }`.
 * - `raw` is sanitized field by field: unrecognized modes and non-numeric
 *   thresholds fall back to their defaults; non-object `raw` is ignored.
 * - A partial `raw` overrides only the fields it provides.
 * - When `env.PI_SLOP_GATE` holds a valid mode it overrides the configured
 *   mode; any other env value is ignored.
 *
 * @param raw - Raw (possibly partial or malformed) slop config, e.g. from workflow.json.
 * @param env - Environment map to read `PI_SLOP_GATE` from. Defaults to empty.
 * @returns The fully resolved configuration.
 */
export function resolveSlopConfig(
  raw?: unknown,
  env: Record<string, string | undefined> = {},
): SlopConfig {
  const source: Record<string, unknown> =
    raw && typeof raw === "object" && !Array.isArray(raw)
      ? (raw as Record<string, unknown>)
      : {};

  const mode = isSlopMode(source.mode) ? source.mode : DEFAULT_SLOP.mode;
  const fetchFallback =
    typeof source.fetchFallback === "boolean"
      ? source.fetchFallback
      : DEFAULT_SLOP.fetchFallback;
  const codeFailBelow = isFiniteNumber(source.codeFailBelow)
    ? source.codeFailBelow
    : DEFAULT_SLOP.codeFailBelow;
  const proseGate = isFiniteNumber(source.proseGate)
    ? source.proseGate
    : DEFAULT_SLOP.proseGate;

  const envMode = env[SLOP_MODE_ENV_VAR];

  return {
    mode: isSlopMode(envMode) ? envMode : mode,
    fetchFallback,
    codeFailBelow,
    proseGate,
  };
}
