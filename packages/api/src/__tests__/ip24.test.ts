/**
 * IP24 (interrupt precision within 24h) report builder: per-user counts in, the
 * pooled rate, the per-user median, the per-user distribution (no ids), the
 * Gmail baseline and the misses-per-100-rings guardrail out. Pure; the SQL is
 * proven against a real Postgres in ip24-pg.test.ts.
 */

import { describe, expect, it } from "vitest";
import { buildIp24Report, type Ip24UserRow, renderIp24Report } from "../judge/ip24.js";

const META = {
  since: new Date("2026-11-12T00:00:00Z"),
  until: new Date("2026-11-19T00:00:00Z"),
  matureBefore: new Date("2026-11-18T00:00:00Z"),
};

function row(over: Partial<Ip24UserRow> = {}): Ip24UserRow {
  return {
    klornRings: 0,
    klornHits: 0,
    klornOpened: 0,
    klornMisses: 0,
    gmailRings: 0,
    gmailHits: 0,
    gmailOpened: 0,
    gmailMisses: 0,
    otherLaneRings: 0,
    nonGmailRings: 0,
    offAppDelivery: false,
    ...over,
  };
}

describe("buildIp24Report — Klorn side", () => {
  const rows = [
    row({ klornRings: 3, klornHits: 2, klornOpened: 3, klornMisses: 1, offAppDelivery: true }),
    row({ klornRings: 1, klornHits: 0, klornOpened: 0 }),
    // A user with no matured ring is not in the per-user distribution.
    row({ klornMisses: 1 }),
  ];
  const report = buildIp24Report(rows, META);

  it("pools rings and hits across users, with N", () => {
    expect(report.klorn.rings).toBe(4);
    expect(report.klorn.hits).toBe(2);
    expect(report.klorn.ip24).toBe(0.5);
  });

  it("takes the median over users with at least one matured ring", () => {
    expect(report.klorn.users).toBe(2);
    expect(report.klorn.medianIp24).toBeCloseTo((2 / 3 + 0) / 2);
  });

  it("lists the per-user distribution without ids, best first", () => {
    expect(report.klorn.perUser).toEqual([
      { ip24: 2 / 3, n: 3, offAppDelivery: true },
      { ip24: 0, n: 1, offAppDelivery: false },
    ]);
    expect(JSON.stringify(report)).not.toMatch(/userId|"id"/);
  });

  it("reports opened apart and never counts it as precision", () => {
    expect(report.klorn.opened).toBe(3);
    expect(report.klorn.openedShare).toBe(0.75);
    expect(report.klorn.ip24).toBe(0.5);
  });

  it("guardrail: misses per 100 rings, over every user's misses", () => {
    expect(report.klorn.misses).toBe(2);
    expect(report.klorn.missesPer100Rings).toBe(50);
  });

  it("splits out the users an off-app channel took a push for", () => {
    expect(report.klorn.offApp).toEqual({
      users: 1,
      rings: 3,
      hits: 2,
      ip24: 2 / 3,
      medianIp24: 2 / 3,
    });
  });
});

describe("buildIp24Report — Gmail baseline", () => {
  it("applies the same formula to the Gmail-IMPORTANT counts", () => {
    const report = buildIp24Report(
      [
        row({ gmailRings: 4, gmailHits: 1, gmailOpened: 2, gmailMisses: 2 }),
        row({ gmailRings: 1, gmailHits: 1 }),
        row({ gmailRings: 5, gmailHits: 1 }),
      ],
      META,
    );

    expect(report.gmail.rings).toBe(10);
    expect(report.gmail.ip24).toBeCloseTo(0.3);
    expect(report.gmail.users).toBe(3);
    // Odd count: the middle value of [1, 0.25, 0.2].
    expect(report.gmail.medianIp24).toBe(0.25);
    expect(report.gmail.openedShare).toBeCloseTo(0.2);
    expect(report.gmail.missesPer100Rings).toBeCloseTo(20);
  });
});

describe("buildIp24Report — empty and excluded", () => {
  it("never shows a fake 0%: rates are null when N is 0", () => {
    const report = buildIp24Report([row({ klornMisses: 3 })], META);

    expect(report.klorn.rings).toBe(0);
    expect(report.klorn.ip24).toBeNull();
    expect(report.klorn.medianIp24).toBeNull();
    expect(report.klorn.openedShare).toBeNull();
    expect(report.klorn.missesPer100Rings).toBeNull();
    expect(report.klorn.offApp).toEqual({
      users: 0,
      rings: 0,
      hits: 0,
      ip24: null,
      medianIp24: null,
    });
    expect(report.gmail.ip24).toBeNull();
  });

  it("sums what is outside the comparison", () => {
    const report = buildIp24Report(
      [row({ otherLaneRings: 1, nonGmailRings: 2 }), row({ nonGmailRings: 1 })],
      META,
    );
    expect(report.notCompared).toEqual({ otherLaneRings: 1, nonGmailRings: 3 });
  });
});

describe("renderIp24Report", () => {
  it("prints N, the pooled rate, the median and the guardrail for both sides", () => {
    const text = renderIp24Report(
      buildIp24Report(
        [
          row({ klornRings: 4, klornHits: 3, gmailRings: 10, gmailHits: 2, gmailMisses: 1 }),
          row({ klornRings: 2, klornHits: 1, klornMisses: 1, offAppDelivery: true }),
        ],
        META,
      ),
    );

    expect(text).toContain("IP24");
    expect(text).toMatch(/Klorn rings[^\n]*N=6/);
    expect(text).toMatch(/Gmail IMPORTANT[^\n]*N=10/);
    expect(text).toContain("66.7% (4/6)");
    expect(text).toContain("median 62.5% over 2 users");
    expect(text).toContain("16.7 per 100 rings (1)");
    expect(text).toContain("75.0% (n=4) off-app: no");
  });

  it("prints a dash, not 0%, when there is nothing to measure", () => {
    const text = renderIp24Report(buildIp24Report([], META));
    expect(text).toMatch(/Klorn rings[^\n]*N=0/);
    expect(text).toContain("— (0/0)");
  });
});
