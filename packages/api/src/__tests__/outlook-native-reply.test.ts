/**
 * Step B0b: native Microsoft Graph replies and reply drafts for OUTLOOK.
 *
 * A reply is made from the ORIGINAL message so Graph threads it itself
 * (conversationId / conversationIndex / In-Reply-To are set by the service):
 *   POST /me/messages/{id}/createReply   -> reply draft (Mail.ReadWrite)
 *   PATCH /me/messages/{draft}           -> body, subject and recipients, set explicitly
 *   POST /me/messages/{draft}/send       -> only for sendEmail (Mail.Send)
 * The fetch double below keeps the draft's state, so what the test asserts about
 * recipients is what a real Graph draft would hold at send time.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const m = vi.hoisted(() => ({
  resolveOutlookBearer: vi.fn(),
  markLinkedInboxForReconnect: vi.fn(async () => undefined),
}));

vi.mock("../mail/outlook-token.js", () => ({ resolveOutlookBearer: m.resolveOutlookBearer }));
vi.mock("../mail/gmail.js", () => ({ markLinkedInboxForReconnect: m.markLinkedInboxForReconnect }));

const fetchMock = vi.fn();
vi.stubGlobal("fetch", fetchMock);

const { outlookMailActions } = await import("../mail/providers/outlook.js");

const BASE = "https://graph.microsoft.com/v1.0";
const EMAIL = "me@outlook.com";
const ROW = "row-1";
const ORIGINAL = `outlook:${EMAIL}:ORIG`;
const WEB_LINK = "https://outlook.live.com/mail/0/drafts/id/DRAFT";
const REPLY_TO_ADDRESS = "reply-to@elsewhere.test";

interface RecordedCall {
  method: string;
  path: string;
  headers: Record<string, string>;
  body: unknown;
}
interface FakeResponse {
  status: number;
  body?: unknown;
}
type Handler = (call: RecordedCall, draft: DraftState) => FakeResponse;
interface DraftState {
  id: string;
  toRecipients: Array<{ emailAddress: { address: string } }>;
  ccRecipients: unknown[];
  bccRecipients: unknown[];
  subject: string;
  body: unknown;
}

let calls: RecordedCall[];
let draft: DraftState;
/** What the draft looked like at the moment /send was called. */
let sentSnapshot: DraftState | null;

const address = (value: string) => ({ emailAddress: { address: value } });

/** Graph as documented: createReply addresses the original's Reply-To, PATCH replaces what it is given. */
const defaultHandlers: Record<string, Handler> = {
  [`POST /me/messages/ORIG/createReply`]: (_call, state) => ({
    status: 201,
    body: { ...state, webLink: WEB_LINK, isDraft: true },
  }),
  [`PATCH /me/messages/DRAFT`]: (call, state) => {
    Object.assign(state, call.body as object);
    return { status: 200, body: { ...state } };
  },
  [`POST /me/messages/DRAFT/send`]: (_call, state) => {
    sentSnapshot = structuredClone(state);
    return { status: 202 };
  },
  [`POST /me/messages/DRAFT/attachments`]: () => ({ status: 201, body: { id: "ATT" } }),
  [`DELETE /me/messages/DRAFT`]: () => ({ status: 204 }),
};

function installGraph(overrides: Record<string, Handler> = {}) {
  const handlers = { ...defaultHandlers, ...overrides };
  fetchMock.mockImplementation(async (url: string, init: RequestInit) => {
    const call: RecordedCall = {
      method: String(init.method),
      path: url.replace(BASE, ""),
      headers: (init.headers ?? {}) as Record<string, string>,
      body: typeof init.body === "string" ? JSON.parse(init.body) : undefined,
    };
    calls = [...calls, call];
    const handler = handlers[`${call.method} ${call.path}`];
    if (!handler) throw new Error(`unscripted Graph call: ${call.method} ${call.path}`);
    const { status, body } = handler(call, draft);
    return { ok: status < 400, status, json: async () => body ?? null };
  });
}

const summary = () => calls.map((call) => `${call.method} ${call.path}`);

const REPLY = { replyToProviderMessageId: ORIGINAL, linkedInboxAccountId: ROW } as const;
const FILE = { filename: "brief.txt", mimeType: "text/plain", content: Buffer.from("hi") };
const PATCH_BODY = {
  subject: "Re: Plan",
  body: { contentType: "Text", content: "Thursday works." },
  toRecipients: [address("alice@example.com")],
  ccRecipients: [],
  bccRecipients: [],
};

const sendReply = (overrides: Record<string, unknown> = {}) =>
  outlookMailActions.sendEmail("u1", "alice@example.com", "Re: Plan", "Thursday works.", [], {
    ...REPLY,
    ...overrides,
  });
const draftReply = (overrides: Record<string, unknown> = {}) =>
  outlookMailActions.createDraft("u1", {
    to: "alice@example.com",
    subject: "Re: Plan",
    body: "Thursday works.",
    threadId: "conv-1",
    ...REPLY,
    ...overrides,
  });

beforeEach(() => {
  vi.clearAllMocks();
  vi.spyOn(console, "warn").mockImplementation(() => {});
  calls = [];
  sentSnapshot = null;
  draft = {
    id: "DRAFT",
    toRecipients: [address(REPLY_TO_ADDRESS)],
    ccRecipients: [],
    bccRecipients: [],
    subject: "RE: Plan",
    body: { contentType: "html", content: "<html>quoted original</html>" },
  };
  m.resolveOutlookBearer.mockResolvedValue({ accessToken: "bearer-at", email: EMAIL });
  installGraph();
});

describe("the provider declares native replies", () => {
  it("names itself as a provider that threads by the original's id", () => {
    expect(outlookMailActions.nativeReply).toBe(true);
  });

  it("still answers no reply headers: the header path is Gmail and SMTP only", async () => {
    expect(await outlookMailActions.getReplyHeaders("u1", ORIGINAL, ROW)).toEqual({});
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe("sendEmail with a reply target", () => {
  it("replies through createReply, PATCH and send, and never through sendMail", async () => {
    const result = await sendReply();
    expect(result).toEqual({ success: true, messageId: null, threaded: true });
    expect(summary()).toEqual([
      "POST /me/messages/ORIG/createReply",
      "PATCH /me/messages/DRAFT",
      "POST /me/messages/DRAFT/send",
    ]);
  });

  it("sets subject, plain-text body and every recipient list explicitly on the draft", async () => {
    await sendReply();
    expect(calls[1]?.body).toEqual(PATCH_BODY);
  });

  it("sends the approved body alone: the quoted original Graph put in the draft is replaced", async () => {
    await sendReply();
    expect(sentSnapshot?.body).toEqual({ contentType: "Text", content: "Thursday works." });
    expect(sentSnapshot?.subject).toBe("Re: Plan");
  });

  it("carries the immutable-id Prefer header and the bearer on every call", async () => {
    await sendReply();
    for (const call of calls) {
      expect(call.headers.Prefer).toBe('IdType="ImmutableId"');
      expect(call.headers.authorization).toBe("Bearer bearer-at");
    }
  });

  it("posts createReply and send without a body, and PATCH as JSON", async () => {
    await sendReply();
    expect(calls[0]?.body).toBeUndefined();
    expect(calls[0]?.headers).not.toHaveProperty("content-type");
    expect(calls[1]?.headers["content-type"]).toBe("application/json");
    expect(calls[2]?.body).toBeUndefined();
  });

  it("URL-encodes the original's id and the draft's id", async () => {
    installGraph({
      "POST /me/messages/AB%2BC%2Fd%3D/createReply": (_c, state) => ({
        status: 201,
        body: { ...state, id: "DR+AFT=" },
      }),
      "PATCH /me/messages/DR%2BAFT%3D": (call, state) => {
        Object.assign(state, call.body as object);
        return { status: 200, body: { ...state } };
      },
      "POST /me/messages/DR%2BAFT%3D/send": () => ({ status: 202 }),
    });
    await sendReply({ replyToProviderMessageId: `outlook:${EMAIL}:AB+C/d=` });
    expect(summary()).toEqual([
      "POST /me/messages/AB%2BC%2Fd%3D/createReply",
      "PATCH /me/messages/DR%2BAFT%3D",
      "POST /me/messages/DR%2BAFT%3D/send",
    ]);
  });

  it("does not send a draft addressed to the original's Reply-To: the recipient is what the caller named", async () => {
    await sendReply();
    // createReply addressed REPLY_TO_ADDRESS; at send time only the named recipient remains.
    expect(sentSnapshot?.toRecipients).toEqual([address("alice@example.com")]);
    expect(sentSnapshot?.ccRecipients).toEqual([]);
    expect(sentSnapshot?.bccRecipients).toEqual([]);
  });

  it("compares the recipient case-insensitively, as addresses are", async () => {
    installGraph({
      "PATCH /me/messages/DRAFT": (call, state) => {
        Object.assign(state, call.body as object, {
          toRecipients: [address("ALICE@Example.com")],
        });
        return { status: 200, body: { ...state } };
      },
    });
    expect(await sendReply()).toMatchObject({ success: true, threaded: true });
  });

  it("uses the headers path for nothing: reply headers alone do not select a native reply", async () => {
    fetchMock.mockResolvedValue({ ok: true, status: 202, json: async () => null });
    const result = await outlookMailActions.sendEmail("u1", "a@x.com", "S", "B", [], {
      linkedInboxAccountId: ROW,
      threadId: "conv-1",
      inReplyTo: "<m@x>",
      references: "<r@x> <m@x>",
    });
    expect(result).toEqual({ success: true, messageId: null });
    expect(fetchMock.mock.calls.map((call) => call[0])).toEqual([`${BASE}/me/sendMail`]);
  });

  it("adds attachments to the reply draft after the PATCH and before the send", async () => {
    await outlookMailActions.sendEmail(
      "u1",
      "alice@example.com",
      "Re: Plan",
      "Thursday works.",
      [FILE],
      REPLY,
    );
    expect(summary()).toEqual([
      "POST /me/messages/ORIG/createReply",
      "PATCH /me/messages/DRAFT",
      "POST /me/messages/DRAFT/attachments",
      "POST /me/messages/DRAFT/send",
    ]);
    expect(calls[2]?.body).toEqual({
      "@odata.type": "#microsoft.graph.fileAttachment",
      name: "brief.txt",
      contentType: "text/plain",
      contentBytes: Buffer.from("hi").toString("base64"),
    });
  });
});

describe("recipient pinning: nothing is sent unless the draft is addressed to exactly the named recipient", () => {
  const swallowsPatch = (recipients: Partial<DraftState>): Record<string, Handler> => ({
    "PATCH /me/messages/DRAFT": (_call, state) => ({
      status: 200,
      body: { ...state, ...recipients },
    }),
  });

  it("refuses, discards the draft and sends nothing when Graph still addresses someone else", async () => {
    installGraph(swallowsPatch({ toRecipients: [address(REPLY_TO_ADDRESS)] }));
    await expect(sendReply()).rejects.toThrow(/recipient/i);
    expect(summary()).toEqual([
      "POST /me/messages/ORIG/createReply",
      "PATCH /me/messages/DRAFT",
      "DELETE /me/messages/DRAFT",
    ]);
  });

  it("refuses when the draft holds the named recipient plus another", async () => {
    installGraph(
      swallowsPatch({ toRecipients: [address("alice@example.com"), address("x@y.test")] }),
    );
    await expect(sendReply()).rejects.toThrow(/recipient/i);
    expect(summary()).not.toContain("POST /me/messages/DRAFT/send");
  });

  it("refuses when Graph's answer does not say who the draft is addressed to (fail closed)", async () => {
    installGraph({
      "PATCH /me/messages/DRAFT": () => ({ status: 200, body: { id: "DRAFT" } }),
    });
    await expect(sendReply()).rejects.toThrow(/recipient/i);
    expect(summary()).not.toContain("POST /me/messages/DRAFT/send");
  });

  it.each([
    ["cc", { ccRecipients: [address("cc@y.test")] }],
    ["bcc", { bccRecipients: [address("bcc@y.test")] }],
  ])("refuses when the draft carries a %s recipient", async (_name, extra) => {
    installGraph(
      swallowsPatch({
        toRecipients: [address("alice@example.com")],
        ...extra,
      } as Partial<DraftState>),
    );
    await expect(sendReply()).rejects.toThrow(/recipient/i);
    expect(summary()).not.toContain("POST /me/messages/DRAFT/send");
  });

  it("a draft is checked the same way: a mismatch throws and the half-made draft is discarded", async () => {
    installGraph(swallowsPatch({ toRecipients: [address(REPLY_TO_ADDRESS)] }));
    await expect(draftReply()).rejects.toThrow(/recipient/i);
    expect(summary()).toEqual([
      "POST /me/messages/ORIG/createReply",
      "PATCH /me/messages/DRAFT",
      "DELETE /me/messages/DRAFT",
    ]);
  });
});

describe("sendEmail failure handling", () => {
  it("a createReply refused for authorization is the soft not-connected answer and flags reconnect", async () => {
    installGraph({ "POST /me/messages/ORIG/createReply": () => ({ status: 403 }) });
    const result = await sendReply();
    expect(result).toMatchObject({ error: expect.stringContaining("reconnect") });
    expect(m.markLinkedInboxForReconnect).toHaveBeenCalledWith("u1", ROW, "OUTLOOK");
    expect(summary()).toEqual(["POST /me/messages/ORIG/createReply"]);
  });

  it("an original that is gone (404) throws, and is never resent as an unthreaded message", async () => {
    installGraph({ "POST /me/messages/ORIG/createReply": () => ({ status: 404 }) });
    await expect(sendReply()).rejects.toThrow(/http 404/);
    expect(summary()).toEqual(["POST /me/messages/ORIG/createReply"]);
  });

  it("a createReply answer without a draft id throws before anything is patched", async () => {
    installGraph({ "POST /me/messages/ORIG/createReply": () => ({ status: 201, body: {} }) });
    await expect(sendReply()).rejects.toThrow(/draft id/i);
    expect(summary()).toEqual(["POST /me/messages/ORIG/createReply"]);
  });

  it("a failed PATCH throws, discards the draft and sends nothing", async () => {
    installGraph({ "PATCH /me/messages/DRAFT": () => ({ status: 500 }) });
    await expect(sendReply()).rejects.toThrow(/http 500/);
    expect(summary()).toEqual([
      "POST /me/messages/ORIG/createReply",
      "PATCH /me/messages/DRAFT",
      "DELETE /me/messages/DRAFT",
    ]);
  });

  it("a PATCH refused for authorization is a soft error, the draft is discarded and nothing is sent", async () => {
    installGraph({ "PATCH /me/messages/DRAFT": () => ({ status: 401 }) });
    expect(await sendReply()).toMatchObject({ error: expect.stringContaining("reconnect") });
    expect(summary()).toEqual([
      "POST /me/messages/ORIG/createReply",
      "PATCH /me/messages/DRAFT",
      "DELETE /me/messages/DRAFT",
    ]);
  });

  it("a failed attachment upload throws and discards the draft", async () => {
    installGraph({ "POST /me/messages/DRAFT/attachments": () => ({ status: 413 }) });
    await expect(
      outlookMailActions.sendEmail("u1", "alice@example.com", "Re: Plan", "B", [FILE], REPLY),
    ).rejects.toThrow(/http 413/);
    expect(summary()).toEqual([
      "POST /me/messages/ORIG/createReply",
      "PATCH /me/messages/DRAFT",
      "POST /me/messages/DRAFT/attachments",
      "DELETE /me/messages/DRAFT",
    ]);
  });

  it("a failing cleanup does not hide the error that caused it", async () => {
    installGraph({
      "PATCH /me/messages/DRAFT": () => ({ status: 500 }),
      "DELETE /me/messages/DRAFT": () => ({ status: 503 }),
    });
    await expect(sendReply()).rejects.toThrow(/PATCH .* http 500/);
  });

  it("a send that fails for authorization is soft, definitely unsent, and the draft is discarded", async () => {
    installGraph({ "POST /me/messages/DRAFT/send": () => ({ status: 403 }) });
    expect(await sendReply()).toMatchObject({ error: expect.stringContaining("reconnect") });
    expect(summary().at(-1)).toBe("DELETE /me/messages/DRAFT");
  });

  it("a send whose outcome is unknown (5xx) throws and leaves the draft alone: it may already be sent", async () => {
    installGraph({ "POST /me/messages/DRAFT/send": () => ({ status: 502 }) });
    await expect(sendReply()).rejects.toThrow(/http 502/);
    expect(summary()).not.toContain("DELETE /me/messages/DRAFT");
  });

  it("an original id of another mailbox throws before any Graph call", async () => {
    await expect(
      sendReply({ replyToProviderMessageId: "outlook:other@x.com:ORIG" }),
    ).rejects.toThrow(/Outlook mailbox/);
    await expect(sendReply({ replyToProviderMessageId: "gmail-id-1" })).rejects.toThrow(
      /Outlook mailbox/,
    );
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("still needs a linked inbox id: a reply target never falls back to the primary", async () => {
    const result = await sendReply({ linkedInboxAccountId: null });
    expect(result).toMatchObject({ error: expect.stringContaining("linked inbox") });
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe("createDraft with a reply target", () => {
  it("creates a reply draft from the original and never sends it", async () => {
    const result = await draftReply();
    expect(result).toEqual({ success: true, draftId: "DRAFT", messageId: "DRAFT", url: WEB_LINK });
    expect(summary()).toEqual(["POST /me/messages/ORIG/createReply", "PATCH /me/messages/DRAFT"]);
    expect(calls[1]?.body).toEqual(PATCH_BODY);
  });

  it("falls back to the drafts folder url when the draft has no webLink", async () => {
    installGraph({
      "POST /me/messages/ORIG/createReply": (_c, state) => ({ status: 201, body: { ...state } }),
    });
    expect(await draftReply()).toMatchObject({
      success: true,
      url: "https://outlook.live.com/mail/0/drafts",
    });
  });

  it("pins the recipient on the draft too, overriding the original's Reply-To", async () => {
    await draftReply();
    expect(draft.toRecipients).toEqual([address("alice@example.com")]);
  });

  it("ignores the header-shaped reply context: the original's id is what threads", async () => {
    await draftReply({ reply: { inReplyTo: "<m@x>", references: "<r@x> <m@x>" } });
    expect(summary()).toEqual(["POST /me/messages/ORIG/createReply", "PATCH /me/messages/DRAFT"]);
  });

  it("adds attachments to the reply draft", async () => {
    await draftReply({ attachments: [FILE] });
    expect(summary()).toEqual([
      "POST /me/messages/ORIG/createReply",
      "PATCH /me/messages/DRAFT",
      "POST /me/messages/DRAFT/attachments",
    ]);
  });

  it("a failed PATCH throws and discards the half-made draft", async () => {
    installGraph({ "PATCH /me/messages/DRAFT": () => ({ status: 500 }) });
    await expect(draftReply()).rejects.toThrow(/http 500/);
    expect(summary().at(-1)).toBe("DELETE /me/messages/DRAFT");
  });

  it("an original id of another mailbox throws before any Graph call", async () => {
    await expect(
      draftReply({ replyToProviderMessageId: "outlook:other@x.com:ORIG" }),
    ).rejects.toThrow(/Outlook mailbox/);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("still needs a linked inbox id", async () => {
    expect(await draftReply({ linkedInboxAccountId: null })).toMatchObject({
      error: expect.stringContaining("linked inbox"),
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
