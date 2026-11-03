/**
 * Provenance for SentMessage rows the Sent-folder scan or the history import
 * CREATES (docs/design/attention-engine-v3.md §3(2)). The rules mirror the
 * legacy SQL backfill (migration 20261101000000_sent_message_origin_backfill,
 * cases from sent-origin-backfill-pg.test.ts): approved → auto_reply →
 * unsubscribe → null. Null is "no proof that Klorn sent it" and counts as the
 * user's own mail, so a miss here turns Klorn's mail into relationship evidence.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
  outboxResults: [] as { result: string | null }[],
  pendingResults: [] as { result: string | null }[],
  claims: [] as { dedupeKey: string | null; title: string; message: string; createdAt: Date }[],
  sources: [] as { gmailId: string; subject: string }[],
  recordedSent: [] as { gmailId: string; to: string; subject: string; sentAt: Date }[],
  carriers: [] as {
    listUnsubscribeMailto: string | null;
    linkedInboxAccountId: string | null;
    _min: { receivedAt: Date | null };
  }[],
  senders: new Set<string>(),
  inFlight: 0,
  maxInFlight: 0,
}));

vi.mock("../db.js", () => {
  // Every query goes through `tracked`, so a test can see the loaders never
  // hold more than one pool connection at a time.
  const tracked =
    <A extends unknown[], T>(read: (...args: A) => T) =>
    async (...args: A) => {
      state.inFlight += 1;
      state.maxInFlight = Math.max(state.maxInFlight, state.inFlight);
      await new Promise((resolve) => setTimeout(resolve, 1));
      state.inFlight -= 1;
      return read(...args);
    };
  return {
    prisma: {
      actionOutbox: { findMany: vi.fn(tracked(() => state.outboxResults)) },
      pendingAction: { findMany: vi.fn(tracked(() => state.pendingResults)) },
      notification: { findMany: vi.fn(tracked(() => state.claims)) },
      sentMessage: { findMany: vi.fn(tracked(() => state.recordedSent)) },
      emailMessage: {
        findMany: vi.fn(tracked(() => state.sources)),
        groupBy: vi.fn(tracked(() => state.carriers)),
      },
      // The sender check: one query for every token target address.
      $queryRaw: vi.fn(
        tracked((_sql: TemplateStringsArray, addrs: string[]) =>
          addrs.filter((a) => state.senders.has(a)).map((addr) => ({ addr })),
        ),
      ),
    },
  };
});

import { prisma } from "../db.js";
import {
  type ClassifiableSentRow,
  claimRecipient,
  claimSourceGmailId,
  classifySentOrigin,
  classifySentRows,
  extractApprovedMessageId,
  indexUnsubscribeTargets,
  provenanceMailtoTarget,
  type SentOriginEvidence,
  sqlBtrim,
  type UnsubscribeTarget,
} from "../mail/sent-origin-classifier.js";
import { expectLinear, repeatTo } from "./helpers/linear-timing.js";

const CLAIM_AT = new Date("2026-05-10T09:00:00.000Z");
const minutes = (n: number) => new Date(CLAIM_AT.getTime() + n * 60_000);

/** Evidence as the loader builds it; targets go through the same index. */
function evidence(
  over: Partial<SentOriginEvidence> & { unsubscribeTargets?: UnsubscribeTarget[] } = {},
): SentOriginEvidence {
  const { unsubscribeTargets, ...rest } = over;
  return {
    approvalResults: [],
    claims: [],
    sourceSubjects: new Map(),
    sentNeighbours: [],
    unsubscribe: indexUnsubscribeTargets([]),
    senderAddresses: new Set(),
    ...rest,
    ...(unsubscribeTargets ? { unsubscribe: indexUnsubscribeTargets(unsubscribeTargets) } : {}),
  };
}

function row(over: Partial<ClassifiableSentRow> = {}): ClassifiableSentRow {
  return {
    gmailId: "g1",
    to: "sarah@acme.com",
    subject: "Re: Contract",
    sentAt: minutes(1),
    inbox: "primary",
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
const neighbour = (over: Partial<SentOriginEvidence["sentNeighbours"][number]> = {}) => ({
  gmailId: "g0",
  to: "sarah@acme.com",
  subject: "Re: Contract",
  sentAt: minutes(0.5),
  recorded: true,
  ...over,
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

describe("provenanceMailtoTarget (the SQL's addr and subject, exactly)", () => {
  const t = provenanceMailtoTarget;

  it("addr: strips mailto: (any case), cuts at ?, trims spaces, lowercases, never decodes", () => {
    expect(t("MAILTO: Unsub@List.Example ?subject=x").addr).toBe("unsub@list.example");
    expect(t("mailto:a%40b.example").addr).toBe("a%40b.example");
    expect(t("x@y.example").addr).toBe("x@y.example");
    expect(t("mailto:x@y.example#frag").addr).toBe("x@y.example#frag");
    expect(t("mailto:not-an-address").addr).toBe("not-an-address");
  });

  it("subject: the first subject= value up to & or #, + as space, ASCII %XX decoded", () => {
    expect(t("mailto:a@b.c?subject=remove+%3Cme%3E").subject).toBe("remove <me>");
    expect(t("mailto:a@b.c?body=x&subject=hi&subject=no").subject).toBe("hi");
    expect(t("mailto:a@b.c?subject=bye#frag").subject).toBe("bye");
    expect(t("mailto:a@b.c?subject=caf%C3%A9").subject).toBe("caf%C3%A9");
    expect(t("mailto:a@b.c?subject=a%00b").subject).toBe("a%00b");
    expect(t("mailto:a@b.c?subject=%%41%4").subject).toBe("%A%4");
    expect(t("mailto:a@b.c?subject=%7e%7E").subject).toBe("~~");
  });

  it("subject: trimmed, and 'unsubscribe' when missing or empty", () => {
    expect(t("mailto:a@b.c?subject=%20%09hi%0A").subject).toBe("hi");
    expect(t("mailto:a@b.c").subject).toBe("unsubscribe");
    expect(t("mailto:a@b.c?subject=").subject).toBe("unsubscribe");
    expect(t("mailto:a@b.c?subject=%20+%20").subject).toBe("unsubscribe");
    // The parameter name is case-sensitive, as in the SQL pattern.
    expect(t("mailto:a@b.c?Subject=hi").subject).toBe("unsubscribe");
  });

  it("keeps a subject over parseMailtoTarget's 250-character cap", () => {
    expect(t(`mailto:a@b.c?subject=${"x".repeat(300)}`).subject).toHaveLength(300);
  });

  it("stays linear on a crafted target", () => {
    expectLinear((n) => repeatTo(n, "%", "mailto:", "?subject=%"), t);
    expectLinear((n) => repeatTo(n, "%2", "mailto:a@b.c?subject="), t);
  });
});

describe("sqlBtrim (Postgres btrim: spaces only)", () => {
  it("trims spaces at both ends and nothing else", () => {
    expect(sqlBtrim("  a b  ")).toBe("a b");
    expect(sqlBtrim("\ta\t")).toBe("\ta\t");
    expect(sqlBtrim("    ")).toBe("");
  });

  it("is linear on a long run of interior spaces (H1)", () => {
    expectLinear((n) => repeatTo(n, " ", "a", "b"), sqlBtrim);
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
    expect(classifySentOrigin(row({ sentAt: minutes(5) }), claimEvidence())).toBeNull();
  });

  it("skips a failed claim: nothing was sent, so a manual Re: right after it stays null", () => {
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

  describe("one row per claim: only the earliest match counts", () => {
    it("a reply after an earlier recorded match in the window stays null (the user's own)", () => {
      const ev = { ...claimEvidence(), sentNeighbours: [neighbour()] };
      expect(classifySentOrigin(row(), ev)).toBeNull();
    });

    it("the earlier row in the same batch wins over the later one", () => {
      const first = row({ gmailId: "a", sentAt: minutes(0.2) });
      const later = row({ gmailId: "b", sentAt: minutes(1) });
      const batch = [first, later].map((r) => ({ ...r, recorded: false }));
      const ev = { ...claimEvidence(), sentNeighbours: batch };
      expect(classifySentOrigin(first, ev)).toBe("auto_reply");
      expect(classifySentOrigin(later, ev)).toBeNull();
    });

    it("only rows with the same recipient and subject inside the claim's window count as earlier", () => {
      for (const other of [
        neighbour({ to: "someone@else.com" }),
        neighbour({ subject: "Re: Other" }),
        neighbour({ sentAt: minutes(-3) }),
        neighbour({ sentAt: minutes(1.5) }),
      ]) {
        expect(classifySentOrigin(row(), { ...claimEvidence(), sentNeighbours: [other] })).toBe(
          "auto_reply",
        );
      }
    });

    it("breaks a same-instant tie: a recorded row first, then gmailId order", () => {
      const at = minutes(1);
      const tie = (over: object) => ({
        ...claimEvidence(),
        sentNeighbours: [neighbour({ sentAt: at, ...over })],
      });
      expect(classifySentOrigin(row({ gmailId: "m" }), tie({ recorded: true }))).toBeNull();
      expect(
        classifySentOrigin(row({ gmailId: "m" }), tie({ gmailId: "a", recorded: false })),
      ).toBeNull();
      expect(
        classifySentOrigin(row({ gmailId: "m" }), tie({ gmailId: "z", recorded: false })),
      ).toBe("auto_reply");
      // The row itself, listed among the batch, is never "earlier" than itself.
      expect(
        classifySentOrigin(row({ gmailId: "m" }), tie({ gmailId: "m", recorded: false })),
      ).toBe("auto_reply");
    });
  });
});

describe("classifySentOrigin: unsubscribe", () => {
  // Targets reach the rule parsed once at load, the way the SQL derives them.
  const carrier = (mailto: string, over: object = {}) => ({
    ...provenanceMailtoTarget(mailto),
    inbox: "primary",
    firstReceivedAt: minutes(-60),
    ...over,
  });
  const ev = (mailto: string, over: Partial<SentOriginEvidence> = {}) =>
    evidence({ unsubscribeTargets: [carrier(mailto)], ...over });

  it("labels a send to the target with the decoded mailto subject", () => {
    const out = classifySentOrigin(
      row({ to: "Unsub@List.example", subject: "remove <me>" }),
      ev("mailto:Unsub@List.example?subject=remove+%3Cme%3E"),
    );
    expect(out).toBe("unsubscribe");
  });

  it("defaults the subject to 'unsubscribe' like the SQL", () => {
    expect(
      classifySentOrigin(
        row({ to: "leave@x.com", subject: "unsubscribe" }),
        ev("mailto:leave@x.com"),
      ),
    ).toBe("unsubscribe");
  });

  it("needs the carrier in the same inbox, received before the send", () => {
    const mailto = "mailto:unsub@list.example?subject=remove";
    const r = row({ to: "unsub@list.example", subject: "remove" });
    expect(
      classifySentOrigin(r, evidence({ unsubscribeTargets: [carrier(mailto, { inbox: "L1" })] })),
    ).toBeNull();
    expect(
      classifySentOrigin(
        r,
        evidence({ unsubscribeTargets: [carrier(mailto, { firstReceivedAt: minutes(5) })] }),
      ),
    ).toBeNull();
    expect(
      classifySentOrigin(
        { ...r, inbox: "L1" },
        evidence({ unsubscribeTargets: [carrier(mailto, { inbox: "L1" })] }),
      ),
    ).toBe("unsubscribe");
    // Received at the very instant of the send still counts (sentAt >= receivedAt).
    expect(
      classifySentOrigin(
        r,
        evidence({ unsubscribeTargets: [carrier(mailto, { firstReceivedAt: r.sentAt })] }),
      ),
    ).toBe("unsubscribe");
  });

  it("labels a same-shape per-mail token subject to an endpoint that never mails the user", () => {
    const out = classifySentOrigin(
      row({ to: "u@lists.example", subject: "unsub-ZzYyXx9876543210AbC" }),
      ev("mailto:u@lists.example?subject=unsub-AbCdEf0123456789XyZ"),
    );
    expect(out).toBe("unsubscribe");
  });

  it("a token subject is not enough when the address also mails the user", () => {
    const out = classifySentOrigin(
      row({ to: "u@lists.example", subject: "unsub-ZzYyXx9876543210AbC" }),
      ev("mailto:u@lists.example?subject=unsub-AbCdEf0123456789XyZ", {
        senderAddresses: new Set(["u@lists.example"]),
      }),
    );
    expect(out).toBeNull();
  });

  it("a token subject needs the same shape and 16+ letters or digits", () => {
    const target = "mailto:u@lists.example?subject=unsub-AbCdEf0123456789XyZ";
    expect(
      classifySentOrigin(
        row({ to: "u@lists.example", subject: "unsub_ZzYyXx9876543210AbC" }),
        ev(target),
      ),
    ).toBeNull();
    expect(
      classifySentOrigin(
        row({ to: "u@lists.example", subject: "unsub-ZzYyXx9876543210Ab" }),
        ev(target),
      ),
    ).toBeNull();
    // 15 letters/digits is not a token.
    const short = "mailto:u@lists.example?subject=AbCdEfGhIj12345";
    expect(
      classifySentOrigin(row({ to: "u@lists.example", subject: "ZzYyXxWwVv98765" }), ev(short)),
    ).toBeNull();
  });

  it("leaves the user's own note to a real mailbox a newsletter names as its target", () => {
    const out = classifySentOrigin(
      row({ to: "info@brand.example", subject: "Question about order 123" }),
      ev("mailto:info@brand.example?subject=Unsubscribe"),
    );
    expect(out).toBeNull();
  });

  it("needs the recipient to be exactly that one address", () => {
    const mailto = "mailto:unsub@list.example";
    const subject = "unsubscribe";
    expect(
      classifySentOrigin(row({ to: "List <unsub@list.example>", subject }), ev(mailto)),
    ).toBeNull();
    expect(
      classifySentOrigin(row({ to: "unsub@list.example, a@b.com", subject }), ev(mailto)),
    ).toBeNull();
    expect(classifySentOrigin(row({ to: "", subject }), ev(mailto))).toBeNull();
  });

  it("labels a target parseMailtoTarget would reject (send-side caps), like the SQL", () => {
    expect(
      classifySentOrigin(
        row({ to: "not-an-address", subject: "unsubscribe" }),
        ev("mailto:not-an-address"),
      ),
    ).toBe("unsubscribe");
    const long = "a".repeat(300);
    expect(
      classifySentOrigin(
        row({ to: "u@lists.example", subject: long }),
        ev(`mailto:u@lists.example?subject=${long}`),
      ),
    ).toBe("unsubscribe");
  });

  it("reads only the first 1,024 characters of a recipient, the length stored", () => {
    const ev1 = ev("mailto:unsub@list.example");
    const padded = `unsub@list.example${" ".repeat(2_000)}x`;
    expect(classifySentOrigin(row({ to: padded, subject: "unsubscribe" }), ev1)).toBe(
      "unsubscribe",
    );
  });

  it("stays linear on a To with a huge run of interior spaces (H1)", () => {
    const ev1 = ev("mailto:unsub@list.example");
    expectLinear(
      (n) => repeatTo(n, " ", "a", "b@list.example"),
      (to) => classifySentOrigin(row({ to, subject: "unsubscribe" }), ev1),
    );
  });
});

describe("unsubscribe targets are indexed once (MEDIUM-1)", () => {
  const target = (subject: string, over: Partial<UnsubscribeTarget> = {}): UnsubscribeTarget => ({
    addr: "u@lists.example",
    subject,
    inbox: "primary",
    firstReceivedAt: minutes(-60),
    ...over,
  });

  it("keeps the earliest arrival of duplicate targets", () => {
    const r = row({ to: "u@lists.example", subject: "remove", sentAt: minutes(0) });
    const ev = evidence({
      unsubscribeTargets: [
        target("remove", { firstReceivedAt: minutes(30) }),
        target("remove", { firstReceivedAt: minutes(-30) }),
      ],
    });
    expect(classifySentOrigin(r, ev)).toBe("unsubscribe");
  });

  it("costs each row O(1) lookups: linear in the number of crafted targets", () => {
    // Every target shares the rows' address and carries a 2,000-character
    // token subject of a different shape: the worst case for a per-pair rule.
    const rows = Array.from({ length: 100 }, (_, i) =>
      row({ gmailId: `r${i}`, to: "u@lists.example", subject: `x-${"b".repeat(1_990)}${i}` }),
    );
    expectLinear(
      (bytes) => "t".repeat(Math.floor(bytes / 1_000)),
      (marker) => {
        const targets = Array.from({ length: marker.length }, (_, i) =>
          target(`${"a".repeat(1_990)}${i}`),
        );
        const ev = evidence({ unsubscribeTargets: targets });
        for (const r of rows) classifySentOrigin(r, ev);
      },
    );
  });
});

describe("both sides of every subject comparison are read as stored (LOW-2)", () => {
  const long = "S".repeat(1_100);

  it("an auto-reply to a source subject over 1,021 characters still matches", () => {
    const ev = evidence({
      claims: [settledClaim],
      sourceSubjects: new Map([["src1", long]]),
    });
    expect(classifySentOrigin(row({ subject: `Re: ${long}` }), ev)).toBe("auto_reply");
  });

  it("an earlier stored row with an over-long subject still counts as earlier", () => {
    const ev = {
      ...evidence({ claims: [settledClaim], sourceSubjects: new Map([["src1", long]]) }),
      sentNeighbours: [neighbour({ subject: `Re: ${long}` })],
    };
    expect(classifySentOrigin(row({ subject: `Re: ${long}` }), ev)).toBeNull();
  });

  it("a mailto subject over 1,024 characters still matches the stored subject", () => {
    const subject = "b".repeat(1_100);
    const ev = evidence({
      unsubscribeTargets: [
        { addr: "long@list.example", subject, inbox: "primary", firstReceivedAt: minutes(-60) },
      ],
    });
    expect(classifySentOrigin(row({ to: "long@list.example", subject }), ev)).toBe("unsubscribe");
  });
});

describe("classifySentOrigin: order and default", () => {
  it("approved beats auto_reply beats unsubscribe, like the SQL's statement order", () => {
    const all = evidence({
      ...claimEvidence(),
      approvalResults: ['{"messageId":"g1"}'],
      unsubscribeTargets: [
        {
          ...provenanceMailtoTarget("mailto:sarah@acme.com?subject=Re%3A%20Contract"),
          inbox: "primary",
          firstReceivedAt: minutes(-60),
        },
      ],
    });
    expect(classifySentOrigin(row(), all)).toBe("approved");
    expect(classifySentOrigin(row(), { ...all, approvalResults: [] })).toBe("auto_reply");
    expect(classifySentOrigin(row(), { ...all, approvalResults: [], claims: [] })).toBe(
      "unsubscribe",
    );
  });

  it("is null (no proof Klorn sent it) without evidence, and never 'user'", () => {
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
    state.recordedSent = [];
    state.carriers = [];
    state.senders = new Set();
    state.maxInFlight = 0;
  });

  const rows = [
    row({ gmailId: "g1" }),
    row({ gmailId: "g2", to: "unsub@list.com", subject: "unsubscribe", sentAt: minutes(60) }),
    row({ gmailId: "g3", to: "friend@x.com", subject: "Dinner", sentAt: minutes(90) }),
  ];
  const listCarrier = (mailto: string) => ({
    listUnsubscribeMailto: mailto,
    linkedInboxAccountId: null,
    _min: { receivedAt: minutes(-600) },
  });

  it("returns labels only for Klorn's own mail", async () => {
    state.claims = [settledClaim];
    state.sources = [{ gmailId: "src1", subject: "Contract" }];
    state.carriers = [listCarrier("mailto:unsub@list.com")];
    const out = await classifySentRows("u1", rows);
    expect([...out.entries()]).toEqual([
      ["g1", "auto_reply"],
      ["g2", "unsubscribe"],
    ]);
  });

  it("a recorded earlier match keeps the new row null", async () => {
    state.claims = [settledClaim];
    state.sources = [{ gmailId: "src1", subject: "Contract" }];
    state.recordedSent = [
      { gmailId: "g0", to: "sarah@acme.com", subject: "Re: Contract", sentAt: minutes(0.5) },
    ];
    expect((await classifySentRows("u1", [row()])).size).toBe(0);
    const recorded = vi.mocked(prisma.sentMessage.findMany).mock.calls[0]?.[0] as {
      where: { userId: string; OR: { sentAt: { gte: Date; lte: Date } }[] };
    };
    // The claim's own send window: [claim - 1 min, claim + 2 min].
    expect(recorded.where).toEqual({
      userId: "u1",
      OR: [{ sentAt: { gte: minutes(-1), lte: minutes(2) } }],
    });
  });

  it("issues a fixed number of queries for the whole batch, never one per message", async () => {
    state.claims = [settledClaim];
    state.sources = [{ gmailId: "src1", subject: "Contract" }];
    state.carriers = [
      listCarrier("mailto:unsub@list.com"),
      listCarrier("mailto:friend@x.com?subject=unsub-AbCdEf0123456789XyZ"),
    ];
    await classifySentRows("u1", rows);
    expect(prisma.actionOutbox.findMany).toHaveBeenCalledTimes(1);
    expect(prisma.pendingAction.findMany).toHaveBeenCalledTimes(1);
    expect(prisma.notification.findMany).toHaveBeenCalledTimes(1);
    expect(prisma.emailMessage.findMany).toHaveBeenCalledTimes(1);
    expect(prisma.sentMessage.findMany).toHaveBeenCalledTimes(1);
    expect(prisma.emailMessage.groupBy).toHaveBeenCalledTimes(1);
    // One sender check, for the one target whose subject is a token.
    expect(prisma.$queryRaw).toHaveBeenCalledTimes(1);
    expect(vi.mocked(prisma.$queryRaw).mock.calls[0]?.slice(1)).toEqual([["friend@x.com"], "u1"]);
  });

  it("runs its queries one at a time (the pool is small)", async () => {
    state.claims = [settledClaim];
    state.sources = [{ gmailId: "src1", subject: "Contract" }];
    state.carriers = [listCarrier("mailto:friend@x.com?subject=unsub-AbCdEf0123456789XyZ")];
    await classifySentRows("u1", rows);
    expect(state.maxInFlight).toBe(1);
  });

  it("checks every token target in one query, however many there are", async () => {
    const many = Array.from({ length: 40 }, (_, i) =>
      row({ gmailId: `t${i}`, to: `t${i}@lists.example`, subject: "x", sentAt: minutes(i) }),
    );
    state.carriers = many.map((r) =>
      listCarrier(`mailto:${r.to}?subject=unsub-AbCdEf0123456789XyZ`),
    );
    state.senders = new Set(["t3@lists.example"]);
    await classifySentRows("u1", many);
    expect(prisma.$queryRaw).toHaveBeenCalledTimes(1);
    expect(vi.mocked(prisma.$queryRaw).mock.calls[0]?.[1]).toHaveLength(40);
  });

  it("derives targets like the SQL: an encoded subject, a long subject, a loose address", async () => {
    const long = "a".repeat(300);
    state.carriers = [
      listCarrier("mailto:Unsub@List.example?subject=remove+%3Cme%3E"),
      listCarrier(`mailto:long@list.example?subject=${long}`),
      listCarrier("mailto:not-an-address"),
    ];
    const out = await classifySentRows("u1", [
      row({ gmailId: "a", to: "unsub@list.example", subject: "remove <me>" }),
      row({ gmailId: "b", to: "long@list.example", subject: long }),
      row({ gmailId: "c", to: "not-an-address", subject: "unsubscribe" }),
    ]);
    expect([...out.entries()]).toEqual([
      ["a", "unsubscribe"],
      ["b", "unsubscribe"],
      ["c", "unsubscribe"],
    ]);
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
    // createdAt in [sentAt - 2 min, sentAt + 1 min]. Overlapping windows merge
    // (g1 at 1 min and g_4 at 4 min); g2 and g3 (60 and 90 min) stay apart.
    const windows = claims.where.AND[1]?.OR.map((c) => c.createdAt);
    expect(windows).toEqual([
      { gte: minutes(1 - 2), lte: minutes(4 + 1) },
      { gte: minutes(60 - 2), lte: minutes(60 + 1) },
      { gte: minutes(90 - 2), lte: minutes(90 + 1) },
    ]);
    const carriers = vi.mocked(prisma.emailMessage.groupBy).mock.calls[0]?.[0] as unknown as {
      by: string[];
      where: { userId: string; OR: { listUnsubscribeMailto: { contains: string } }[] };
    };
    expect(carriers.by).toEqual(["listUnsubscribeMailto", "linkedInboxAccountId"]);
    expect(carriers.where.userId).toBe("u1");
    expect(carriers.where.OR.map((c) => c.listUnsubscribeMailto.contains)).toEqual([
      "sarah@acme.com",
      "unsub@list.com",
      "friend@x.com",
    ]);
  });

  it("skips the source, recorded-row and sender lookups when nothing could match", async () => {
    await classifySentRows("u1", rows);
    expect(prisma.emailMessage.findMany).not.toHaveBeenCalled();
    expect(prisma.sentMessage.findMany).not.toHaveBeenCalled();
    expect(prisma.$queryRaw).not.toHaveBeenCalled();
  });

  it("makes no query for an empty batch", async () => {
    expect((await classifySentRows("u1", [])).size).toBe(0);
    expect(prisma.actionOutbox.findMany).not.toHaveBeenCalled();
    expect(prisma.notification.findMany).not.toHaveBeenCalled();
    expect(prisma.emailMessage.groupBy).not.toHaveBeenCalled();
  });
});
