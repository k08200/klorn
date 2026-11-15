/**
 * orgCompanyDomainsFor: the one read the judge makes of a member's
 * organization. Closed (no query) unless TEAMS_ENABLED reaches the user; open,
 * it reads the member's own organization's companyDomains and nothing else —
 * no roster, no other member, no org name.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const m = vi.hoisted(() => ({
  findUnique: vi.fn(),
}));

vi.mock("../db.js", () => ({
  prisma: { orgMembership: { findUnique: m.findUnique } },
  db: { orgMembership: { findUnique: m.findUnique } },
}));

import { loadRelationshipSnapshot } from "../judge/v3/relationship-loader.js";
import { orgCompanyDomainsFor } from "../org/org-domains.js";

const ENV = ["TEAMS_ENABLED", "ROLLOUT_COHORT_USER_IDS"] as const;
const saved: Record<string, string | undefined> = {};

beforeEach(() => {
  for (const k of ENV) saved[k] = process.env[k];
  m.findUnique.mockReset();
});

afterEach(() => {
  for (const k of ENV) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
});

describe("orgCompanyDomainsFor", () => {
  it("flag off: no query at all, no domains", async () => {
    delete process.env.TEAMS_ENABLED;
    expect(await orgCompanyDomainsFor("u1")).toEqual([]);
    process.env.TEAMS_ENABLED = "false";
    expect(await orgCompanyDomainsFor("u1")).toEqual([]);
    expect(m.findUnique).not.toHaveBeenCalled();
  });

  it("cohort: no query for a user outside the cohort", async () => {
    process.env.TEAMS_ENABLED = "cohort";
    process.env.ROLLOUT_COHORT_USER_IDS = "someone-else";
    expect(await orgCompanyDomainsFor("u1")).toEqual([]);
    expect(m.findUnique).not.toHaveBeenCalled();
  });

  it("open: reads only the member's own organization's companyDomains", async () => {
    process.env.TEAMS_ENABLED = "cohort";
    process.env.ROLLOUT_COHORT_USER_IDS = "u1";
    m.findUnique.mockResolvedValue({ org: { companyDomains: ["acme.com", "acme.io"] } });
    expect(await orgCompanyDomainsFor("u1")).toEqual(["acme.com", "acme.io"]);
    expect(m.findUnique).toHaveBeenCalledTimes(1);
    expect(m.findUnique).toHaveBeenCalledWith({
      where: { userId: "u1" },
      select: { org: { select: { companyDomains: true } } },
    });
  });

  it("open: no membership, or an organization without domains, is no domains", async () => {
    process.env.TEAMS_ENABLED = "true";
    m.findUnique.mockResolvedValueOnce(null);
    expect(await orgCompanyDomainsFor("u1")).toEqual([]);
    m.findUnique.mockResolvedValueOnce({ org: { companyDomains: [] } });
    expect(await orgCompanyDomainsFor("u1")).toEqual([]);
  });

  it("drops anything that is not a lowercase domain string (defensive: the column is admin input)", async () => {
    process.env.TEAMS_ENABLED = "true";
    m.findUnique.mockResolvedValue({
      org: { companyDomains: ["ACME.com", " acme.io ", "", "not a domain", 7, "acme.com"] },
    });
    expect(await orgCompanyDomainsFor("u1")).toEqual(["acme.com", "acme.io"]);
  });

  it("a failed read propagates (the relationship loader turns it into no fact)", async () => {
    process.env.TEAMS_ENABLED = "true";
    m.findUnique.mockRejectedValue(new Error("db down"));
    await expect(orgCompanyDomainsFor("u1")).rejects.toThrow("db down");
  });
});

describe("the live relationship loader (prismaRelationshipDeps) with the flag off", () => {
  it("never queries the organization and produces no org fact", async () => {
    delete process.env.TEAMS_ENABLED;
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    // The other lookups hit tables this mock does not have: each fails into
    // "unknown", which is fine here — only the org read is under test.
    const snapshot = await loadRelationshipSnapshot({
      userId: "u1",
      senderAddress: "kim@acme.com",
      userAddresses: ["me@gmail.com"],
      senderAuthenticated: true,
    });
    warn.mockRestore();
    expect(m.findUnique).not.toHaveBeenCalled();
    expect(Object.keys(snapshot)).not.toContain("orgCompanyDomain");
  });

  it("flag on: the same loader reads the member's organization once", async () => {
    process.env.TEAMS_ENABLED = "true";
    m.findUnique.mockResolvedValue({ org: { companyDomains: ["acme.com"] } });
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const snapshot = await loadRelationshipSnapshot({
      userId: "u1",
      senderAddress: "kim@acme.com",
      userAddresses: ["me@gmail.com"],
      senderAuthenticated: true,
    });
    warn.mockRestore();
    expect(m.findUnique).toHaveBeenCalledTimes(1);
    expect(snapshot.orgCompanyDomain).toBe(true);
  });
});
