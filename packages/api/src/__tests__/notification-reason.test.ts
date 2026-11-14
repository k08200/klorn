/**
 * Why a mail rang (NC1 contract `reason`): a verified quote only when the
 * stored v3 evidence re-checks as a substring of the mail, for a user under
 * policy v3; otherwise the judge's tierReason, never marked verified.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import { createFakeDb, type FakeDb } from "./helpers/fake-db.js";

const dbHolder = vi.hoisted(() => ({ current: null as unknown }));
const queries = vi.hoisted(() => [] as string[]);

vi.mock("../db.js", async () => {
  const { fakePrismaClient } = await import("./helpers/fake-db.js");
  const { countingClient } = await import("./helpers/counting-client.js");
  const prisma = countingClient(
    fakePrismaClient(() => dbHolder.current as FakeDb),
    queries,
  );
  return { prisma, db: prisma };
});

import {
  MAX_BODY_READS,
  notificationReason,
  type ReasonItemRow,
  reasonEvidence,
  reasonsForMail,
} from "../notify/notification-reason.js";

const NOW = new Date("2026-11-14T01:00:00.000Z");
const USER = "user-1";

function v3Item(overrides: Partial<ReasonItemRow> = {}): ReasonItemRow {
  return {
    tier: "PUSH",
    status: "OPEN",
    heldAt: null,
    isManualOverride: false,
    agentTierSetAt: null,
    v3PolicyVersion: "v3.1",
    v3Decision: {
      basis: "llm",
      reasons: [
        {
          code: "ask_due_soon",
          fact: "asks[0]",
          evidence: "please sign the contract by 5pm today",
          params: { askKind: "sign" },
        },
      ],
      threadTurn: null,
    },
    v3Due: null,
    tierReason: "Signature needed today",
    ...overrides,
  };
}

const MAIL = {
  subject: "Contract",
  body: "Hi, Please sign the contract by 5pm today. Thanks",
};

describe("reasonEvidence", () => {
  it("returns the deciding reason's stored quote", () => {
    expect(reasonEvidence(v3Item(), { subject: MAIL.subject, now: NOW })).toBe(
      "please sign the contract by 5pm today",
    );
  });

  it("skips a reason with no quote (a hold) and takes the next one that has one", () => {
    const item = v3Item({
      v3Decision: {
        basis: "llm",
        reasons: [
          { code: "held_budget", fact: null, evidence: null, params: { budget: 5 } },
          { code: "ask", fact: "asks[0]", evidence: "reply by Friday please", params: {} },
        ],
        threadTurn: null,
      },
    });
    expect(reasonEvidence(item, { subject: null, now: NOW })).toBe("reply by Friday please");
  });

  it("returns nothing for a manual override, an agent lane or an unknown policy version", () => {
    expect(reasonEvidence(v3Item({ isManualOverride: true }), { subject: null, now: NOW })).toBe(
      null,
    );
    expect(reasonEvidence(v3Item({ agentTierSetAt: NOW }), { subject: null, now: NOW })).toBe(null);
    expect(reasonEvidence(v3Item({ v3PolicyVersion: "v9" }), { subject: null, now: NOW })).toBe(
      null,
    );
  });
});

describe("notificationReason", () => {
  it("verified: the quote re-checks against the body", () => {
    expect(
      notificationReason({
        tierReason: "Signature needed today",
        evidence: "please sign the contract by 5pm today",
        mail: MAIL,
        language: "en",
      }),
    ).toEqual({
      text: "Signature needed today",
      verified: true,
      quote: "please sign the contract by 5pm today",
      quoteIn: "body",
    });
  });

  it("verified in the subject reports quoteIn subject", () => {
    const reason = notificationReason({
      tierReason: null,
      evidence: "Contract renewal deadline",
      mail: { subject: "Contract renewal deadline", body: "see attached" },
      language: "en",
    });
    expect(reason).toEqual({
      text: "Contract renewal deadline",
      verified: true,
      quote: "Contract renewal deadline",
      quoteIn: "subject",
    });
  });

  it("unverified: a quote that is NOT in the mail falls back to tierReason, verified false", () => {
    expect(
      notificationReason({
        tierReason: "Signature needed today",
        evidence: "wire the money to this account now",
        mail: MAIL,
        language: "en",
      }),
    ).toEqual({ text: "Signature needed today", verified: false });
  });

  it("unverified: a quote too short to ground anything is not verified", () => {
    const reason = notificationReason({
      tierReason: "Looks urgent",
      evidence: "sign",
      mail: MAIL,
      language: "en",
    });
    expect(reason).toEqual({ text: "Looks urgent", verified: false });
  });

  it("unverified: without the mail text there is nothing to check against", () => {
    expect(
      notificationReason({
        tierReason: "Looks urgent",
        evidence: "please sign the contract by 5pm today",
        mail: null,
        language: "en",
      }),
    ).toEqual({ text: "Looks urgent", verified: false });
  });

  it("resolves a stored reason key in the reader's language", () => {
    expect(
      notificationReason({
        tierReason: "email.heldByInterruptBudget",
        evidence: null,
        mail: null,
        language: "ko",
      }),
    ).toEqual({ text: "보류: 오늘 알림 한도에 도달해 알림을 보내지 않았어요", verified: false });
  });

  it("no reason and no verified quote → no reason at all", () => {
    expect(
      notificationReason({ tierReason: null, evidence: null, mail: MAIL, language: "en" }),
    ).toBe(null);
    expect(
      notificationReason({ tierReason: "  ", evidence: null, mail: MAIL, language: "en" }),
    ).toBe(null);
  });

  it("plain text only: tags, controls and bidi marks are stripped from the text", () => {
    const reason = notificationReason({
      tierReason: "<b>Pay</b> now\u0007\nor\u202e lose access",
      evidence: null,
      mail: null,
      language: "en",
    });
    expect(reason).toEqual({ text: "Pay now or lose access", verified: false });
  });

  it("verbatim: a quote whose cleaned text is not in the mail is not verified", () => {
    // The mail carries literal tags; the cleaned quote "please sign the…" is
    // not a substring of what the mail says, so it must not show as verbatim.
    const reason = notificationReason({
      tierReason: "Looks urgent",
      evidence: "please <i>sign</i> the contract by 5pm today",
      mail: { subject: "x", body: "Please <i>sign</i> the contract by 5pm today" },
      language: "en",
    });
    expect(reason).toEqual({ text: "Looks urgent", verified: false });
  });

  it("invisible format characters in a quote are dropped and it still verifies", () => {
    const reason = notificationReason({
      tierReason: null,
      evidence: "please\u200b sign the contract\u2060 by 5pm today",
      mail: MAIL,
      language: "en",
    });
    expect(reason).toMatchObject({
      verified: true,
      quote: "please sign the contract by 5pm today",
    });
  });
});

describe("reasonsForMail", () => {
  let db: FakeDb;

  beforeEach(() => {
    queries.length = 0;
    db = createFakeDb({
      emailMessage: [
        {
          id: "e-body",
          userId: USER,
          gmailId: "g1",
          from: "a@b.c",
          to: "me@x.io",
          subject: "Contract",
          body: MAIL.body,
          receivedAt: NOW,
        },
        {
          id: "e-other-user",
          userId: "user-2",
          gmailId: "g2",
          from: "a@b.c",
          to: "me@x.io",
          subject: "Contract",
          body: MAIL.body,
          receivedAt: NOW,
        },
      ],
    });
    dbHolder.current = db;
  });

  it("under policy v3: reads the body once for the batch, scoped to the user, and verifies", async () => {
    const items = new Map([
      ["e-body", v3Item()],
      ["e-other-user", v3Item()],
    ]);
    const reasons = await reasonsForMail(
      USER,
      [
        { id: "e-body", subject: "Contract" },
        { id: "e-other-user", subject: "Contract" },
      ],
      items,
      { language: "en", now: NOW, policyUser: true },
    );
    expect(reasons.get("e-body")?.verified).toBe(true);
    // Another user's mail is never read: its quote cannot be checked.
    expect(reasons.get("e-other-user")).toEqual({
      text: "Signature needed today",
      verified: false,
    });
    expect(queries).toEqual(["emailMessage.findMany"]);
  });

  it("a subject quote needs no body read", async () => {
    const item = v3Item({
      v3Decision: {
        basis: "llm",
        reasons: [
          { code: "ask", fact: "asks[0]", evidence: "Contract renewal deadline", params: {} },
        ],
        threadTurn: null,
      },
    });
    const reasons = await reasonsForMail(
      USER,
      [{ id: "e-body", subject: "Contract renewal deadline" }],
      new Map([["e-body", item]]),
      { language: "en", now: NOW, policyUser: true },
    );
    expect(reasons.get("e-body")?.quoteIn).toBe("subject");
    expect(queries).toEqual([]);
  });

  it("a body already in memory is used as is", async () => {
    const reasons = await reasonsForMail(
      USER,
      [{ id: "e-body", subject: "Contract", body: MAIL.body }],
      new Map([["e-body", v3Item()]]),
      { language: "en", now: NOW, policyUser: true },
    );
    expect(reasons.get("e-body")?.verified).toBe(true);
    expect(queries).toEqual([]);
  });

  it("outside policy v3: stored evidence is ignored and nothing is read", async () => {
    const reasons = await reasonsForMail(
      USER,
      [{ id: "e-body", subject: "Contract" }],
      new Map([["e-body", v3Item()]]),
      { language: "en", now: NOW, policyUser: false },
    );
    expect(reasons.get("e-body")).toEqual({ text: "Signature needed today", verified: false });
    expect(queries).toEqual([]);
  });

  it(`reads at most MAX_BODY_READS bodies; the rest stay unverified`, async () => {
    const many = Array.from({ length: MAX_BODY_READS + 3 }, (_, i) => `e${i}`);
    db = createFakeDb({
      emailMessage: many.map((id) => ({
        id,
        userId: USER,
        gmailId: `g-${id}`,
        from: "a@b.c",
        to: "me@x.io",
        subject: "Contract",
        body: MAIL.body,
        receivedAt: NOW,
      })),
    });
    dbHolder.current = db;
    const reasons = await reasonsForMail(
      USER,
      many.map((id) => ({ id, subject: "Contract" })),
      new Map(many.map((id) => [id, v3Item()])),
      { language: "en", now: NOW, policyUser: true },
    );
    const verified = many.filter((id) => reasons.get(id)?.verified).length;
    expect(verified).toBe(MAX_BODY_READS);
    expect(queries).toEqual(["emailMessage.findMany"]);
  });

  it("a mail with no item has no reason", async () => {
    const reasons = await reasonsForMail(USER, [{ id: "e-body", subject: "Contract" }], new Map(), {
      language: "en",
      now: NOW,
      policyUser: true,
    });
    expect(reasons.get("e-body")).toBe(null);
  });
});
