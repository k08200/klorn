/**
 * The scheduler's Google pre-filter counts only tokens that can still be used
 * (2026-10-24). A token row with no refresh token whose access token has
 * expired is dead: getAuthedClient returns null and logs "needs reconnect".
 * Counting such rows as connected made six dormant accounts attempt a Gmail and
 * Calendar sync — and log that line — on every one-minute tick, forever.
 */

import { describe, expect, it } from "vitest";
import { usableGoogleTokenWhere } from "../automation-scheduler.js";

const NOW = new Date("2026-10-24T05:00:00Z");

/** The filter as a predicate, evaluated the way Postgres would. */
function matches(
  where: ReturnType<typeof usableGoogleTokenWhere>,
  row: { userId: string; provider: string; refreshToken: string | null; expiresAt: Date | null },
): boolean {
  if (!where.userId.in.includes(row.userId) || row.provider !== where.provider) return false;
  return where.OR.some((clause) =>
    "refreshToken" in clause
      ? row.refreshToken !== null
      : row.expiresAt !== null && row.expiresAt > clause.expiresAt.gt,
  );
}

describe("usableGoogleTokenWhere", () => {
  const where = usableGoogleTokenWhere(["u1"], NOW);
  const row = (refreshToken: string | null, expiresAt: Date | null) => ({
    userId: "u1",
    provider: "google",
    refreshToken,
    expiresAt,
  });

  it("a token with a refresh token is usable, expired access token or not", () => {
    expect(matches(where, row("enc-refresh", new Date("2026-10-01T00:00:00Z")))).toBe(true);
    expect(matches(where, row("enc-refresh", null))).toBe(true);
  });

  it("without a refresh token, only an access token that has not expired is usable", () => {
    expect(matches(where, row(null, new Date("2026-10-24T06:00:00Z")))).toBe(true);
    expect(matches(where, row(null, new Date("2026-10-24T04:00:00Z")))).toBe(false);
    expect(matches(where, row(null, null))).toBe(false);
  });

  it("is scoped to the batch's users and to Google", () => {
    expect(where.userId).toEqual({ in: ["u1"] });
    expect(where.provider).toBe("google");
  });
});
