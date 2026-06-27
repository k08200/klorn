/**
 * Shape-validation primitives for parsed LLM JSON.
 *
 * `parseLlmJson` strips markdown fences but does NOT validate the parsed
 * object's shape. A model — especially a `:free` fallback — can return a wrong
 * enum ("urgent" for a 3-value priority), a stringified or out-of-range number,
 * or a non-array where an array is required. Left unchecked, `parsed.x ?? def`
 * only fills *missing* fields: a present-but-invalid value flows straight
 * through as if it were valid and silently misclassifies (the worst kind —
 * `CLAMP(Number("high"))` became `NaN` and propagated into the tier math).
 *
 * These keep each value inside its declared contract. They never throw; an
 * out-of-contract value collapses to the caller's fallback.
 */

/** Return `value` when it is one of `allowed`, else `fallback`. */
export function asEnum<T extends string>(value: unknown, allowed: readonly T[], fallback: T): T {
  return typeof value === "string" && (allowed as readonly string[]).includes(value)
    ? (value as T)
    : fallback;
}

/**
 * Coerce to a finite number in `[min, max]`. A numeric string ("0.8") is
 * accepted; `NaN` / `Infinity` / non-numeric collapses to `fallback`. An
 * in-range fallback is returned as-is; an out-of-range value is clamped.
 */
export function asBoundedNumber(
  value: unknown,
  min: number,
  max: number,
  fallback: number,
): number {
  const n =
    typeof value === "number" ? value : typeof value === "string" ? Number(value) : Number.NaN;
  if (!Number.isFinite(n)) return fallback;
  return n < min ? min : n > max ? max : n;
}

/** A finite number clamped to `[0, 1]`; non-finite collapses to `fallback`. */
export function asUnitInterval(value: unknown, fallback = 0): number {
  return asBoundedNumber(value, 0, 1, fallback);
}

/** Keep only the string members of an array; non-arrays become `[]`. */
export function asStringArray(value: unknown, max = Number.POSITIVE_INFINITY): string[] {
  if (!Array.isArray(value)) return [];
  const out = value.filter((v): v is string => typeof v === "string");
  return Number.isFinite(max) ? out.slice(0, max) : out;
}

/** A string, or `fallback` for anything else. */
export function asString(value: unknown, fallback = ""): string {
  return typeof value === "string" ? value : fallback;
}

/**
 * True when `value` is present (not null/undefined) but is NOT a finite number
 * (nor a numeric string) — i.e. a value `asBoundedNumber` had to reject. Lets a
 * caller distinguish "model omitted the field" (fine) from "model returned a
 * garbage number" (a model anomaly worth a trace).
 */
export function isNonFinitePresent(value: unknown): boolean {
  if (value === undefined || value === null) return false;
  const n =
    typeof value === "number" ? value : typeof value === "string" ? Number(value) : Number.NaN;
  return !Number.isFinite(n);
}
