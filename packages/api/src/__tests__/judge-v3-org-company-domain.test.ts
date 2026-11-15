/**
 * Klorn Teams: an organization's company domains reach a member's judge as one
 * relationship fact (orgCompanyDomain), never as a lane, a pin or a trust bar.
 *
 * - Absent unless the member's organization configured usable domains: the
 *   snapshot then has no orgCompanyDomain key at all, so every judge input is
 *   exactly what it was before this fact existed (stored rows, replay, hashes).
 * - Spoofing: true only for mail that passed DMARC, like sameOrgDomain; a
 *   public mailbox domain, a cc second-level suffix or a multi-tenant hosting
 *   parent never matches, whatever the owner typed.
 * - A raw fact with no hand weight: it moves no lane, no floor, no trust bar
 *   and no importance (a lift above `unknown` would make a held item rank
 *   first), so every policy version decides exactly as without it.
 * - Only a boolean reaches the judge: the domain list, the org and its members
 *   never do.
 */

import { describe, expect, it, vi } from "vitest";
import { IMPORTANCE_PRIOR, importancePrior } from "../judge/v3/importance.js";
import { decideLiveLane, isTrustedSender } from "../judge/v3/live-decision.js";
import {
  isFirstContact,
  laneFromFactsV3,
  POLICY_VERSIONS,
  RISK_TRUST_MIN_HISTORY_MS,
  RISK_TRUST_MIN_INBOUND,
} from "../judge/v3/policy.js";
import type { FactsV1, RelationshipSnapshot } from "../judge/v3/policy-types.js";
import {
  buildRelationshipSnapshot,
  parseRelationshipSnapshot,
  type RelationshipInput,
  UNKNOWN_RELATIONSHIP,
} from "../judge/v3/relationship.js";
import {
  loadRelationshipSnapshot,
  type RelationshipLoaderDeps,
} from "../judge/v3/relationship-loader.js";
import { genFacts, genRelationship, genTierOrNull, mulberry32 } from "./helpers/v3-facts-gen.js";

const NOW = new Date("2026-11-14T09:00:00.000Z");
const t = (iso: string) => new Date(iso);

function input(over: Partial<RelationshipInput> = {}): RelationshipInput {
  return {
    senderAddress: "Kim <kim@acme.com>",
    userAddresses: ["me@gmail.com"],
    sent: [],
    inbound: [],
    userSentInSenderThreads: [],
    firstInboundAt: null,
    firstSentAt: null,
    senderAuthenticated: true,
    dismissCount: 0,
    pinnedTier: null,
    senderCategory: null,
    ...over,
  };
}

describe("buildRelationshipSnapshot — orgCompanyDomain", () => {
  it("is absent when no organization domains are given, so the snapshot is unchanged", () => {
    for (const orgCompanyDomains of [undefined, [], ["gmail.com"], ["GMAIL.com", "outlook.com"]]) {
      const snapshot = buildRelationshipSnapshot(input({ orgCompanyDomains }));
      expect(Object.keys(snapshot), JSON.stringify(orgCompanyDomains)).not.toContain(
        "orgCompanyDomain",
      );
      expect(snapshot).toEqual(buildRelationshipSnapshot(input()));
    }
  });

  it("is true only for an authenticated sender on one of the domains or a subdomain", () => {
    const fact = (over: Partial<RelationshipInput>) =>
      buildRelationshipSnapshot(input({ orgCompanyDomains: ["acme.com"], ...over }))
        .orgCompanyDomain;
    expect(fact({})).toBe(true);
    expect(fact({ senderAddress: "kim@mail.acme.com" })).toBe(true);
    expect(fact({ senderAddress: "kim@ACME.COM" })).toBe(true);
    // DMARC unknown or failed: unknown, never a lift (a forger copies the From).
    expect(fact({ senderAuthenticated: null })).toBeNull();
    expect(fact({ senderAuthenticated: false })).toBeNull();
    // Not the company: lookalikes and outsiders.
    expect(fact({ senderAddress: "kim@notacme.com" })).toBe(false);
    expect(fact({ senderAddress: "kim@acme.com.evil.io" })).toBe(false);
    expect(fact({ senderAddress: "kim@partner.io" })).toBe(false);
  });

  it("never matches a public mailbox domain, even one an admin typed in", () => {
    const snapshot = buildRelationshipSnapshot(
      input({ senderAddress: "kim@gmail.com", orgCompanyDomains: ["gmail.com", "acme.com"] }),
    );
    expect(snapshot.orgCompanyDomain).toBe(false);
  });

  it("ignores owner-typed domains that stand for strangers (free mail, cc suffixes, hosting parents)", () => {
    for (const domain of [
      "yahoo.co.jp",
      "hotmail.co.uk",
      "co.uk",
      "com.au",
      "co.kr",
      "or.kr",
      "onmicrosoft.com",
      "github.io",
      "vercel.app",
    ]) {
      const snapshot = buildRelationshipSnapshot(
        input({ senderAddress: `kim@tenant.${domain}`, orgCompanyDomains: [domain] }),
      );
      expect(Object.keys(snapshot), domain).not.toContain("orgCompanyDomain");
    }
  });

  it("is not fooled by a display name, a malformed domain or a lookalike", () => {
    const fact = (senderAddress: string) =>
      buildRelationshipSnapshot(input({ senderAddress, orgCompanyDomains: ["acme.com"] }))
        .orgCompanyDomain;
    expect(fact('"kim@acme.com" <evil@x.io>')).toBe(false);
    expect(fact("kim@acme.com <evil@x.io>")).toBe(false);
    expect(fact("x@evil.io#.acme.com")).toBe(false);
    expect(fact("x@a..acme.com")).toBe(false);
    expect(fact("x@xn--acme-0za.com")).toBe(false);
    expect(fact("x@xacme.com")).toBe(false);
    // A punycode subdomain of the company is the company.
    expect(fact("x@xn--bcher-kva.acme.com")).toBe(true);
  });

  it("an unparseable sender is unknown, with no org fact", () => {
    const snapshot = buildRelationshipSnapshot(
      input({ senderAddress: "not an address", orgCompanyDomains: ["acme.com"] }),
    );
    expect(snapshot).toEqual(UNKNOWN_RELATIONSHIP);
  });

  it("carries a boolean only: the domain list never reaches the judge input", () => {
    const snapshot = buildRelationshipSnapshot(
      input({ orgCompanyDomains: ["acme.com", "acme-internal.io"] }),
    );
    expect(JSON.stringify(snapshot)).not.toContain("acme");
  });
});

describe("parseRelationshipSnapshot — orgCompanyDomain", () => {
  it("round-trips the fact and keeps a row without it free of the key", () => {
    const withFact = buildRelationshipSnapshot(input({ orgCompanyDomains: ["acme.com"] }));
    expect(parseRelationshipSnapshot(JSON.parse(JSON.stringify(withFact)))).toEqual(withFact);
    const without = buildRelationshipSnapshot(input());
    const parsed = parseRelationshipSnapshot(JSON.parse(JSON.stringify(without)));
    expect(parsed).toEqual(without);
    expect(Object.keys(parsed ?? {})).not.toContain("orgCompanyDomain");
  });

  it("rejects a malformed fact", () => {
    const raw = { ...buildRelationshipSnapshot(input()), orgCompanyDomain: "yes" };
    expect(parseRelationshipSnapshot(raw)).toBeNull();
  });

  it("keeps a stored null (unknown) as null", () => {
    const raw = { ...buildRelationshipSnapshot(input()), orgCompanyDomain: null };
    expect(parseRelationshipSnapshot(raw)?.orgCompanyDomain).toBeNull();
  });
});

function deps(over: Partial<RelationshipLoaderDeps> = {}): RelationshipLoaderDeps {
  return {
    hasAnySent: vi.fn(async () => true),
    sentRowsMentioning: vi.fn(async () => [
      { sentAt: t("2026-10-01T03:00:00Z"), to: "kim@acme.com", threadId: "th1" },
    ]),
    inboundFrom: vi.fn(async () => [
      {
        threadId: "th1",
        receivedAt: t("2026-10-01T00:00:00Z"),
        from: "Kim <kim@acme.com>",
        fromAddress: "kim@acme.com",
      },
    ]),
    sentInThreads: vi.fn(async () => [{ sentAt: t("2026-10-01T03:00:00Z"), threadId: "th1" }]),
    dismissCount: vi.fn(async () => 0),
    pinnedTier: vi.fn(async () => null),
    senderCategory: vi.fn(async () => null),
    coAttendanceCoverage: vi.fn(async () => ({
      countedThrough: null,
      sources: [],
      hasNonGoogleSource: false,
    })),
    coAttendanceRow: vi.fn(async () => null),
    coAttendanceOwnAddresses: vi.fn(async () => new Set<string>()),
    ...over,
  };
}

const LOAD = {
  userId: "u1",
  senderAddress: "Kim <kim@acme.com>",
  userAddresses: ["me@gmail.com"],
  senderAuthenticated: true,
  now: NOW,
};

describe("loadRelationshipSnapshot — the org fact is the only difference", () => {
  it("judge input with the organization's domains differs from the input without them only by orgCompanyDomain", async () => {
    // Flag off / no organization: the org lookup answers no domains (or the
    // dependency is absent). Flag on, member of an org with acme.com: the
    // same mail, the same rows, one extra fact.
    const off = await loadRelationshipSnapshot(
      LOAD,
      deps({ orgCompanyDomains: vi.fn(async () => []) }),
    );
    const absent = await loadRelationshipSnapshot(LOAD, deps());
    const on = await loadRelationshipSnapshot(
      LOAD,
      deps({ orgCompanyDomains: vi.fn(async () => ["acme.com"]) }),
    );
    expect(off).toEqual(absent);
    expect(Object.keys(off)).not.toContain("orgCompanyDomain");
    const { orgCompanyDomain, ...rest } = on;
    expect(orgCompanyDomain).toBe(true);
    expect(rest).toEqual(off);
    expect(Object.keys(on).sort()).toEqual([...Object.keys(off), "orgCompanyDomain"].sort());
  });

  it("a failed organization lookup is no fact (unknown), never a failed snapshot", async () => {
    const failing = await loadRelationshipSnapshot(
      LOAD,
      deps({
        orgCompanyDomains: vi.fn(async () => {
          throw new Error("db down");
        }),
      }),
    );
    expect(failing).toEqual(await loadRelationshipSnapshot(LOAD, deps()));
  });

  it("asks the organization lookup for the judged user only", async () => {
    const lookup = vi.fn(async () => ["acme.com"]);
    await loadRelationshipSnapshot(LOAD, deps({ orgCompanyDomains: lookup }));
    expect(lookup).toHaveBeenCalledTimes(1);
    expect(lookup).toHaveBeenCalledWith("u1");
  });
});

describe("importance and trust — the org fact has no hand weight", () => {
  const plain: RelationshipSnapshot = { ...UNKNOWN_RELATIONSHIP, sentCount: 0 };

  it("never lifts importance: a stranger on an owner-listed domain stays at the unknown prior", () => {
    for (const orgCompanyDomain of [true, false, null]) {
      expect(importancePrior({ ...plain, orgCompanyDomain }, NOW)).toBe(
        importancePrior(plain, NOW),
      );
    }
    expect(importancePrior({ ...plain, orgCompanyDomain: true }, NOW)).toBe(
      IMPORTANCE_PRIOR.unknown,
    );
    // The personal same-domain signal keeps its weight.
    expect(
      importancePrior({ ...plain, sameOrgDomain: true, orgCompanyDomain: true }, NOW),
    ).toBeCloseTo(IMPORTANCE_PRIOR.unknown + IMPORTANCE_PRIOR.weights.sameOrg);
  });

  it("is not trust: the slot reserve and the first-contact bar ignore it", () => {
    const colleague: RelationshipSnapshot = {
      ...UNKNOWN_RELATIONSHIP,
      sentCount: 0,
      inboundCount: 0,
      meetingCount: 0,
      vip: false,
      orgCompanyDomain: true,
    };
    expect(isTrustedSender(colleague, true)).toBe(false);
    expect(isFirstContact(colleague, true, NOW)).toBe(true);
  });
});

const base: FactsV1 = {
  asks: [],
  addressedTo: "me_direct",
  threadTurn: "none",
  event: null,
  transaction: null,
  risk: [],
  kind: "personal",
  ambiguous: false,
};

/**
 * The decision with the relationship reason's orgCompanyDomain param removed,
 * and the relationship reason itself when that param was all it carried (a
 * sender otherwise unknown).
 */
function withoutOrgParam(decision: ReturnType<typeof laneFromFactsV3>) {
  return {
    ...decision,
    reasons: decision.reasons.flatMap((r) => {
      if (r.code !== "relationship") return [r];
      const { orgCompanyDomain: _dropped, ...params } = r.params;
      return Object.keys(params).length === 0 ? [] : [{ ...r, params }];
    }),
  };
}

describe("policy — the org fact never moves a lane or a floor", () => {
  it("every policy version decides identically with and without it (generated facts)", () => {
    const rng = mulberry32(20261114);
    for (let i = 0; i < 400; i++) {
      const facts = genFacts(rng, NOW);
      const rel = genRelationship(rng, NOW) ?? UNKNOWN_RELATIONSHIP;
      const context = {
        pinnedTier: genTierOrNull(rng, 0.1),
        spam: rng() < 0.05,
        automatedSender: rng() < 0.2,
      };
      for (const version of POLICY_VERSIONS) {
        for (const senderAuthenticated of [true, null, false] as const) {
          for (const fact of [true, false, null] as const) {
            const args = { facts, decidedAt: NOW, version, senderAuthenticated, ...context };
            const plain = laneFromFactsV3({ ...args, relationship: rel });
            const lifted = laneFromFactsV3({
              ...args,
              relationship: { ...rel, orgCompanyDomain: fact },
            });
            expect(withoutOrgParam(lifted)).toEqual(plain);
          }
        }
      }
    }
  });

  it("a phishing-suspect pay ask from a 'colleague' stays out of PUSH", () => {
    const phish: FactsV1 = {
      ...base,
      risk: ["phishing_suspect"],
      asks: [{ kind: "pay", object: "invoice", due: NOW.toISOString(), evidence: "pay now" }],
    };
    const colleague = { ...UNKNOWN_RELATIONSHIP, orgCompanyDomain: true };
    for (const version of POLICY_VERSIONS) {
      const d = laneFromFactsV3({
        facts: phish,
        relationship: colleague,
        decidedAt: NOW,
        version,
        senderAuthenticated: true,
      });
      expect(d.lane, version).not.toBe("PUSH");
    }
  });

  it("explains itself: the relationship reason names the fact when known, and only then", () => {
    const known = {
      ...UNKNOWN_RELATIONSHIP,
      inboundCount: RISK_TRUST_MIN_INBOUND,
      firstSeenAt: new Date(NOW.getTime() - RISK_TRUST_MIN_HISTORY_MS - 1).toISOString(),
    };
    const reasonOf = (rel: RelationshipSnapshot) =>
      laneFromFactsV3({ facts: base, relationship: rel, decidedAt: NOW }).reasons.find(
        (r) => r.code === "relationship",
      );
    expect(reasonOf({ ...known, orgCompanyDomain: true })?.params).toMatchObject({
      orgCompanyDomain: true,
    });
    expect(reasonOf({ ...known, orgCompanyDomain: false })?.params).toMatchObject({
      orgCompanyDomain: false,
    });
    expect(Object.keys(reasonOf({ ...known, dismissCount: 1 })?.params ?? {})).not.toContain(
      "orgCompanyDomain",
    );
    expect(
      Object.keys(reasonOf({ ...known, dismissCount: 1, orgCompanyDomain: null })?.params ?? {}),
    ).not.toContain("orgCompanyDomain");
  });

  it("the live decision is unchanged in lane, trust and importance", () => {
    const rel: RelationshipSnapshot = { ...UNKNOWN_RELATIONSHIP, sentCount: 0, inboundCount: 0 };
    const live = (relationship: RelationshipSnapshot) =>
      decideLiveLane({
        v2Tier: "QUEUE",
        v2Source: "llm",
        email: { from: "Kim <kim@acme.com>", labels: [] },
        receivedAt: NOW,
        basis: { kind: "llm", facts: base, relationship, signals: {} },
        decidedAt: NOW,
        senderAuthenticated: true,
      } as Parameters<typeof decideLiveLane>[0]);
    const plain = live(rel);
    const lifted = live({ ...rel, orgCompanyDomain: true });
    expect(lifted.lane).toBe(plain.lane);
    expect(lifted.trusted).toBe(plain.trusted);
    expect(lifted.importance).toBe(plain.importance);
    expect(withoutOrgParam(lifted as never)).toEqual(withoutOrgParam(plain as never));
  });
});
