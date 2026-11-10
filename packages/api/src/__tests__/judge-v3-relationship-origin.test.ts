/**
 * Sent-mail provenance in the relationship snapshot (doc §3(2), #1591): only
 * null | "user" | "approved" sends count as the user writing to someone.
 * Klorn's auto-replies and mailto unsubscribes never do. The in-memory db
 * below applies the loader's real `where` origin clause to fixture rows.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

type Sent = { to: string; threadId: string | null; sentAt: Date; origin: string | null };
const sentRows: Sent[] = [];

function originAllowed(
  where: { OR?: Array<{ origin: null | { in: string[] } }> },
  origin: string | null,
) {
  if (!where.OR) return true;
  return where.OR.some((c) =>
    c.origin === null ? origin === null : c.origin.in.includes(origin ?? ""),
  );
}

vi.mock("../db.js", () => ({
  db: {
    sentMessage: {
      findFirst: vi.fn(async ({ where }: { where: never }) => {
        const hit = sentRows.find((r) => originAllowed(where, r.origin));
        return hit ? { id: "x" } : null;
      }),
      findMany: vi.fn(
        async ({
          where,
        }: {
          where: { threadId?: { in: string[] }; to?: { contains: string } } & never;
        }) =>
          sentRows.filter(
            (r) =>
              originAllowed(where, r.origin) &&
              (!where.threadId ||
                (r.threadId !== null && where.threadId.in.includes(r.threadId))) &&
              (!where.to || r.to.toLowerCase().includes(where.to.contains.replace(/\\/g, ""))),
          ),
      ),
    },
    emailMessage: {
      findMany: vi.fn(async () => [
        {
          threadId: "t1",
          receivedAt: new Date("2026-10-01T00:00:00Z"),
          from: "eve@attacker.io",
          fromAddress: null,
        },
      ]),
    },
    contactEngagementScore: { findUnique: vi.fn(async () => null) },
  },
}));
vi.mock("../judge/judge-context.js", () => ({
  lookupPinnedTier: vi.fn(async () => null),
  isSenderAddressIndexEnabled: () => false,
}));
vi.mock("../mail/sender-labels.js", () => ({ senderLabelsFor: vi.fn(async () => new Map()) }));

import { loadRelationshipSnapshot, SENT_EVIDENCE_WHERE } from "../judge/v3/relationship-loader.js";

const load = () =>
  loadRelationshipSnapshot({
    userId: "u1",
    senderAddress: "eve@attacker.io",
    userAddresses: ["me@acme.com"],
  });
const send = (origin: string | null, sentAt = "2026-10-01T01:00:00Z"): Sent => ({
  to: "eve@attacker.io",
  threadId: "t1",
  sentAt: new Date(sentAt),
  origin,
});

beforeEach(() => {
  sentRows.length = 0;
});

describe("relationship snapshot: sent-mail provenance", () => {
  it("counts null, user and approved sends", async () => {
    sentRows.push(
      send(null),
      send("user", "2026-10-02T00:00:00Z"),
      send("approved", "2026-10-03T00:00:00Z"),
    );
    const s = await load();
    expect(s.sentCount).toBe(3);
    expect(s.repliedThreadCount).toBe(1);
  });

  it("an auto_reply-only contact has no reciprocity: never 'the user wrote to them'", async () => {
    sentRows.push(send("auto_reply"), send("auto_reply", "2026-10-02T00:00:00Z"));
    const s = await load();
    expect(s.sentCount).toBeNull(); // no evidence-grade sent mail at all → unknown
    expect(s.lastSentAt).toBeNull();
    expect(s.medianReplyLatencyMs).toBeNull();
    expect(s.repliedThreadCount).toBeNull();
    expect(s.userInitiatedThreadCount).toBeNull();
  });

  it("an unsubscribe send is excluded while the user's own send still counts", async () => {
    sentRows.push(send("unsubscribe"), send("user", "2026-10-05T00:00:00Z"));
    const s = await load();
    expect(s.sentCount).toBe(1);
    expect(s.lastSentAt).toBe("2026-10-05T00:00:00.000Z");
  });

  it("one shared clause, for every sent query", () => {
    expect(SENT_EVIDENCE_WHERE).toEqual({
      OR: [{ origin: null }, { origin: { in: ["user", "approved"] } }],
    });
  });
});
