import { beforeEach, describe, expect, it, vi } from "vitest";
import type { CandidateTrait } from "../sender-trait-policy.js";

const findManyMock = vi.hoisted(() => vi.fn());

vi.mock("../db.js", () => ({
  prisma: { senderTrait: { findMany: findManyMock } },
}));

import {
  getActiveSenderTraits,
  type IncumbentTrait,
  MIN_TRAIT_CONFIDENCE_FOR_JUDGE,
  resolveTraitUpsert,
} from "../sender-trait-store.js";

const challenger: CandidateTrait = {
  factKind: "relationship",
  factValue: "investor",
  confidence: 0.9,
  evidenceText: "We'd like to invest in your round.",
};

describe("resolveTraitUpsert", () => {
  it("creates when there is no incumbent", () => {
    const action = resolveTraitUpsert(null, challenger, "sig1");
    expect(action.type).toBe("create");
  });

  it("strengthens when the value matches", () => {
    const incumbent: IncumbentTrait = {
      factValue: "investor",
      observedCount: 2,
      status: "active",
    };
    const action = resolveTraitUpsert(incumbent, challenger, "sig2");
    expect(action.type).toBe("strengthen");
    if (action.type === "strengthen") {
      expect(action.observedCount).toBe(3);
      expect(action.sourceSig).toBe("sig2");
    }
  });

  it("flags a conflict on a different value, never overwriting the incumbent", () => {
    const incumbent: IncumbentTrait = {
      factValue: "vendor",
      observedCount: 4,
      status: "active",
    };
    const action = resolveTraitUpsert(incumbent, challenger, "sig3");
    expect(action.type).toBe("conflict");
    if (action.type === "conflict") {
      expect(action.keepValue).toBe("vendor");
      expect(action.conflictValue).toBe("investor");
    }
  });
});

describe("getActiveSenderTraits", () => {
  beforeEach(() => findManyMock.mockReset());

  it("returns active, confident traits and forwards the active+confidence filter", async () => {
    const trait = {
      factKind: "relationship",
      factValue: "investor",
      confidence: 0.9,
      evidenceText: "We'd like to invest in your round.",
    };
    findManyMock.mockResolvedValue([trait]);

    const out = await getActiveSenderTraits("u1", "a@b.com");

    expect(out).toEqual([trait]);
    const arg = findManyMock.mock.calls[0]?.[0];
    expect(arg.where).toMatchObject({
      userId: "u1",
      sender: "a@b.com",
      status: "active",
      confidence: { gte: MIN_TRAIT_CONFIDENCE_FOR_JUDGE },
    });
  });

  it("returns [] when no traits qualify", async () => {
    findManyMock.mockResolvedValue([]);
    expect(await getActiveSenderTraits("u1", "a@b.com")).toEqual([]);
  });
});
