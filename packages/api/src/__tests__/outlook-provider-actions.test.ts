/**
 * Phase 3C: the OUTLOOK MailProviderActions implementation. fetch is mocked;
 * these pin the Graph endpoints/verbs/bodies per action, the immutable-id
 * Prefer header, extraction of the Graph id from the synthesized
 * `outlook:<email>:<id>` key, the result contract (401/403 → reconnect +
 * soft error; EVERYTHING else — non-auth 4xx, foreign ids, 5xx — throws so
 * DELETE callers never fall into the local-only-delete/resurrection path),
 * and the sendMail/draft payload shapes including base64 attachments.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const m = vi.hoisted(() => ({
  resolveOutlookBearer: vi.fn(),
  markLinkedInboxForReconnect: vi.fn(async () => undefined),
}));

vi.mock("../mail/outlook-token.js", () => ({
  resolveOutlookBearer: m.resolveOutlookBearer,
}));
vi.mock("../mail/gmail.js", () => ({
  markLinkedInboxForReconnect: m.markLinkedInboxForReconnect,
}));

const fetchMock = vi.fn();
vi.stubGlobal("fetch", fetchMock);

const { outlookMailActions } = await import("../mail/providers/outlook.js");

const EMAIL = "me@outlook.com";
const ROW = "row-1";
const MSG = (graphId: string) => `outlook:${EMAIL}:${graphId}`;

function graphResponse(body: unknown, status = 200) {
  return { ok: status < 400, status, json: async () => body };
}

beforeEach(() => {
  vi.clearAllMocks();
  m.resolveOutlookBearer.mockResolvedValue({ accessToken: "bearer-at", email: EMAIL });
  fetchMock.mockResolvedValue(graphResponse({}));
});

describe("simple actions — endpoint, verb, body, headers", () => {
  it("markAsRead PATCHes isRead with the immutable-id Prefer header", async () => {
    const result = await outlookMailActions.markAsRead("u1", MSG("AAA"), ROW);
    expect(result).toEqual({ success: true });
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("https://graph.microsoft.com/v1.0/me/messages/AAA");
    expect(init.method).toBe("PATCH");
    expect(JSON.parse(init.body)).toEqual({ isRead: true });
    expect(init.headers.Prefer).toBe('IdType="ImmutableId"');
    expect(init.headers.authorization).toBe("Bearer bearer-at");
  });

  it("toggleRead(false) and toggleStar map to isRead / flagStatus", async () => {
    await outlookMailActions.toggleRead("u1", MSG("A"), false, ROW);
    expect(JSON.parse(fetchMock.mock.calls[0][1].body)).toEqual({ isRead: false });
    await outlookMailActions.toggleStar("u1", MSG("A"), true, ROW);
    expect(JSON.parse(fetchMock.mock.calls[1][1].body)).toEqual({
      flag: { flagStatus: "flagged" },
    });
    await outlookMailActions.toggleStar("u1", MSG("A"), false, ROW);
    expect(JSON.parse(fetchMock.mock.calls[2][1].body)).toEqual({
      flag: { flagStatus: "notFlagged" },
    });
  });

  it.each([
    ["trash", "deleteditems"],
    ["untrash", "inbox"],
    ["archive", "archive"],
    ["unarchive", "inbox"],
  ] as const)("%s moves to the %s well-known folder", async (action, folder) => {
    await outlookMailActions[action]("u1", MSG("A"), ROW);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("https://graph.microsoft.com/v1.0/me/messages/A/move");
    expect(init.method).toBe("POST");
    expect(JSON.parse(init.body)).toEqual({ destinationId: folder });
  });

  it("URL-encodes Graph ids (immutable ids can carry +/= style chars)", async () => {
    await outlookMailActions.markAsRead("u1", MSG("AB+C/d="), ROW);
    expect(fetchMock.mock.calls[0][0]).toBe(
      `https://graph.microsoft.com/v1.0/me/messages/${encodeURIComponent("AB+C/d=")}`,
    );
  });
});

describe("id and account guards", () => {
  it("throws on a message id that is not this Outlook mailbox's, without calling Graph", async () => {
    // A soft {error} here would hit the DELETE route's "not connected →
    // remove locally" fallback and resurrect on the next delta sync — a
    // foreign id is corrupt data, which is a hard failure by contract.
    await expect(outlookMailActions.markAsRead("u1", "some-gmail-id", ROW)).rejects.toThrow(
      /Outlook mailbox/,
    );
    await expect(
      outlookMailActions.markAsRead("u1", "outlook:other@x.com:AAA", ROW),
    ).rejects.toThrow();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("refuses a null linkedInboxAccountId (primary is never OUTLOOK)", async () => {
    const result = await outlookMailActions.markAsRead("u1", MSG("A"), null);
    expect(result).toMatchObject({ error: expect.stringContaining("linked inbox") });
    expect(m.resolveOutlookBearer).not.toHaveBeenCalled();
  });

  it("soft-fails when the account cannot auth (bearer resolver returned null)", async () => {
    m.resolveOutlookBearer.mockResolvedValue(null);
    const result = await outlookMailActions.markAsRead("u1", MSG("A"), ROW);
    expect(result).toMatchObject({ error: expect.stringContaining("not connected") });
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe("result contract", () => {
  it("401 marks the row for reconnect (provider OUTLOOK) and soft-fails", async () => {
    fetchMock.mockResolvedValue(graphResponse({}, 401));
    const result = await outlookMailActions.archive("u1", MSG("A"), ROW);
    expect(result).toMatchObject({ error: expect.stringContaining("reconnect") });
    expect(m.markLinkedInboxForReconnect).toHaveBeenCalledWith("u1", ROW, "OUTLOOK");
  });

  it.each([
    404, 429, 400,
  ])("non-auth 4xx (%s) THROWS — only auth failures may soft-fail", async (status) => {
    // Gmail's contract: {error} means "not connected" and callers respond
    // with local-only writes (DELETE removes the local row!). A throttle or
    // missing message must surface as a hard failure (502), not as a
    // false-success local deletion that the next delta sync resurrects.
    fetchMock.mockResolvedValue(graphResponse({}, status));
    await expect(outlookMailActions.trash("u1", MSG("A"), ROW)).rejects.toThrow(
      new RegExp(`http ${status}`),
    );
    expect(m.markLinkedInboxForReconnect).not.toHaveBeenCalled();
  });

  it("5xx throws (hard failure, same as the Gmail module)", async () => {
    fetchMock.mockResolvedValue(graphResponse({}, 503));
    await expect(outlookMailActions.markAsRead("u1", MSG("A"), ROW)).rejects.toThrow(/http 503/);
  });
});

describe("sendEmail / createDraft / getReplyHeaders", () => {
  it("sendEmail POSTs sendMail with recipients, text body, and saveToSentItems", async () => {
    fetchMock.mockResolvedValue(graphResponse(null, 202));
    const result = await outlookMailActions.sendEmail("u1", "to@x.com", "Subj", "Body", [], {
      linkedInboxAccountId: ROW,
    });
    expect(result).toEqual({ success: true, messageId: null });
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("https://graph.microsoft.com/v1.0/me/sendMail");
    expect(JSON.parse(init.body)).toEqual({
      message: {
        subject: "Subj",
        body: { contentType: "Text", content: "Body" },
        toRecipients: [{ emailAddress: { address: "to@x.com" } }],
      },
      saveToSentItems: true,
    });
  });

  it("sendEmail base64-encodes attachments as fileAttachment", async () => {
    fetchMock.mockResolvedValue(graphResponse(null, 202));
    await outlookMailActions.sendEmail(
      "u1",
      "to@x.com",
      "S",
      "B",
      [{ filename: "a.txt", mimeType: "text/plain", content: Buffer.from("hi") }],
      { linkedInboxAccountId: ROW },
    );
    const payload = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(payload.message.attachments).toEqual([
      {
        "@odata.type": "#microsoft.graph.fileAttachment",
        name: "a.txt",
        contentType: "text/plain",
        contentBytes: Buffer.from("hi").toString("base64"),
      },
    ]);
  });

  it("sendEmail without a linked inbox id soft-fails (never falls back to primary)", async () => {
    const result = await outlookMailActions.sendEmail("u1", "to@x.com", "S", "B");
    expect(result).toMatchObject({ error: expect.any(String) });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("createDraft returns the draft id and webLink url", async () => {
    fetchMock.mockResolvedValue(
      graphResponse({ id: "draft-1", webLink: "https://outlook.live.com/mail/x" }, 201),
    );
    const result = await outlookMailActions.createDraft("u1", {
      to: "to@x.com",
      subject: "S",
      body: "B",
      threadId: null,
      attachments: [],
      linkedInboxAccountId: ROW,
    });
    expect(result).toEqual({
      success: true,
      draftId: "draft-1",
      messageId: "draft-1",
      url: "https://outlook.live.com/mail/x",
    });
    expect(fetchMock.mock.calls[0][0]).toBe("https://graph.microsoft.com/v1.0/me/messages");
  });

  it("createDraft accepts the B0 reply context and still creates an unthreaded draft", async () => {
    // Graph cannot set In-Reply-To through POST /me/messages. Native reply
    // drafts (/createReply) are step B0b, so the payload must stay exactly the
    // no-reply payload: no internetMessageHeaders, no conversation fields.
    fetchMock.mockResolvedValue(graphResponse({ id: "draft-2" }, 201));
    const result = await outlookMailActions.createDraft("u1", {
      to: "to@x.com",
      subject: "S",
      body: "B",
      threadId: "conv-1",
      attachments: [],
      linkedInboxAccountId: ROW,
      reply: { inReplyTo: "<m@x>", references: "<r@x> <m@x>" },
    });
    expect(result).toMatchObject({ success: true, draftId: "draft-2" });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("https://graph.microsoft.com/v1.0/me/messages");
    expect(init.method).toBe("POST");
    expect(JSON.parse(init.body)).toEqual({
      subject: "S",
      body: { contentType: "Text", content: "B" },
      toRecipients: [{ emailAddress: { address: "to@x.com" } }],
    });
  });

  it("createDraft still needs a linked inbox id when a reply context is given", async () => {
    const result = await outlookMailActions.createDraft("u1", {
      to: "to@x.com",
      subject: "S",
      body: "B",
      linkedInboxAccountId: null,
      reply: { inReplyTo: "<m@x>" },
    });
    expect(result).toMatchObject({ error: expect.stringContaining("linked inbox") });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("getReplyHeaders answers {} unconditionally — sendEmail cannot thread yet", async () => {
    // Returning internetMessageId would make /api/email/:id/reply claim
    // threaded:true while the actual Graph sendMail carries no In-Reply-To.
    // {} is the honest best-effort answer until /messages/{id}/reply is wired.
    expect(await outlookMailActions.getReplyHeaders("u1", MSG("A"), ROW)).toEqual({});
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
