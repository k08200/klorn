import { describe, expect, it } from "vitest";
import { foldRetention, isAnalyticsEvent } from "../analytics.js";

const DAY = 24 * 60 * 60 * 1000;
const NOW = Date.UTC(2026, 6, 21, 12, 0, 0); // fixed clock
const daysAgo = (n: number) => new Date(NOW - n * DAY);

describe("isAnalyticsEvent", () => {
  it("accepts allowlisted names and rejects everything else", () => {
    expect(isAnalyticsEvent("app_open")).toBe(true);
    expect(isAnalyticsEvent("queue_action")).toBe(true);
    expect(isAnalyticsEvent("notif_muted")).toBe(true);
    expect(isAnalyticsEvent("push_opened")).toBe(true);
    expect(isAnalyticsEvent("push_sent")).toBe(true);
    expect(isAnalyticsEvent("drop_table")).toBe(false);
    expect(isAnalyticsEvent("")).toBe(false);
    expect(isAnalyticsEvent(42)).toBe(false);
    expect(isAnalyticsEvent(null)).toBe(false);
  });
});

describe("foldRetention", () => {
  // A: old, came back on day 8 (retained D1 + D7, not D14).
  // B: old, only opened on signup day (retained nothing).
  // C: 3 days old, opened today (D1 eligible+retained; too young for D7/D14).
  const users = [
    { id: "A", createdAt: daysAgo(20) },
    { id: "B", createdAt: daysAgo(20) },
    { id: "C", createdAt: daysAgo(3) },
  ];
  const opens = [
    { userId: "A", createdAt: daysAgo(20) }, // day 0
    { userId: "A", createdAt: daysAgo(12) }, // day 8 after signup
    { userId: "B", createdAt: daysAgo(20) }, // day 0 only
    { userId: "C", createdAt: daysAgo(0) }, // today (day 3 after signup)
  ];

  const m = foldRetention({
    now: NOW,
    users,
    opens,
    totals: { app_open: 4, push_sent: 10, push_opened: 4, queue_action: 14 },
    queueActions7d: 14,
    mutedUserCount: 1,
  });

  it("counts DAU/WAU/MAU from app_opens in-window", () => {
    expect(m.active.dau).toBe(1); // only C opened today
    expect(m.active.wau).toBe(1); // A's last open was 12d ago, B 20d ago; only C in 7d
    expect(m.active.mau).toBe(3); // all three opened within 30d
  });

  it("computes D1/D7/D14 cohort retention with age gating", () => {
    // D1 denom = all 3 (all ≥1d old); returned-after-day1: A(day8), C(day3) → 2/3
    expect(m.retention.d1).toBeCloseTo(2 / 3, 5);
    // D7 denom = A,B (≥7d old); C excluded (too young). Returned-after-day7: A only → 1/2
    expect(m.retention.d7).toBeCloseTo(0.5, 5);
    // D14 denom = A,B; neither opened ≥14d after signup → 0/2
    expect(m.retention.d14).toBe(0);
  });

  it("computes engagement metrics", () => {
    expect(m.engagement.queueActionsPerDay7d).toBe(2); // 14/7
    expect(m.engagement.pushOpenRate).toBeCloseTo(0.4, 5); // 4/10
    expect(m.engagement.muteRate).toBeCloseTo(1 / 3, 5); // 1 of 3 users
  });

  it("returns null retention when no cohort is old enough", () => {
    const young = foldRetention({
      now: NOW,
      users: [{ id: "X", createdAt: daysAgo(0) }],
      opens: [],
      totals: {},
      queueActions7d: 0,
      mutedUserCount: 0,
    });
    expect(young.retention.d7).toBeNull();
    expect(young.engagement.pushOpenRate).toBeNull(); // no pushes sent
    expect(young.engagement.muteRate).toBe(0);
  });
});
