/**
 * docs/design/mail-cleanup-actions.md, PR1: the undo of an Outlook trash or
 * archive brings its local row back through Graph (one message, by its immutable
 * id) and the shared persist path — the same mapping the delta poll uses, so the
 * next delta delivery of that message finds the row already there.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const persistGmailEmail = vi.hoisted(() => vi.fn());
const resolveOutlookBearer = vi.hoisted(() => vi.fn());
vi.mock("../judge/email-firewall.js", () => ({ persistGmailEmail }));
vi.mock("../mail/outlook-token.js", () => ({
  resolveOutlookBearer,
  resolveAccessToken: vi.fn(),
}));
vi.mock("../sentry.js", () => ({ captureError: vi.fn() }));

const fetchMock = vi.fn();
vi.stubGlobal("fetch", fetchMock);

const { syncOutlookMessageForUser } = await import("../mail/outlook-accounts.js");

const MAILBOX = "me@outlook.com";
const STABLE_ID = `outlook:${MAILBOX}:AAMk-imm-1`;

function graphMessage(over: Record<string, unknown> = {}) {
  return {
    id: "AAMk-imm-1",
    subject: "Invoice",
    from: { emailAddress: { name: "Kim", address: "kim@example.com" } },
    toRecipients: [{ emailAddress: { name: "", address: MAILBOX } }],
    ccRecipients: [],
    receivedDateTime: "2026-11-20T09:00:00Z",
    bodyPreview: "Hello",
    isRead: true,
    flag: { flagStatus: "notFlagged" },
    body: { content: "Hello, full body" },
    hasAttachments: false,
    ...over,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  resolveOutlookBearer.mockResolvedValue({ accessToken: "bearer-at", email: MAILBOX });
  persistGmailEmail.mockResolvedValue({ emailId: "e-restored", isNew: true });
  fetchMock.mockResolvedValue({ ok: true, status: 200, json: async () => graphMessage() });
});

describe("syncOutlookMessageForUser", () => {
  it("GETs the one message by immutable id and persists it under its stable id", async () => {
    const synced = await syncOutlookMessageForUser("u1", "acc-ol", STABLE_ID);

    expect(synced).toEqual({ emailId: "e-restored" });
    expect(resolveOutlookBearer).toHaveBeenCalledWith("u1", "acc-ol");
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toMatch(/^https:\/\/graph\.microsoft\.com\/v1\.0\/me\/messages\/AAMk-imm-1\?/);
    expect(new URL(url).searchParams.get("$select")).toContain("receivedDateTime");
    expect(init.headers.authorization).toBe("Bearer bearer-at");
    expect(init.headers.Prefer).toContain('IdType="ImmutableId"');
    expect(persistGmailEmail).toHaveBeenCalledWith(
      "u1",
      expect.objectContaining({
        gmailId: STABLE_ID,
        from: "Kim <kim@example.com>",
        subject: "Invoice",
        labels: ["INBOX"],
        isRead: true,
        receivedAt: new Date("2026-11-20T09:00:00Z"),
      }),
      expect.objectContaining({ linkedInboxAccountId: "acc-ol", userEmail: MAILBOX }),
    );
  });

  it("answers null, persisting nothing, when the account is not connected", async () => {
    resolveOutlookBearer.mockResolvedValue(null);
    expect(await syncOutlookMessageForUser("u1", "acc-ol", STABLE_ID)).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
    expect(persistGmailEmail).not.toHaveBeenCalled();
  });

  it("answers null for an id of another mailbox (never fetched)", async () => {
    expect(
      await syncOutlookMessageForUser("u1", "acc-ol", "outlook:other@outlook.com:AAMk-imm-1"),
    ).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("answers null when Graph does not return the message", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    fetchMock.mockResolvedValue({ ok: false, status: 404, json: async () => ({}) });
    expect(await syncOutlookMessageForUser("u1", "acc-ol", STABLE_ID)).toBeNull();
    expect(persistGmailEmail).not.toHaveBeenCalled();
  });
});
