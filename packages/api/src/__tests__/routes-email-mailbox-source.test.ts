/**
 * GET /api/email/mailbox/:box — Sent / Drafts / Archived are read live from
 * Gmail. A user with no Gmail (IMAP-only, or nothing connected) used to get
 * demo folder rows that the desktop rendered as real mail. Now: always empty
 * when Gmail cannot answer; `demo` / `needsConnection` say whether any mail
 * source is connected at all.
 */
import Fastify from "fastify";
import { beforeEach, describe, expect, it, vi } from "vitest";

const listGmailMailbox = vi.hoisted(() => vi.fn(async () => null as unknown));
const hasAnyMailSource = vi.hoisted(() => vi.fn(async () => false));

vi.mock("../auth.js", () => ({ getUserId: () => "user-1" }));
vi.mock("../mail/mail-source.js", () => ({ hasAnyMailSource }));
vi.mock("../mail/gmail-mailbox.js", () => ({
  MAILBOXES: ["sent", "drafts", "archived"],
  listGmailMailbox,
  deleteGmailDraftByMessageId: vi.fn(),
  resolveMailboxClient: vi.fn(),
}));
vi.mock("../mail/gmail-fetch.js", () => ({ fetchGmailEmailById: vi.fn() }));
vi.mock("../mail/inline-image.js", () => ({ fetchInlineImage: vi.fn() }));
vi.mock("../mail/email-text.js", () => ({ renderableEmailHtmlFor: vi.fn() }));

async function buildApp() {
  const { registerEmailMailboxRoutes } = await import("../routes/email-mailbox.js");
  const app = Fastify();
  await app.register(async (scoped) => registerEmailMailboxRoutes(scoped), {
    prefix: "/api/email",
  });
  return app;
}

beforeEach(() => {
  listGmailMailbox.mockReset();
  listGmailMailbox.mockResolvedValue(null);
  hasAnyMailSource.mockReset();
  hasAnyMailSource.mockResolvedValue(false);
});

describe("GET /api/email/mailbox/:box without Gmail", () => {
  it("IMAP-only user: an empty folder, not demo rows, and not flagged demo", async () => {
    hasAnyMailSource.mockResolvedValue(true);
    const app = await buildApp();
    const res = await app.inject({ method: "GET", url: "/api/email/mailbox/sent" });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({
      success: true,
      data: { items: [], nextPageToken: null, demo: false },
    });
    expect(hasAnyMailSource).toHaveBeenCalledWith("user-1");
    await app.close();
  });

  it("no source at all: an empty folder flagged demo + needsConnection", async () => {
    const app = await buildApp();
    const res = await app.inject({ method: "GET", url: "/api/email/mailbox/drafts" });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({
      success: true,
      data: { items: [], nextPageToken: null, demo: true, needsConnection: true },
    });
    await app.close();
  });

  it("Gmail answers: its rows pass through and the source check is skipped", async () => {
    const item = { gmailId: "g1", subject: "s" };
    listGmailMailbox.mockResolvedValue({ items: [item], nextPageToken: "n2" });
    const app = await buildApp();
    const res = await app.inject({ method: "GET", url: "/api/email/mailbox/archived" });
    expect(res.json()).toEqual({
      success: true,
      data: { items: [item], nextPageToken: "n2", demo: false },
    });
    expect(hasAnyMailSource).not.toHaveBeenCalled();
    await app.close();
  });
});
