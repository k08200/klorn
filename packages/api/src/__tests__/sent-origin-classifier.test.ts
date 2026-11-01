/**
 * Provenance for SentMessage rows the Sent-folder scan or the history import
 * CREATES (docs/design/attention-engine-v3.md §3(2)). The rules mirror the
 * legacy SQL backfill (migration 20261101000000_sent_message_origin_backfill):
 * approved → auto_reply → unsubscribe → null. Null means the user wrote it,
 * so a miss here turns Klorn's own mail into relationship evidence.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
  outboxResults: [] as { result: string | null }[],
  pendingResults: [] as { result: string | null }[],
  claims: [] as { dedupeKey: string | null; title: string; message: string; createdAt: Date }[],
  sources: [] as { gmailId: string; subject: string }[],
  mailtos: [] as { listUnsubscribeMailto: string | null }[],
  senders: new Set<string>(),
}));

vi.mock("../db.js", () => ({
  prisma: {
    actionOutbox: { findMany: vi.fn(async () => state.outboxResults) },
    pendingAction: { findMany: vi.fn(async () => state.pendingResults) },
    notification: { findMany: vi.fn(async () => state.claims) },
    emailMessage: {
      findMany: vi.fn(async (args: { where: { gmailId?: unknown } }) =>
        args.where.gmailId ? state.sources : state.mailtos,
      ),
      findFirst: vi.fn(async (args: { where: { OR: { fromAddress?: string }[] } }) => {
        const addr = args.where.OR.find((c) => c.fromAddress)?.fromAddress ?? "";
        return state.senders.has(addr) ? { id: "e1" } : null;
      }),
    },
  },
}));

import { prisma } from "../db.js";
import {
  claimRecipient,
  claimSourceGmailId,
  classifySentOrigin,
  classifySentRows,
  extractApprovedMessageId,
  type SentOriginEvidence,
} from "../mail/sent-origin-classifier.js";

const CLAIM_AT = new Date("2026-05-10T09:00:00.000Z");
const minutes = (n: number) => new Date(CLAIM_AT.getTime() + n * 60_000);

function evidence(over: Partial<SentOriginEvidence> = {}): SentOriginEvidence {
  return {
    approvalResults: [],
    claims: [],
    sourceSubjects: new Map(),
    unsubscribeMailtos: [],
    senderAddresses: new Set(),
    ...over,
  };
}

function row(over: Partial<Parameters<typeof classifySentOrigin>[0]> = {}) {
  return {
    gmailId: "g1",
    to: "sarah@acme.com",
    subject: "Re: Contract",
    sentAt: minutes(2),
    ...over,
  };
}

const settledClaim = {
  dedupeKey: "auto-reply:src1",
  title: "Auto-reply sent",
  message: 'Auto-replied to sarah@acme.com (rule: "Out of office") [src1]',
  createdAt: CLAIM_AT,
};
const claimEvidence = (over: Partial<typeof settledClaim> = {}) =>
  evidence({
    claims: [{ ...settledClaim, ...over }],
    sourceSubjects: new Map([["src1", "Contract"]]),
  });

describe("extractApprovedMessageId (the SQL's substring on result)", () => {
  it("takes the first messageId in the stored result", () => {
    expect(extractApprovedMessageId('{"success":true,"messageId":"m1","threadId":"t1"}')).toBe(
      "m1",
    );
    expect(extractApprovedMessageId('{"messageId":"a","x":{"messageId":"b"}}')).toBe("a");
  });

  it("matches only the compact JSON the executor stores, like the SQL pattern", () => {
    expect(extractApprovedMessageId('{"messageId": "m1"}')).toBeNull();
    expect(extractApprovedMessageId('{"success":true}')).toBeNull();
    expect(extractApprovedMessageId(null)).toBeNull();
  });
});

describe("claimSourceGmailId (COALESCE of the dedupeKey and the message suffix)", () => {
  it("reads the id from either claim key", () => {
    expect(claimSourceGmailId("auto-reply:abc", "whatever")).toBe("abc");
    expect(claimSourceGmailId("auto-mode-reply:abc", "whatever")).toBe("abc");
  });

  it("falls back to the trailing [id] of the message", () => {
    expect(claimSourceGmailId(null, "Auto-replied to x@y.com [abc]  ")).toBe("abc");
    expect(claimSourceGmailId("auto-reply:", "Auto-replied to x@y.com [abc]")).toBe("abc");
    expect(claimSourceGmailId(null, "Auto-replied to x@y.com [abc] later")).toBeNull();
    expect(claimSourceGmailId(null, "no id here")).toBeNull();
  });
});

describe("claimRecipient", () => {
  it("reads the address after 'replied to' or 'reply to', lowercased", () => {
    expect(claimRecipient('Auto-replied to Sarah@Acme.com (rule: "x") [a]')).toBe("sarah@acme.com");
    expect(claimRecipient('Auto-reply to bob@x.com (rule: "x") is being sent [a]')).toBe(
      "bob@x.com",
    );
    expect(claimRecipient("Sent something [a]")).toBeNull();
  });
});

describe("classifySentOrigin: approved", () => {
  it("is approved when an executed approval returned this gmailId", () => {
    const ev = evidence({ approvalResults: ['{"success":true,"messageId":"g1"}'] });
    expect(classifySentOrigin(row(), ev)).toBe("approved");
  });

  it("is not approved for another message id", () => {
    const ev = evidence({ approvalResults: ['{"success":true,"messageId":"g2"}'] });
    expect(classifySentOrigin(row(), ev)).toBeNull();
  });
});

describe("classifySentOrigin: auto_reply", () => {
  it("matches a claim by recipient, exact Re: subject and send window", () => {
    expect(classifySentOrigin(row({ to: " Sarah@Acme.com " }), claimEvidence())).toBe("auto_reply");
  });

  it("accepts the legacy auto-mode key and the pre-dedupeKey row", () => {
    expect(classifySentOrigin(row(), claimEvidence({ dedupeKey: "auto-mode-reply:src1" }))).toBe(
      "auto_reply",
    );
    expect(classifySentOrigin(row(), claimEvidence({ dedupeKey: null }))).toBe("auto_reply");
  });

  it("counts the window ends: claim - 1 min and claim + 2 min", () => {
    expect(classifySentOrigin(row({ sentAt: minutes(-1) }), claimEvidence())).toBe("auto_reply");
    expect(classifySentOrigin(row({ sentAt: minutes(2) }), claimEvidence())).toBe("auto_reply");
  });

  it("rejects a send outside the window (both senders send right after the claim)", () => {
    expect(classifySentOrigin(row({ sentAt: minutes(-1.5) }), claimEvidence())).toBeNull();
    expect(classifySentOrigin(row({ sentAt: minutes(2.5) }), claimEvidence())).toBeNull();
    expect(classifySentOrigin(row({ sentAt: minutes(9) }), claimEvidence())).toBeNull();
  });

  it("skips a failed claim: nothing was sent, so a manual Re: right after it stays the user's", () => {
    for (const title of ["Auto-reply failed", "Auto-mode reply failed"]) {
      expect(classifySentOrigin(row(), claimEvidence({ title }))).toBeNull();
    }
  });

  it("keeps claims that may have gone out", () => {
    for (const title of [
      "Auto-reply pending",
      "Auto-reply not confirmed",
      "Auto-mode reply not confirmed",
      "Auto-reply sent",
      "Klorn replied for you",
    ]) {
      expect(classifySentOrigin(row(), claimEvidence({ title }))).toBe("auto_reply");
    }
  });

  it("rejects a different recipient or a subject that is not exactly Re: <source>", () => {
    expect(classifySentOrigin(row({ to: "other@acme.com" }), claimEvidence())).toBeNull();
    expect(
      classifySentOrigin(row({ to: "Sarah Kim <sarah@acme.com>" }), claimEvidence()),
    ).toBeNull();
    expect(classifySentOrigin(row({ subject: "RE: Contract" }), claimEvidence())).toBeNull();
    expect(classifySentOrigin(row({ subject: "Contract" }), claimEvidence())).toBeNull();
  });

  it("needs the claimed source mail, and a claim-shaped notification", () => {
    expect(classifySentOrigin(row(), evidence({ claims: [settledClaim] }))).toBeNull();
    expect(classifySentOrigin(row(), claimEvidence({ dedupeKey: "other:src1" }))).toBeNull();
    expect(
      classifySentOrigin(row(), claimEvidence({ dedupeKey: null, title: "Auto-reply failed" })),
    ).toBeNull();
  });
});

describe("classifySentOrigin: unsubscribe", () => {
  const target = "mailto:unsub-42@lists.news.com?subject=Unsubscribe%20me";

  it("is an unsubscribe when the recipient is a stored mailto target with its subject", () => {
    const ev = evidence({ unsubscribeMailtos: [target] });
    const out = classifySentOrigin(
      row({ to: "Unsub-42@Lists.News.com", subject: "Unsubscribe me" }),
      ev,
    );
    expect(out).toBe("unsubscribe");
  });

  it("defaults the subject to 'unsubscribe' like parseMailtoTarget", () => {
    const ev = evidence({ unsubscribeMailtos: ["mailto:leave@x.com"] });
    expect(classifySentOrigin(row({ to: "leave@x.com", subject: "unsubscribe" }), ev)).toBe(
      "unsubscribe",
    );
  });

  it("any subject counts when the address never sent the user mail", () => {
    const ev = evidence({ unsubscribeMailtos: [target] });
    expect(classifySentOrigin(row({ to: "unsub-42@lists.news.com", subject: "Hi" }), ev)).toBe(
      "unsubscribe",
    );
  });

  it("an address that also writes to the user needs the exact subject (it may be a person)", () => {
    const ev = evidence({
      unsubscribeMailtos: ["mailto:jane@acme.com?subject=remove"],
      senderAddresses: new Set(["jane@acme.com"]),
    });
    expect(classifySentOrigin(row({ to: "jane@acme.com", subject: "Lunch?" }), ev)).toBeNull();
    expect(classifySentOrigin(row({ to: "jane@acme.com", subject: "remove" }), ev)).toBe(
      "unsubscribe",
    );
  });

  it("needs the recipient to be exactly that one address", () => {
    const ev = evidence({ unsubscribeMailtos: [target] });
    expect(classifySentOrigin(row({ to: "News <unsub-42@lists.news.com>" }), ev)).toBeNull();
    expect(classifySentOrigin(row({ to: "unsub-42@lists.news.com, a@b.com" }), ev)).toBeNull();
    expect(classifySentOrigin(row({ to: "" }), ev)).toBeNull();
  });

  it("ignores a mailto that parseMailtoTarget rejects", () => {
    const ev = evidence({ unsubscribeMailtos: ["https://x.com/unsub", "mailto:not-an-address"] });
    expect(classifySentOrigin(row({ to: "not-an-address" }), ev)).toBeNull();
  });
});

describe("classifySentOrigin: order and default", () => {
  it("approved beats auto_reply beats unsubscribe, like the SQL's statement order", () => {
    const all = evidence({
      ...claimEvidence(),
      approvalResults: ['{"messageId":"g1"}'],
      unsubscribeMailtos: ["mailto:sarah@acme.com?subject=Re%3A%20Contract"],
    });
    expect(classifySentOrigin(row(), all)).toBe("approved");
    expect(classifySentOrigin(row(), { ...all, approvalResults: [] })).toBe("auto_reply");
    expect(classifySentOrigin(row(), { ...all, approvalResults: [], claims: [] })).toBe(
      "unsubscribe",
    );
  });

  it("is null (the user's own mail) with no Klorn evidence, and never 'user'", () => {
    expect(classifySentOrigin(row(), evidence())).toBeNull();
  });
});

describe("classifySentRows: bounded evidence loading", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    state.outboxResults = [];
    state.pendingResults = [];
    state.claims = [];
    state.sources = [];
    state.mailtos = [];
    state.senders = new Set();
  });

  const rows = [
    row({ gmailId: "g1" }),
    row({ gmailId: "g2", to: "unsub@list.com", subject: "unsubscribe", sentAt: minutes(60) }),
    row({ gmailId: "g3", to: "friend@x.com", subject: "Dinner", sentAt: minutes(90) }),
  ];

  it("returns labels only for Klorn's own mail", async () => {
    state.claims = [settledClaim];
    state.sources = [{ gmailId: "src1", subject: "Contract" }];
    state.mailtos = [{ listUnsubscribeMailto: "mailto:unsub@list.com" }];
    const out = await classifySentRows("u1", rows);
    expect([...out.entries()]).toEqual([
      ["g1", "auto_reply"],
      ["g2", "unsubscribe"],
    ]);
  });

  it("issues a fixed number of queries for the whole batch, never one per message", async () => {
    state.claims = [settledClaim];
    state.sources = [{ gmailId: "src1", subject: "Contract" }];
    state.mailtos = [{ listUnsubscribeMailto: "mailto:unsub@list.com" }];
    await classifySentRows("u1", rows);
    expect(prisma.actionOutbox.findMany).toHaveBeenCalledTimes(1);
    expect(prisma.pendingAction.findMany).toHaveBeenCalledTimes(1);
    expect(prisma.notification.findMany).toHaveBeenCalledTimes(1);
    // One for the claimed sources, one for the mailto targets.
    expect(prisma.emailMessage.findMany).toHaveBeenCalledTimes(2);
    // Sender check only for the one address that matched a mailto target.
    expect(prisma.emailMessage.findFirst).toHaveBeenCalledTimes(1);
  });

  it("scopes every query to the user and the batch", async () => {
    await classifySentRows("u1", [...rows, row({ gmailId: "g_4", sentAt: minutes(4) })]);
    const outbox = vi.mocked(prisma.actionOutbox.findMany).mock.calls[0]?.[0] as {
      where: Record<string, unknown> & { OR: { result: { contains: string } }[] };
    };
    expect(outbox.where).toMatchObject({
      userId: "u1",
      toolName: "send_email",
      status: "COMPLETED",
    });
    // LIKE-escaped: the "_" in g_4 is a literal, not a wildcard.
    expect(outbox.where.OR.map((c) => c.result.contains)).toEqual([
      '"messageId":"g1"',
      '"messageId":"g2"',
      '"messageId":"g3"',
      '"messageId":"g\\_4"',
    ]);
    const pending = vi.mocked(prisma.pendingAction.findMany).mock.calls[0]?.[0] as {
      where: Record<string, unknown>;
    };
    expect(pending.where).toMatchObject({
      userId: "u1",
      toolName: "send_email",
      status: "EXECUTED",
    });
    const claims = vi.mocked(prisma.notification.findMany).mock.calls[0]?.[0] as {
      where: { userId: string; AND: { OR: { createdAt?: { gte: Date; lte: Date } }[] }[] };
    };
    expect(claims.where.userId).toBe("u1");
    expect(claims.where).toMatchObject({
      title: { notIn: ["Auto-reply failed", "Auto-mode reply failed"] },
    });
    // The send window [claim - 1 min, claim + 2 min] read from the claim side:
    // createdAt in [sentAt - 2 min, sentAt + 1 min]. Overlapping windows merge
    // (g1 at 2 min and g_4 at 4 min); g2 and g3 (60 and 90 min) stay apart.
    const windows = claims.where.AND[1]?.OR.map((c) => c.createdAt);
    expect(windows).toEqual([
      { gte: minutes(2 - 2), lte: minutes(4 + 1) },
      { gte: minutes(60 - 2), lte: minutes(60 + 1) },
      { gte: minutes(90 - 2), lte: minutes(90 + 1) },
    ]);
  });

  it("skips the source and sender lookups when nothing could match", async () => {
    await classifySentRows("u1", rows);
    // Only the mailto-target query; no claims means no source query.
    expect(prisma.emailMessage.findMany).toHaveBeenCalledTimes(1);
    expect(prisma.emailMessage.findFirst).not.toHaveBeenCalled();
  });

  it("makes no query for an empty batch", async () => {
    expect((await classifySentRows("u1", [])).size).toBe(0);
    expect(prisma.actionOutbox.findMany).not.toHaveBeenCalled();
    expect(prisma.notification.findMany).not.toHaveBeenCalled();
    expect(prisma.emailMessage.findMany).not.toHaveBeenCalled();
  });
});
