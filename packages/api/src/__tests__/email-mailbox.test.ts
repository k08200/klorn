/**
 * Mailbox listing — the Sent / Drafts / Archived folders every mail client
 * has and Klorn didn't (desktop shell restructure, 2026-08-26). The local
 * mirror is INBOX-only by design, so these are LIVE Gmail queries. Focus:
 * the box→query mapping (archived is a negative-space query and easy to get
 * wrong), metadata-only listing (no bodies, no attachment bytes), and the
 * route's demo/no-token fallback.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import { buildMailboxQuery, MAILBOXES } from "../mail/gmail-mailbox.js";

const state = vi.hoisted(() => ({
  listCalls: [] as Record<string, unknown>[],
  metaCalls: [] as Record<string, unknown>[],
  listIds: ["m1", "m2"],
  hasToken: true,
  draftRows: [
    { id: "draft-1", message: { id: "m-draft-1" } },
    { id: "draft-2", message: { id: "m-draft-2" } },
  ],
  draftDeletes: [] as string[],
  nextPageToken: null as string | null,
  // Multi-account (2026-09-04): every linked GOOGLE row the user has, keyed
  // by its LinkedInboxAccount id, each with its own page of ids + cursor.
  linked: {} as Record<string, { ids: string[]; nextPageToken: string | null }>,
  // internalDate per message id so a merged page can be checked for order.
  internalDates: {} as Record<string, string>,
  // Live inline images: the MIME tree a format:"full" get returns, and the
  // attachment bodies by id.
  fullPayload: null as Record<string, unknown> | null,
  attachmentData: {} as Record<string, string>,
  attachmentGets: [] as Record<string, unknown>[],
}));

vi.mock("../mail/gmail.js", () => ({
  getAuthedClient: vi.fn(async () => (state.hasToken ? { key: "primary" } : null)),
  getAuthedInboxClient: vi.fn(async (_userId: string, id: string) =>
    state.linked[id] ? { key: id } : null,
  ),
  getLinkedInboxClients: vi.fn(async () =>
    Object.keys(state.linked).map((id) => ({ client: { key: id }, id, email: `${id}@x.test` })),
  ),
}));

vi.mock("googleapis", () => ({
  google: {
    gmail: vi.fn(({ auth }: { auth: { key: string } }) => ({
      users: {
        messages: {
          list: vi.fn(async (params: Record<string, unknown>) => {
            state.listCalls.push({ ...params, account: auth.key });
            const page =
              auth.key === "primary"
                ? { ids: state.listIds, nextPageToken: state.nextPageToken }
                : state.linked[auth.key];
            return {
              data: {
                messages: page.ids.map((id) => ({ id })),
                nextPageToken: page.nextPageToken,
              },
            };
          }),
          attachments: {
            get: vi.fn(async (params: { messageId: string; id: string }) => {
              state.attachmentGets.push({ ...params, account: auth.key });
              return { data: { data: state.attachmentData[params.id] ?? null } };
            }),
          },
          get: vi.fn(async (params: Record<string, unknown>) => {
            if (params.format === "full") {
              return { data: { id: params.id, payload: state.fullPayload } };
            }
            state.metaCalls.push({ ...params, account: auth.key });
            return {
              data: {
                id: params.id,
                threadId: `t-${params.id}`,
                snippet: `snippet ${params.id}`,
                labelIds: ["SENT"],
                internalDate: state.internalDates[params.id as string] ?? "1756100000000",
                payload: {
                  headers: [
                    { name: "From", value: "me@klorn.ai" },
                    { name: "To", value: "you@example.com" },
                    { name: "Subject", value: `Subject ${params.id}` },
                    { name: "Date", value: "Tue, 26 Aug 2026 09:00:00 +0900" },
                  ],
                },
              },
            };
          }),
        },
        drafts: {
          list: vi.fn(async () => ({ data: { drafts: state.draftRows } })),
          delete: vi.fn(async (params: { id: string }) => {
            state.draftDeletes.push(params.id);
            return {};
          }),
        },
      },
    })),
    auth: { OAuth2: class {} },
  },
}));

describe("buildMailboxQuery", () => {
  it("maps each box to a Gmail search that cannot leak other folders", () => {
    expect(buildMailboxQuery("sent")).toBe("in:sent");
    expect(buildMailboxQuery("drafts")).toBe("in:draft");
    // Archived is negative space: everything that is in no folder at all.
    // Each exclusion matters — dropping -in:trash resurfaces deleted mail.
    expect(buildMailboxQuery("archived")).toBe(
      "-in:inbox -in:sent -in:draft -in:trash -in:spam -in:chats",
    );
  });

  it("MAILBOXES enumerates exactly the boxes the route accepts", () => {
    expect(MAILBOXES).toEqual(["sent", "drafts", "archived"]);
  });
});

describe("listGmailMailbox", () => {
  beforeEach(() => {
    state.listCalls.length = 0;
    state.metaCalls.length = 0;
    state.listIds = ["m1", "m2"];
    state.hasToken = true;
  });

  it("lists metadata-only — never bodies, never attachment bytes", async () => {
    const { listGmailMailbox } = await import("../mail/gmail-mailbox.js");
    const page = await listGmailMailbox("user-1", "sent");
    const items = page?.items ?? [];

    expect(state.listCalls).toHaveLength(1);
    expect(state.listCalls[0]).toMatchObject({ userId: "me", q: "in:sent" });
    // format=metadata is the contract: a 50-row folder list must not download
    // 50 full MIME trees. The metadata headers are the four the row renders.
    for (const call of state.metaCalls) {
      expect(call.format).toBe("metadata");
      expect(call.metadataHeaders).toEqual(["From", "To", "Subject", "Date"]);
    }
    expect(items).toHaveLength(2);
    expect(items[0]).toMatchObject({
      gmailId: "m1",
      threadId: "t-m1",
      subject: "Subject m1",
      from: "me@klorn.ai",
      to: "you@example.com",
      snippet: "snippet m1",
      isRead: true,
    });
    // internalDate (epoch ms) is the arrival authority, not the Date header.
    expect(items[0].receivedAt).toBe(new Date(1756100000000).toISOString());
  });

  it("returns null when Gmail is not connected (route falls back to demo)", async () => {
    state.hasToken = false;
    const { listGmailMailbox } = await import("../mail/gmail-mailbox.js");
    expect(await listGmailMailbox("user-1", "sent")).toBeNull();
  });

  it("forwards the page token and hands the next one back", async () => {
    // 50 rows was a hard cut — a Sent folder past one page just ended. The
    // token round-trips VERBATIM: Gmail's tokens are opaque.
    state.nextPageToken = "tok-2";
    const { listGmailMailbox } = await import("../mail/gmail-mailbox.js");
    const page = await listGmailMailbox("user-1", "sent", "tok-1");
    expect(state.listCalls[0]).toMatchObject({ pageToken: "tok-1" });
    expect(page?.nextPageToken).toBe("tok-2");
    expect(page?.items).toHaveLength(2);
  });

  it("a final page carries no next token", async () => {
    state.nextPageToken = null;
    const { listGmailMailbox } = await import("../mail/gmail-mailbox.js");
    const page = await listGmailMailbox("user-1", "sent");
    expect(state.listCalls[0]).not.toHaveProperty("pageToken");
    expect(page?.nextPageToken).toBeNull();
  });

  it("stamps every row with the account it came from (primary by default)", async () => {
    const { listGmailMailbox } = await import("../mail/gmail-mailbox.js");
    const page = await listGmailMailbox("user-1", "sent");
    expect(page?.items.map((r) => r.inbox)).toEqual(["primary", "primary"]);
  });
});

// The inbox selector scopes the queue and the search; the folders read the
// primary account no matter what was selected — a second account's Sent
// mail was simply unreachable. `inbox=` mirrors routes/email.ts's param.
describe("listGmailMailbox — per-inbox scope", () => {
  beforeEach(() => {
    state.listCalls.length = 0;
    state.metaCalls.length = 0;
    state.listIds = ["p1", "p2"];
    state.nextPageToken = null;
    state.hasToken = true;
    state.linked = { "lnk-a": { ids: ["a1"], nextPageToken: null } };
    state.internalDates = {};
  });

  it("a linked id reads THAT account only, and stamps its rows with the id", async () => {
    const { listGmailMailbox } = await import("../mail/gmail-mailbox.js");
    const page = await listGmailMailbox("user-1", "sent", undefined, "lnk-a");
    expect(state.listCalls.map((c) => c.account)).toEqual(["lnk-a"]);
    expect(page?.items.map((r) => [r.gmailId, r.inbox])).toEqual([["a1", "lnk-a"]]);
  });

  it("an unknown / non-Google linked id is null (route → 404, never demo rows)", async () => {
    const { listGmailMailbox } = await import("../mail/gmail-mailbox.js");
    expect(await listGmailMailbox("user-1", "sent", undefined, "lnk-missing")).toBeNull();
  });

  it("'all' merges every account newest-first and stamps each row", async () => {
    state.internalDates = { p1: "1000", p2: "3000", a1: "2000" };
    const { listGmailMailbox } = await import("../mail/gmail-mailbox.js");
    const page = await listGmailMailbox("user-1", "sent", undefined, "all");
    expect(new Set(state.listCalls.map((c) => c.account))).toEqual(new Set(["primary", "lnk-a"]));
    expect(page?.items.map((r) => [r.gmailId, r.inbox])).toEqual([
      ["p2", "primary"],
      ["a1", "lnk-a"],
      ["p1", "primary"],
    ]);
    // Every account exhausted → no next page.
    expect(page?.nextPageToken).toBeNull();
  });

  it("'all' pages each account on its own cursor, folded into one opaque token", async () => {
    state.nextPageToken = "p-tok-2";
    state.linked = { "lnk-a": { ids: ["a1"], nextPageToken: null } };
    const { decodeCompositeToken, listGmailMailbox } = await import("../mail/gmail-mailbox.js");
    const first = await listGmailMailbox("user-1", "sent", undefined, "all");
    // Only the primary has more; the token says exactly that.
    expect(first?.nextPageToken).not.toBeNull();
    expect(decodeCompositeToken(first?.nextPageToken ?? "")).toEqual({ primary: "p-tok-2" });

    state.listCalls.length = 0;
    state.nextPageToken = null;
    const second = await listGmailMailbox("user-1", "sent", first?.nextPageToken ?? "", "all");
    // Page two hits ONLY the account that still had a cursor, with its cursor.
    expect(state.listCalls).toHaveLength(1);
    expect(state.listCalls[0]).toMatchObject({ account: "primary", pageToken: "p-tok-2" });
    expect(second?.nextPageToken).toBeNull();
  });

  it("'all' with no connected account at all is null (demo fallback)", async () => {
    state.hasToken = false;
    state.linked = {};
    const { listGmailMailbox } = await import("../mail/gmail-mailbox.js");
    expect(await listGmailMailbox("user-1", "sent", undefined, "all")).toBeNull();
  });

  it("'all' still works when only a linked account is connected", async () => {
    state.hasToken = false;
    const { listGmailMailbox } = await import("../mail/gmail-mailbox.js");
    const page = await listGmailMailbox("user-1", "sent", undefined, "all");
    expect(page?.items.map((r) => r.inbox)).toEqual(["lnk-a"]);
  });

  it("a garbage composite token is treated as the first page, not a crash", async () => {
    const { listGmailMailbox } = await import("../mail/gmail-mailbox.js");
    const page = await listGmailMailbox("user-1", "sent", "not-base64-json", "all");
    expect(page?.items).toHaveLength(3);
  });
});

// Folder rows are never synced, so src="cid:…" had no attachment row to
// resolve through and every logo degraded to alt text. The live path walks
// the MIME tree instead.
describe("inline images of live messages", () => {
  const cidHeader = (value: string) => [{ name: "Content-ID", value }];
  const tree = {
    mimeType: "multipart/alternative",
    parts: [
      { mimeType: "text/plain", body: { data: "aGk" } },
      {
        mimeType: "multipart/related",
        parts: [
          { mimeType: "text/html", body: { data: "PGI+" } },
          {
            mimeType: "image/png",
            headers: cidHeader("<logo@x>"),
            body: { attachmentId: "att-logo", size: 1234 },
          },
          {
            mimeType: "image/gif",
            headers: cidHeader("<tiny@x>"),
            body: { data: "R0lGODlh", size: 8 },
          },
          {
            mimeType: "text/html",
            headers: cidHeader("<evil@x>"),
            body: { attachmentId: "att-evil" },
          },
        ],
      },
    ],
  };

  beforeEach(() => {
    state.hasToken = true;
    state.fullPayload = tree;
    state.attachmentData = { "att-logo": "iVBORw0KGgo" };
    state.attachmentGets.length = 0;
  });

  it("findInlinePart — finds the image through nested multiparts, brackets stripped", async () => {
    const { findInlinePart } = await import("../mail/inline-image.js");
    expect(findInlinePart(tree, "logo@x")).toEqual({
      mimeType: "image/png",
      attachmentId: "att-logo",
      data: null,
    });
  });

  it("findInlinePart — a small part carries its bytes inline", async () => {
    const { findInlinePart } = await import("../mail/inline-image.js");
    expect(findInlinePart(tree, "tiny@x")).toEqual({
      mimeType: "image/gif",
      attachmentId: null,
      data: "R0lGODlh",
    });
  });

  it("findInlinePart — a non-image part with a matching cid is NOT served", async () => {
    const { findInlinePart } = await import("../mail/inline-image.js");
    expect(findInlinePart(tree, "evil@x")).toBeNull();
    expect(findInlinePart(tree, "missing@x")).toBeNull();
    expect(findInlinePart(undefined, "logo@x")).toBeNull();
  });

  it("fetchInlineImage — reads the message once, then exactly the matching attachment", async () => {
    const { fetchInlineImage } = await import("../mail/inline-image.js");
    const image = await fetchInlineImage({ key: "primary" } as never, "m-1", "logo@x");
    expect(image?.mimeType).toBe("image/png");
    expect(image?.bytes).toEqual(Buffer.from("iVBORw0KGgo", "base64url"));
    expect(state.attachmentGets).toEqual([
      { messageId: "m-1", id: "att-logo", account: "primary", userId: "me" },
    ]);
  });

  it("fetchInlineImage — inline bytes need no attachment fetch; a miss is null", async () => {
    const { fetchInlineImage } = await import("../mail/inline-image.js");
    const tiny = await fetchInlineImage({ key: "primary" } as never, "m-1", "tiny@x");
    expect(tiny?.mimeType).toBe("image/gif");
    expect(state.attachmentGets).toEqual([]);
    expect(await fetchInlineImage({ key: "primary" } as never, "m-1", "missing@x")).toBeNull();
  });
});

describe("resolveMailboxClient", () => {
  beforeEach(() => {
    state.hasToken = true;
    state.linked = { "lnk-a": { ids: [], nextPageToken: null } };
  });

  it("absent / 'primary' / 'all' act on the primary; a linked id on that account", async () => {
    const { resolveMailboxClient } = await import("../mail/gmail-mailbox.js");
    expect(await resolveMailboxClient("user-1", undefined)).toEqual({ key: "primary" });
    expect(await resolveMailboxClient("user-1", "primary")).toEqual({ key: "primary" });
    expect(await resolveMailboxClient("user-1", "lnk-a")).toEqual({ key: "lnk-a" });
    expect(await resolveMailboxClient("user-1", "lnk-missing")).toBeNull();
  });
});

describe("deleteGmailDraftByMessageId", () => {
  beforeEach(() => {
    state.hasToken = true;
    state.draftDeletes.length = 0;
  });

  it("resolves the DRAFT id from the message id and deletes exactly that draft", async () => {
    const { deleteGmailDraftByMessageId } = await import("../mail/gmail-mailbox.js");
    // The folder listing hands out MESSAGE ids; drafts.delete wants the DRAFT
    // id — deleting with the message id silently 404s and the draft lingers.
    expect(await deleteGmailDraftByMessageId("user-1", "m-draft-2")).toBe(true);
    expect(state.draftDeletes).toEqual(["draft-2"]);
  });

  it("returns false and deletes nothing for an unknown message id", async () => {
    const { deleteGmailDraftByMessageId } = await import("../mail/gmail-mailbox.js");
    expect(await deleteGmailDraftByMessageId("user-1", "not-a-draft")).toBe(false);
    expect(state.draftDeletes).toEqual([]);
  });

  it("returns false when Gmail is not connected", async () => {
    state.hasToken = false;
    const { deleteGmailDraftByMessageId } = await import("../mail/gmail-mailbox.js");
    expect(await deleteGmailDraftByMessageId("user-1", "m-draft-1")).toBe(false);
  });

  it("deletes on the LINKED account when the draft came from one", async () => {
    state.linked = { "lnk-a": { ids: [], nextPageToken: null } };
    const { deleteGmailDraftByMessageId } = await import("../mail/gmail-mailbox.js");
    expect(await deleteGmailDraftByMessageId("user-1", "m-draft-1", "lnk-a")).toBe(true);
    expect(state.draftDeletes).toEqual(["draft-1"]);
  });
});
