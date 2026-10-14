/**
 * GET /api/inbox/firewall — the account, read state and attachment flag on
 * every mail preview (`item.email.source` / `.unread` / `.hasAttachment`).
 *
 * The unified list promises a source badge on every row (productization plan
 * §1). These facts ride on the email preview the route already builds, from
 * the EmailMessage rows it already fetches, plus two page-bounded lookups:
 * the linked accounts (none at all when every mail is on the primary) and
 * the attachments of exactly this page's mail. Never a query per item.
 */

import Fastify from "fastify";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../mail/activity-sync.js", () => ({
  ensureRecentMailSync: vi.fn(async () => {}),
}));

const SURFACED = new Date("2026-07-20T00:00:00Z");

function attention(id: string, source: string, sourceId: string) {
  return {
    id,
    source,
    sourceId,
    type: "REPLY_NEEDED",
    title: id,
    tier: "QUEUE",
    tierReason: "fixture",
    priority: 50,
    surfacedAt: SURFACED,
    inputHash: null,
    agentTierSetAt: null,
    isManualOverride: false,
  };
}

function email(
  id: string,
  linkedInboxAccountId: string | null,
  extra: { isRead?: boolean; attachments?: number; userId?: string } = {},
) {
  return {
    id,
    userId: extra.userId ?? "user-1",
    gmailId: `g-${id}`,
    subject: id,
    from: `${id}@example.com`,
    snippet: "hi",
    labels: ["INBOX"],
    threadId: `t-${id}`,
    receivedAt: SURFACED,
    category: null,
    needsReply: false,
    repliedAt: null,
    proactiveDraft: null,
    linkedInboxAccountId,
    isRead: extra.isRead ?? false,
    attachments: extra.attachments ?? 0,
  };
}

const state = {
  attention: [] as ReturnType<typeof attention>[],
  emails: [] as ReturnType<typeof email>[],
  pendingActions: [] as Array<{ id: string; toolName: string; toolArgs: unknown }>,
  accounts: [] as Array<{ id: string; userId: string; provider: string; email: string }>,
  ownerEmail: "me@company.example" as string | null,
};

interface EmailWhere {
  userId: string;
  id?: { in: string[] };
  gmailId?: { in: string[] };
}

const emailFindMany = vi.fn(async ({ where }: { where: EmailWhere }) =>
  state.emails.filter(
    (e) =>
      e.userId === where.userId &&
      ((where.id?.in?.includes(e.id) ?? false) ||
        (where.gmailId?.in?.includes(e.gmailId) ?? false)),
  ),
);

const accountFindMany = vi.fn(
  async ({ where }: { where: { userId: string; id: { in: string[] } } }) =>
    state.accounts
      .filter((a) => a.userId === where.userId && where.id.in.includes(a.id))
      .map(({ id, provider, email: address }) => ({ id, provider, email: address })),
);

interface AttachmentWhere {
  userId: string;
  emailId: { in: string[] };
  NOT: unknown;
}

// Stands in for the grouped lookup: one row per mail that has a file.
const attachmentGroupBy = vi.fn(async ({ where }: { where: AttachmentWhere }) =>
  state.emails
    .filter(
      (e) => e.userId === where.userId && where.emailId.in.includes(e.id) && e.attachments > 0,
    )
    .map((e) => ({ emailId: e.id })),
);

vi.mock("../db.js", () => ({
  prisma: {
    attentionItem: { findMany: vi.fn(async () => state.attention) },
    pendingAction: { findMany: vi.fn(async () => state.pendingActions) },
    emailMessage: { findMany: emailFindMany },
    linkedInboxAccount: { findMany: accountFindMany },
    emailAttachment: { groupBy: attachmentGroupBy },
    contactEngagementScore: { findMany: vi.fn(async () => []) },
    user: {
      findUnique: vi.fn(async () => ({ companyDomains: [], email: state.ownerEmail })),
    },
  },
}));

vi.mock("../auth.js", () => ({
  resolveEffectiveJwtSecret: () => "test-secret",
  requireAuth: vi.fn(async () => {}),
  getUserId: vi.fn(() => "user-1"),
}));
vi.mock("../sentry.js", () => ({ captureError: vi.fn() }));
vi.mock("../mail/gmail.js", () => ({ ensureFreshGmailWatch: vi.fn(async () => {}) }));
vi.mock("../learning/trust-score.js", () => ({
  getTrustScoresBulk: vi.fn(async () => new Map()),
}));
vi.mock("../mail/sender-labels.js", () => ({ senderLabelsFor: vi.fn(async () => new Map()) }));
vi.mock("../notify/notification-strings.js", () => ({
  getUserNotificationLanguage: vi.fn(async () => "en"),
}));

const { firewallRoutes } = await import("../routes/firewall.js");

interface SourceWire {
  provider: string;
  accountId: string | null;
  label: string;
}
interface ItemWire {
  id: string;
  source: string;
  email?: {
    emailDbId: string;
    source?: SourceWire | null;
    unread?: boolean | null;
    hasAttachment?: boolean | null;
  };
}

async function fetchItems(): Promise<Map<string, ItemWire>> {
  const app = Fastify();
  await app.register(firewallRoutes, { prefix: "/api/inbox/firewall" });
  const res = await app.inject({ method: "GET", url: "/api/inbox/firewall/" });
  await app.close();
  expect(res.statusCode).toBe(200);
  const body = res.json() as { tiers: Record<string, ItemWire[]> };
  return new Map(
    Object.values(body.tiers)
      .flat()
      .map((item) => [item.id, item]),
  );
}

beforeEach(() => {
  state.attention = [];
  state.emails = [];
  state.pendingActions = [];
  state.accounts = [];
  state.ownerEmail = "me@company.example";
  emailFindMany.mockClear();
  accountFindMany.mockClear();
  attachmentGroupBy.mockClear();
});

describe("GET /api/inbox/firewall — account, read state and attachment on the preview", () => {
  it("names the primary account as Google with the user's own address", async () => {
    state.attention = [attention("a1", "EMAIL", "m1")];
    state.emails = [email("m1", null)];
    const items = await fetchItems();
    expect(items.get("a1")?.email?.source).toEqual({
      provider: "GOOGLE",
      accountId: null,
      label: "me@company.example",
    });
  });

  it("makes no account lookup when every mail is on the primary account", async () => {
    state.attention = [attention("a1", "EMAIL", "m1"), attention("a2", "EMAIL", "m2")];
    state.emails = [email("m1", null), email("m2", null)];
    await fetchItems();
    expect(accountFindMany).not.toHaveBeenCalled();
  });

  it.each([
    "GOOGLE",
    "OUTLOOK",
    "NAVER",
    "ICLOUD",
    "IMAP",
  ])("names a linked %s account by its id, provider and address", async (provider) => {
    state.attention = [attention("a1", "EMAIL", "m1")];
    state.emails = [email("m1", "li-1")];
    state.accounts = [{ id: "li-1", userId: "user-1", provider, email: "side@acct.example" }];
    const items = await fetchItems();
    expect(items.get("a1")?.email?.source).toEqual({
      provider,
      accountId: "li-1",
      label: "side@acct.example",
    });
  });

  it("resolves every linked account in one batched lookup, whatever the row count", async () => {
    const ids = ["m1", "m2", "m3", "m4", "m5", "m6"];
    state.attention = ids.map((id) => attention(`a-${id}`, "EMAIL", id));
    state.emails = ids.map((id, i) => email(id, i % 2 === 0 ? "li-1" : "li-2"));
    state.accounts = [
      { id: "li-1", userId: "user-1", provider: "NAVER", email: "n@naver.example" },
      { id: "li-2", userId: "user-1", provider: "ICLOUD", email: "i@icloud.example" },
    ];
    const items = await fetchItems();
    expect(accountFindMany).toHaveBeenCalledTimes(1);
    expect(emailFindMany).toHaveBeenCalledTimes(1);
    const [{ where }] = accountFindMany.mock.calls[0];
    expect(where.userId).toBe("user-1");
    expect([...where.id.in].sort()).toEqual(["li-1", "li-2"]);
    expect(items.get("a-m1")?.email?.source?.provider).toBe("NAVER");
    expect(items.get("a-m2")?.email?.source?.provider).toBe("ICLOUD");
  });

  it("claims no account when the linked account row is gone", async () => {
    state.attention = [attention("a1", "EMAIL", "m1")];
    state.emails = [email("m1", "li-deleted")];
    const items = await fetchItems();
    expect(items.get("a1")?.email).toBeDefined();
    expect(items.get("a1")?.email?.source).toBeNull();
  });

  it("never resolves another user's account, even on a matching id", async () => {
    state.attention = [attention("a1", "EMAIL", "m1")];
    state.emails = [email("m1", "li-1")];
    state.accounts = [
      { id: "li-1", userId: "user-2", provider: "NAVER", email: "theirs@naver.example" },
    ];
    const items = await fetchItems();
    expect(items.get("a1")?.email?.source).toBeNull();
    expect(JSON.stringify([...items.values()])).not.toContain("theirs@naver.example");
  });

  it("never previews another user's mail, even on a matching id", async () => {
    state.attention = [attention("a1", "EMAIL", "m1")];
    state.emails = [email("m1", null, { userId: "user-2" })];
    const items = await fetchItems();
    expect(items.get("a1")).toBeDefined();
    expect(items.get("a1")?.email).toBeUndefined();
  });

  it("claims no account for the primary when the user's address is unknown", async () => {
    state.ownerEmail = null;
    state.attention = [attention("a1", "EMAIL", "m1")];
    state.emails = [email("m1", null)];
    const items = await fetchItems();
    expect(items.get("a1")?.email?.source).toBeNull();
  });

  it("answers with no linked accounts, not an error, when the account lookup fails", async () => {
    accountFindMany.mockRejectedValueOnce(new Error("db down"));
    state.attention = [attention("a1", "EMAIL", "m1"), attention("a2", "EMAIL", "m2")];
    state.emails = [email("m1", "li-1"), email("m2", null)];
    const items = await fetchItems();
    expect(items.get("a1")?.email?.source).toBeNull();
    expect(items.get("a2")?.email?.source?.provider).toBe("GOOGLE");
  });

  it("maps the read flag and the attachment count", async () => {
    state.attention = [attention("a1", "EMAIL", "m1"), attention("a2", "EMAIL", "m2")];
    state.emails = [
      email("m1", null, { isRead: false, attachments: 2 }),
      email("m2", null, { isRead: true, attachments: 0 }),
    ];
    const items = await fetchItems();
    expect(items.get("a1")?.email).toMatchObject({ unread: true, hasAttachment: true });
    expect(items.get("a2")?.email).toMatchObject({ unread: false, hasAttachment: false });
  });

  it("reads the read flag in the mail lookup itself, and no per-row attachment count", async () => {
    state.attention = [attention("a1", "EMAIL", "m1")];
    state.emails = [email("m1", null)];
    await fetchItems();
    const [{ select }] = emailFindMany.mock.calls[0] as unknown as [
      { select: { isRead?: boolean; _count?: unknown } },
    ];
    expect(select.isRead).toBe(true);
    // An unbounded aggregate over every attachment: see firewall-account-facts.ts.
    expect(select._count).toBeUndefined();
  });

  it("looks attachments up once, bounded to this page's mail and this user", async () => {
    const ids = ["m1", "m2", "m3", "m4", "m5", "m6"];
    state.attention = ids.map((id) => attention(`a-${id}`, "EMAIL", id));
    state.emails = ids.map((id, i) => email(id, null, { attachments: i % 2 }));
    const items = await fetchItems();
    expect(attachmentGroupBy).toHaveBeenCalledTimes(1);
    const [args] = attachmentGroupBy.mock.calls[0] as unknown as [
      { by: string[]; where: AttachmentWhere },
    ];
    expect(args.by).toEqual(["emailId"]);
    expect(args.where.userId).toBe("user-1");
    expect([...args.where.emailId.in].sort()).toEqual(ids);
    // An inline image is not an attachment, whatever the case of its type.
    expect(args.where.NOT).toEqual({
      AND: [
        { contentId: { not: null } },
        { mimeType: { startsWith: "image/", mode: "insensitive" } },
      ],
    });
    expect(items.get("a-m1")?.email?.hasAttachment).toBe(false);
    expect(items.get("a-m2")?.email?.hasAttachment).toBe(true);
  });

  it("costs two lookups beyond the mail fetch at most, whatever the row count", async () => {
    const ids = ["m1", "m2", "m3", "m4", "m5", "m6", "m7", "m8"];
    state.attention = ids.map((id) => attention(`a-${id}`, "EMAIL", id));
    state.emails = ids.map((id, i) => email(id, i % 2 === 0 ? "li-1" : null, { attachments: 1 }));
    state.accounts = [{ id: "li-1", userId: "user-1", provider: "NAVER", email: "n@n.example" }];
    await fetchItems();
    expect(emailFindMany).toHaveBeenCalledTimes(1);
    expect(accountFindMany).toHaveBeenCalledTimes(1);
    expect(attachmentGroupBy).toHaveBeenCalledTimes(1);
  });

  it("makes no attachment lookup when the page holds no mail", async () => {
    state.attention = [attention("a1", "COMMITMENT", "c1"), attention("a2", "EMAIL", "missing")];
    await fetchItems();
    expect(attachmentGroupBy).not.toHaveBeenCalled();
    expect(accountFindMany).not.toHaveBeenCalled();
  });

  it("claims nothing about attachments, not an error, when that lookup fails", async () => {
    attachmentGroupBy.mockRejectedValueOnce(new Error("db down"));
    state.attention = [attention("a1", "EMAIL", "m1")];
    state.emails = [email("m1", null, { isRead: false, attachments: 3 })];
    const items = await fetchItems();
    expect(items.get("a1")?.email).toMatchObject({ unread: true, hasAttachment: null });
    expect(items.get("a1")?.email?.source?.provider).toBe("GOOGLE");
  });

  it("never counts another user's attachment, even on a matching mail id", async () => {
    state.attention = [attention("a1", "EMAIL", "m1")];
    state.emails = [
      email("m1", null),
      { ...email("m1", null, { attachments: 2 }), userId: "user-2" },
    ];
    const items = await fetchItems();
    expect(items.get("a1")?.email?.hasAttachment).toBe(false);
  });

  it("leaves an item without mail as it was: no preview, no account", async () => {
    state.attention = [attention("a1", "COMMITMENT", "c1"), attention("a2", "EMAIL", "missing")];
    const items = await fetchItems();
    expect(items.get("a1")).toEqual({
      id: "a1",
      source: "COMMITMENT",
      sourceId: "c1",
      type: "REPLY_NEEDED",
      title: "a1",
      tier: "QUEUE",
      tierReason: "fixture",
      priority: 50,
      surfacedAt: SURFACED.toISOString(),
    });
    expect(items.get("a2")?.email).toBeUndefined();
    // The item's own `source` stays the string it always was.
    expect(items.get("a2")?.source).toBe("EMAIL");
  });

  it("carries the same facts on a pending action that points at a mail", async () => {
    state.attention = [attention("a1", "PENDING_ACTION", "pa-1")];
    state.pendingActions = [
      { id: "pa-1", toolName: "archive_email", toolArgs: { email_id: "g-m1" } },
    ];
    state.emails = [email("m1", "li-1", { isRead: true, attachments: 1 })];
    state.accounts = [
      { id: "li-1", userId: "user-1", provider: "OUTLOOK", email: "w@outlook.example" },
    ];
    const items = await fetchItems();
    expect(items.get("a1")?.email).toMatchObject({
      source: { provider: "OUTLOOK", accountId: "li-1", label: "w@outlook.example" },
      unread: false,
      hasAttachment: true,
    });
    expect(accountFindMany).toHaveBeenCalledTimes(1);
    expect(attachmentGroupBy).toHaveBeenCalledTimes(1);
  });
});
