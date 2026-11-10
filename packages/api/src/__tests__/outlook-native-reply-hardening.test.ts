/**
 * Step B0b, second round (code and security review): what the native Outlook reply
 * checks before it sends, how it cleans up, and how it reports a send it cannot vouch
 * for. The core flow is in outlook-native-reply.test.ts; both use the same stateful
 * Graph double (helpers/graph-reply-fake.ts).
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SendOutcomeUnknownError } from "../mail/providers/send-outcome-unknown.js";
import {
  address,
  createGraphFake,
  type FakeResponse,
  type Handler,
  LIST_ATTACHMENTS,
  MAILBOX,
  ORIGINAL_ID,
} from "./helpers/graph-reply-fake.js";

const m = vi.hoisted(() => ({
  resolveOutlookBearer: vi.fn(),
  markLinkedInboxForReconnect: vi.fn(async () => undefined),
}));

vi.mock("../mail/outlook-token.js", () => ({ resolveOutlookBearer: m.resolveOutlookBearer }));
vi.mock("../mail/gmail.js", () => ({ markLinkedInboxForReconnect: m.markLinkedInboxForReconnect }));

const fetchMock = vi.fn();
vi.stubGlobal("fetch", fetchMock);

const { outlookMailActions } = await import("../mail/providers/outlook.js");

const graph = createGraphFake(fetchMock);
const ROW = "row-1";
const REPLY = { replyToProviderMessageId: ORIGINAL_ID, linkedInboxAccountId: ROW } as const;
const FILE = { filename: "brief.txt", mimeType: "text/plain", content: Buffer.from("hi") };
const CREATE = "POST /me/messages/ORIG/createReply";
const PATCH = "PATCH /me/messages/DRAFT";
const SEND = "POST /me/messages/DRAFT/send";
const DELETE_DRAFT = "DELETE /me/messages/DRAFT";
const ATTACH = "POST /me/messages/DRAFT/attachments";
const DELETE_ATTACHMENT = (id: string) => `DELETE /me/messages/DRAFT/attachments/${id}`;

const sendReply = (over: { to?: string; body?: string; attachments?: (typeof FILE)[] } = {}) =>
  outlookMailActions.sendEmail(
    "u1",
    over.to ?? "alice@example.com",
    "Re: Plan",
    over.body ?? "Thursday works.",
    over.attachments ?? [],
    REPLY,
  );
const draftReply = (over: { attachments?: (typeof FILE)[] } = {}) =>
  outlookMailActions.createDraft("u1", {
    to: "alice@example.com",
    subject: "Re: Plan",
    body: "Thursday works.",
    ...over,
    ...REPLY,
  });

/** Graph takes the patch, then the draft reads back with `override` applied on top. */
const patchReadsBackAs = (override: Record<string, unknown>): Record<string, Handler> => ({
  [PATCH]: (call, state) => {
    Object.assign(state, call.body as object, override);
    return { status: 200, body: { ...state } };
  },
});
const respondsWith =
  (status: number, body?: unknown): Handler =>
  () => ({ status, body });
const throwsOnCall =
  (error: Error): Handler =>
  () => {
    throw error;
  };

beforeEach(() => {
  vi.clearAllMocks();
  vi.spyOn(console, "warn").mockImplementation(() => {});
  m.resolveOutlookBearer.mockResolvedValue({ accessToken: "bearer-at", email: MAILBOX });
  graph.reset();
});
afterEach(() => {
  vi.restoreAllMocks();
});

describe("what will be sent is verified before /send", () => {
  it.each([
    ["a different subject", { subject: "Re: Something else" }],
    ["an html body", { body: { contentType: "html", content: "Thursday works." } }],
    ["different text", { body: { contentType: "text", content: "Friday works." } }],
    [
      "text with something appended",
      { body: { contentType: "text", content: "Thursday works.\n--\nx" } },
    ],
    ["no body at all", { body: undefined }],
  ])("refuses, discards the draft and sends nothing when Graph holds %s", async (_name, override) => {
    graph.install(patchReadsBackAs(override));
    await expect(sendReply()).rejects.toThrow(/approved/i);
    expect(graph.summary()).toEqual([CREATE, PATCH, "DELETE /me/messages/DRAFT"]);
  });

  it("refuses a draft the same way", async () => {
    graph.install(patchReadsBackAs({ body: { contentType: "html", content: "<p>x</p>" } }));
    await expect(draftReply()).rejects.toThrow(/approved/i);
    expect(graph.summary().at(-1)).toBe(DELETE_DRAFT);
  });

  it("does not put the mail's text into the error", async () => {
    graph.install(
      patchReadsBackAs({ body: { contentType: "text", content: "SECRET other text" } }),
    );
    await expect(sendReply()).rejects.not.toThrow(/SECRET|Thursday/);
  });

  it("accepts CRLF line endings for the LF text that was sent (Exchange stores text bodies with CRLF)", async () => {
    graph.install(
      patchReadsBackAs({ body: { contentType: "text", content: "Line one\r\nLine two" } }),
    );
    expect(await sendReply({ body: "Line one\nLine two" })).toMatchObject({ success: true });
  });

  it("accepts LF for approved text that carries CRLF", async () => {
    graph.install(
      patchReadsBackAs({ body: { contentType: "text", content: "Line one\nLine two" } }),
    );
    expect(await sendReply({ body: "Line one\r\nLine two" })).toMatchObject({ success: true });
  });
});

describe("attachments that createReply put on the draft are removed before ours are added", () => {
  const listing = (...ids: string[]): Record<string, Handler> => ({
    [LIST_ATTACHMENTS]: respondsWith(200, { value: ids.map((id) => ({ id })) }),
  });

  it("checks the draft's attachment list even when it reports none, because hasAttachments leaves inline images out", async () => {
    await sendReply();
    expect(graph.summary()).toContain(LIST_ATTACHMENTS);
  });

  it("deletes each inherited attachment, then adds ours, then sends", async () => {
    graph.install(listing("A1", "A2"));
    await sendReply({ attachments: [FILE] });
    expect(graph.summary()).toEqual([
      CREATE,
      PATCH,
      LIST_ATTACHMENTS,
      DELETE_ATTACHMENT("A1"),
      DELETE_ATTACHMENT("A2"),
      ATTACH,
      SEND,
    ]);
  });

  it("URL-encodes an inherited attachment's id", async () => {
    graph.install({
      ...listing("AA+/=="),
      [DELETE_ATTACHMENT("AA%2B%2F%3D%3D")]: respondsWith(204),
    });
    await sendReply();
    expect(graph.summary()).toContain(DELETE_ATTACHMENT("AA%2B%2F%3D%3D"));
  });

  it("does the same for a draft, and never sends", async () => {
    graph.install(listing("A1"));
    await draftReply();
    expect(graph.summary()).toEqual([CREATE, PATCH, LIST_ATTACHMENTS, DELETE_ATTACHMENT("A1")]);
  });

  it("a delete Graph refuses for authorization is a soft error, the draft is discarded, nothing is sent", async () => {
    graph.install({ ...listing("A1"), [DELETE_ATTACHMENT("A1")]: respondsWith(403) });
    expect(await sendReply()).toMatchObject({ error: expect.stringContaining("reconnect") });
    expect(graph.summary().at(-1)).toBe(DELETE_DRAFT);
    expect(graph.summary()).not.toContain(SEND);
  });

  it("a delete that fails throws, the draft is discarded, nothing is sent", async () => {
    graph.install({ ...listing("A1"), [DELETE_ATTACHMENT("A1")]: respondsWith(500) });
    await expect(sendReply()).rejects.toThrow(/http 500/);
    expect(graph.summary().at(-1)).toBe(DELETE_DRAFT);
    expect(graph.summary()).not.toContain(SEND);
  });

  it.each([
    ["no value list", { status: 200, body: {} }],
    ["an unreadable answer", { status: 200, unreadable: true }],
    ["an entry without an id", { status: 200, body: { value: [{}] } }],
    [
      "a further page it would not see",
      { status: 200, body: { value: [], "@odata.nextLink": "x" } },
    ],
  ] as Array<
    [string, FakeResponse]
  >)("a listing with %s cannot be trusted: the draft is discarded, nothing is sent", async (_name, response) => {
    graph.install({ [LIST_ATTACHMENTS]: () => response });
    await expect(sendReply()).rejects.toThrow(/attachment/i);
    expect(graph.summary().at(-1)).toBe(DELETE_DRAFT);
    expect(graph.summary()).not.toContain(SEND);
  });

  it("a listing refused for authorization is a soft error and the draft is discarded", async () => {
    graph.install({ [LIST_ATTACHMENTS]: respondsWith(401) });
    expect(await sendReply()).toMatchObject({ error: expect.stringContaining("reconnect") });
    expect(graph.summary().at(-1)).toBe(DELETE_DRAFT);
  });

  it("an upload Graph refuses for authorization is a soft error and the draft is discarded", async () => {
    graph.install({ [ATTACH]: respondsWith(403) });
    expect(await sendReply({ attachments: [FILE] })).toMatchObject({
      error: expect.stringContaining("reconnect"),
    });
    expect(graph.summary()).toEqual([CREATE, PATCH, LIST_ATTACHMENTS, ATTACH, DELETE_DRAFT]);
  });
});

describe("a send whose outcome is unknown is reported as such", () => {
  it.each([
    500, 502, 503, 504,
  ])("http %s on /send throws SendOutcomeUnknownError and leaves the draft", async (status) => {
    graph.install({ [SEND]: respondsWith(status) });
    const failure = await sendReply().catch((err: unknown) => err);
    expect(failure).toBeInstanceOf(SendOutcomeUnknownError);
    expect((failure as Error).cause).toMatchObject({
      message: expect.stringContaining(`http ${status}`),
    });
    expect(graph.summary()).not.toContain(DELETE_DRAFT);
  });

  it("a timeout on /send is unknown too, and the draft is left", async () => {
    const timeout = new DOMException("The operation was aborted due to timeout", "TimeoutError");
    graph.install({ [SEND]: throwsOnCall(timeout) });
    await expect(sendReply()).rejects.toBeInstanceOf(SendOutcomeUnknownError);
    expect(graph.summary()).not.toContain(DELETE_DRAFT);
  });

  it("an aborted request on /send is unknown too", async () => {
    graph.install({ [SEND]: throwsOnCall(new DOMException("aborted", "AbortError")) });
    await expect(sendReply()).rejects.toBeInstanceOf(SendOutcomeUnknownError);
  });

  it("a network error on /send is unknown too, and the draft is left", async () => {
    graph.install({ [SEND]: throwsOnCall(new TypeError("fetch failed")) });
    await expect(sendReply()).rejects.toBeInstanceOf(SendOutcomeUnknownError);
    expect(graph.summary()).not.toContain(DELETE_DRAFT);
  });

  it.each([
    400, 404, 429,
  ])("http %s on /send was rejected, so it is a plain failure and the draft is discarded", async (status) => {
    graph.install({ [SEND]: respondsWith(status) });
    const failure = await sendReply().catch((err: unknown) => err);
    expect(failure).toBeInstanceOf(Error);
    expect(failure).not.toBeInstanceOf(SendOutcomeUnknownError);
    expect((failure as Error).message).toMatch(new RegExp(`http ${status}`));
    expect(graph.summary().at(-1)).toBe(DELETE_DRAFT);
  });

  it("a 5xx before the send was never a send: createReply and PATCH failures stay plain", async () => {
    graph.install({ [CREATE]: respondsWith(502) });
    await expect(sendReply()).rejects.not.toBeInstanceOf(SendOutcomeUnknownError);
    graph.reset();
    graph.install({ [PATCH]: respondsWith(502) });
    await expect(sendReply()).rejects.not.toBeInstanceOf(SendOutcomeUnknownError);
  });

  it("the error says nothing about the mail", () => {
    const error = new SendOutcomeUnknownError({ cause: new Error("x") });
    expect(error.name).toBe("SendOutcomeUnknownError");
    expect(error.message).not.toMatch(/alice|Thursday/);
  });
});

describe("discarding a half-made draft", () => {
  it("a delete Graph refuses is logged with ids only and never marks the inbox for reconnect again", async () => {
    // PATCH is refused for authorization (which marks reconnect once), then so is the delete.
    graph.install({ [PATCH]: respondsWith(401), [DELETE_DRAFT]: respondsWith(401) });
    expect(await sendReply()).toMatchObject({ error: expect.stringContaining("reconnect") });
    expect(m.markLinkedInboxForReconnect).toHaveBeenCalledTimes(1);
    const logged = JSON.stringify(vi.mocked(console.warn).mock.calls);
    expect(logged).toContain("DRAFT");
    expect(logged).toContain(ROW);
    expect(logged).not.toMatch(/alice@example\.com|Thursday/);
  });

  it("a delete refused after a non-auth failure does not mark reconnect at all", async () => {
    graph.install({ [PATCH]: respondsWith(500), [DELETE_DRAFT]: respondsWith(403) });
    await expect(sendReply()).rejects.toThrow(/PATCH .* http 500/);
    expect(m.markLinkedInboxForReconnect).not.toHaveBeenCalled();
    expect(console.warn).toHaveBeenCalled();
  });

  it("a delete that throws is logged, and the error that caused the cleanup is what the caller sees", async () => {
    graph.install({ [PATCH]: respondsWith(500), [DELETE_DRAFT]: respondsWith(503) });
    await expect(sendReply()).rejects.toThrow(/PATCH .* http 500/);
    expect(JSON.stringify(vi.mocked(console.warn).mock.calls)).toContain("DRAFT");
  });

  it("a createReply answer whose body cannot be read cannot be cleaned up: it is logged and thrown", async () => {
    graph.install({ [CREATE]: () => ({ status: 201, unreadable: true }) });
    await expect(sendReply()).rejects.toThrow(/draft id/i);
    expect(graph.summary()).toEqual([CREATE]);
    const logged = JSON.stringify(vi.mocked(console.warn).mock.calls);
    expect(logged).toContain(ROW);
    expect(logged).toMatch(/draft/i);
  });

  it("a createReply answer with no id is logged and thrown", async () => {
    graph.install({ [CREATE]: respondsWith(201, { subject: "RE: Plan" }) });
    await expect(draftReply()).rejects.toThrow(/draft id/i);
    expect(JSON.stringify(vi.mocked(console.warn).mock.calls)).toContain(ROW);
  });
});

describe("the recipient check", () => {
  it("folds case for ASCII letters only: a look-alike letter is a different address", async () => {
    // U+212A KELVIN SIGN lowercases to "k" under toLowerCase(), so a Unicode fold would accept it.
    graph.install(patchReadsBackAs({ toRecipients: [address("K@example.com")] }));
    await expect(sendReply({ to: "k@example.com" })).rejects.toThrow(/recipient/i);
    expect(graph.summary()).not.toContain(SEND);
  });

  it("still ignores ASCII case", async () => {
    graph.install(patchReadsBackAs({ toRecipients: [address("ALICE@EXAMPLE.COM")] }));
    expect(await sendReply()).toMatchObject({ success: true });
  });

  it.each([
    "ccRecipients",
    "bccRecipients",
  ])("needs %s present and empty, as it needs To present: an answer without it is refused", async (field) => {
    graph.install({
      [PATCH]: (call, state) => {
        Object.assign(state, call.body as object);
        const { [field as "ccRecipients"]: _omitted, ...rest } = state;
        return { status: 200, body: rest };
      },
    });
    await expect(sendReply()).rejects.toThrow(/recipient/i);
    expect(graph.summary()).not.toContain(SEND);
  });

  it("refuses an empty address entry in Cc", async () => {
    graph.install(patchReadsBackAs({ ccRecipients: [{}] }));
    await expect(sendReply()).rejects.toThrow(/recipient/i);
  });
});

describe("the overall time budget of one reply", () => {
  let clock: number;
  /** Every step advances a fake clock, so a slow Graph is modelled without waiting. */
  const slowGraph = (ms: number) => {
    const inner =
      (handler: Handler): Handler =>
      (call, state) => {
        clock += ms;
        return handler(call, state);
      };
    graph.install({
      [CREATE]: inner(() => ({ status: 201, body: { ...graph.draft, isDraft: true } })),
      [PATCH]: inner((call, state) => {
        Object.assign(state, call.body as object);
        return { status: 200, body: { ...state } };
      }),
      [LIST_ATTACHMENTS]: inner(() => ({ status: 200, body: { value: [] } })),
      [SEND]: inner(() => ({ status: 202 })),
    });
  };

  beforeEach(() => {
    clock = 1_000_000;
    vi.spyOn(Date, "now").mockImplementation(() => clock);
  });

  it("stops preparing when the budget is spent, discards the draft and never sends", async () => {
    slowGraph(20_000);
    await expect(sendReply()).rejects.toThrow(/took too long/i);
    expect(graph.summary()).toEqual([CREATE, PATCH, DELETE_DRAFT]);
    expect(graph.summary()).not.toContain(SEND);
  });

  it("does not hold back the send itself: a slow but finished preparation still sends", async () => {
    slowGraph(9_000);
    expect(await sendReply()).toMatchObject({ success: true, threaded: true });
    expect(graph.summary().at(-1)).toBe(SEND);
  });

  it("never gives one call more time than the budget has left, nor more than 15 seconds", async () => {
    const timeout = vi.spyOn(AbortSignal, "timeout");
    slowGraph(20_000);
    await sendReply().catch(() => undefined);
    // createReply: the full 15 s. PATCH starts 20 s in, so 10 s of the 30 s are left.
    // The clean-up delete gets its own short budget.
    expect(timeout.mock.calls.map(([ms]) => ms)).toEqual([15_000, 10_000, 5_000]);
  });

  it("a draft has the same budget", async () => {
    slowGraph(20_000);
    await expect(draftReply()).rejects.toThrow(/took too long/i);
    expect(graph.summary()).toEqual([CREATE, PATCH, DELETE_DRAFT]);
  });

  it("keeps the plain 15 second limit for calls made outside a reply", async () => {
    const timeout = vi.spyOn(AbortSignal, "timeout");
    fetchMock.mockResolvedValue({ ok: true, status: 200, json: async () => ({}) });
    await outlookMailActions.markAsRead("u1", `outlook:${MAILBOX}:A`, ROW);
    expect(timeout.mock.calls.map(([ms]) => ms)).toEqual([15_000]);
  });
});
