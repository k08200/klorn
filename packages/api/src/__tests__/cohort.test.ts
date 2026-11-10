/**
 * Cohort + PMF — knowing who is in the 100 before pricing them.
 *
 * Two questions have to be answerable before the pricing decision in the
 * launch plan can be made on anything but instinct: *who actually showed up*
 * and *would they be disappointed to lose this*. Neither is answerable today.
 *
 * Prisma is mocked at the db.js boundary (repo convention); no real DB.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const userFindMany = vi.hoisted(() => vi.fn());
const userFindUnique = vi.hoisted(() => vi.fn());
const pmfFindUnique = vi.hoisted(() => vi.fn());
const pmfUpsert = vi.hoisted(() => vi.fn());
const pmfGroupBy = vi.hoisted(() => vi.fn());
const pmfFindMany = vi.hoisted(() => vi.fn());
const labelCount = vi.hoisted(() => vi.fn());
const emailGroupBy = vi.hoisted(() => vi.fn());

vi.mock("../db.js", () => ({
  prisma: {
    user: { findMany: userFindMany, findUnique: userFindUnique },
    pmfResponse: {
      findUnique: pmfFindUnique,
      upsert: pmfUpsert,
      groupBy: pmfGroupBy,
      findMany: pmfFindMany,
    },
    decisionLabel: { count: labelCount },
    emailMessage: { groupBy: emailGroupBy },
  },
  db: {},
}));
vi.mock("../sentry.js", () => ({ captureError: vi.fn() }));

import {
  cohortReadout,
  isPmfEligible,
  isPmfProbeEnabled,
  pmfSummary,
  recordPmfResponse,
} from "../product/cohort.js";

const NOW = new Date("2026-08-24T00:00:00Z");
const OLD = new Date("2026-08-01T00:00:00Z"); // 23 days — well past the tenure bar
const NEW = new Date("2026-08-22T00:00:00Z"); // 2 days

beforeEach(() => {
  vi.clearAllMocks();
  process.env.PMF_PROBE_ENABLED = "true";
  userFindUnique.mockResolvedValue({ createdAt: OLD });
  pmfFindUnique.mockResolvedValue(null);
  labelCount.mockResolvedValue(50);
  pmfUpsert.mockResolvedValue({});
  pmfGroupBy.mockResolvedValue([]);
  pmfFindMany.mockResolvedValue([]);
  userFindMany.mockResolvedValue([]);
  emailGroupBy.mockResolvedValue([]);
});

describe("isPmfProbeEnabled", () => {
  it("is off unless the flag is exactly 'true'", () => {
    delete process.env.PMF_PROBE_ENABLED;
    expect(isPmfProbeEnabled()).toBe(false);
    process.env.PMF_PROBE_ENABLED = "True";
    expect(isPmfProbeEnabled()).toBe(false);
    process.env.PMF_PROBE_ENABLED = "true";
    expect(isPmfProbeEnabled()).toBe(true);
  });
});

describe("isPmfEligible", () => {
  it("never asks when the flag is off", async () => {
    delete process.env.PMF_PROBE_ENABLED;
    await expect(isPmfEligible("u1", NOW)).resolves.toBe(false);
    expect(userFindUnique).not.toHaveBeenCalled();
  });

  it("does not ask someone who only signed up two days ago", async () => {
    userFindUnique.mockResolvedValue({ createdAt: NEW });
    await expect(isPmfEligible("u1", NOW)).resolves.toBe(false);
  });

  it("does not ask someone the product has never actually judged mail for", async () => {
    labelCount.mockResolvedValue(0);
    await expect(isPmfEligible("u1", NOW)).resolves.toBe(false);
  });

  it("does not ask twice", async () => {
    pmfFindUnique.mockResolvedValue({ answer: "VERY" });
    await expect(isPmfEligible("u1", NOW)).resolves.toBe(false);
  });

  it("asks a user with real tenure and real usage", async () => {
    await expect(isPmfEligible("u1", NOW)).resolves.toBe(true);
  });

  it("fails closed — an error means do not interrupt the user", async () => {
    userFindUnique.mockRejectedValue(new Error("db down"));
    await expect(isPmfEligible("u1", NOW)).resolves.toBe(false);
  });
});

describe("recordPmfResponse", () => {
  it("stores one answer per user, overwriting a change of mind", async () => {
    await recordPmfResponse("u1", "VERY");
    expect(pmfUpsert).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { userId: "u1" },
        create: expect.objectContaining({ userId: "u1", answer: "VERY" }),
        update: expect.objectContaining({ answer: "VERY" }),
      }),
    );
  });

  it("rejects an answer outside the three options", async () => {
    await expect(recordPmfResponse("u1", "MAYBE" as never)).rejects.toThrow(/answer/i);
    expect(pmfUpsert).not.toHaveBeenCalled();
  });
});

describe("pmfSummary", () => {
  it("reports zero without dividing by it", async () => {
    pmfGroupBy.mockResolvedValue([]);
    const s = await pmfSummary();
    expect(s).toMatchObject({ responses: 0, very: 0, veryPct: 0, gateMet: false });
  });

  it("computes the very-disappointed share", async () => {
    pmfGroupBy.mockResolvedValue([
      { answer: "VERY", _count: { _all: 20 } },
      { answer: "SOMEWHAT", _count: { _all: 20 } },
      { answer: "NOT", _count: { _all: 10 } },
    ]);
    const s = await pmfSummary();
    expect(s.responses).toBe(50);
    expect(s.very).toBe(20);
    expect(s.veryPct).toBe(40);
  });

  it("does not call the gate met on a sample too small to mean anything", async () => {
    // 2 of 3 is 67%, which clears 40% and means nothing at all.
    pmfGroupBy.mockResolvedValue([
      { answer: "VERY", _count: { _all: 2 } },
      { answer: "NOT", _count: { _all: 1 } },
    ]);
    const s = await pmfSummary();
    expect(s.veryPct).toBe(67);
    expect(s.gateMet).toBe(false);
    expect(s.belowMinimumSample).toBe(true);
  });

  it("calls the gate met only when both the share and the sample hold", async () => {
    pmfGroupBy.mockResolvedValue([
      { answer: "VERY", _count: { _all: 18 } },
      { answer: "SOMEWHAT", _count: { _all: 22 } },
    ]);
    const s = await pmfSummary();
    expect(s.responses).toBe(40);
    expect(s.veryPct).toBe(45);
    expect(s.gateMet).toBe(true);
  });
});

describe("cohortReadout", () => {
  beforeEach(() => {
    userFindMany.mockResolvedValue([
      { id: "u1", email: "a@example.com", createdAt: OLD, plan: "FREE", attribution: "hn" },
      { id: "u2", email: "b@example.com", createdAt: NEW, plan: "PRO", attribution: null },
    ]);
    emailGroupBy.mockResolvedValue([
      { userId: "u1", _count: { _all: 900 } },
      { userId: "u2", _count: { _all: 30 } },
    ]);
    pmfFindMany.mockResolvedValue([{ userId: "u1", answer: "VERY" }]);
  });

  it("ranks by mail volume — the ICP hypothesis is about how much mail they get", async () => {
    const rows = await cohortReadout(NOW);
    expect(rows.map((r) => r.userId)).toEqual(["u1", "u2"]);
    expect(rows[0].mailVolume30d).toBe(900);
  });

  it("carries tenure, attribution and the PMF answer so one table answers 'who came'", async () => {
    const rows = await cohortReadout(NOW);
    expect(rows[0]).toMatchObject({
      tenureDays: 23,
      attribution: "hn",
      pmf: "VERY",
      plan: "FREE",
    });
  });

  it("shows a user with no mail as zero rather than dropping them", async () => {
    emailGroupBy.mockResolvedValue([{ userId: "u1", _count: { _all: 900 } }]);
    const rows = await cohortReadout(NOW);
    expect(rows).toHaveLength(2);
    expect(rows[1]).toMatchObject({ userId: "u2", mailVolume30d: 0, pmf: null });
  });

  it("fails open to an empty list rather than throwing at an admin screen", async () => {
    userFindMany.mockRejectedValue(new Error("db down"));
    await expect(cohortReadout(NOW)).resolves.toEqual([]);
  });
});
