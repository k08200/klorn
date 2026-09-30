/**
 * `create_draft` (step A4 of docs/providers/unified-platform-plan.md): an MCP
 * agent asks for a reply DRAFT to one email. The promises under test:
 *  - reply-only, and the recipient is pinned to the original sender: the tool has
 *    no `to`, and nothing the agent sends can steer the draft elsewhere;
 *  - the account comes from the email row, never from the agent and never the
 *    primary when the row names another account;
 *  - the reply headers come from the provider (`getReplyHeaders`), never from
 *    input;
 *  - it never sends: no send path is reachable.
 * The database is the strict fake (it evaluates the real `where`); the provider
 * seam is faked so each call is observable.
 */

import { readFileSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { MailProviderActions } from "../mail/providers/types.js";
import { createFakeDb, type FakeDb } from "./helpers/fake-db.js";

const dbHolder = vi.hoisted(() => ({ current: null as unknown }));
const mailActionsFor = vi.hoisted(() => vi.fn());
const captureError = vi.hoisted(() => vi.fn());

vi.mock("../db.js", async () => {
  const { fakePrismaClient } = await import("./helpers/fake-db.js");
  const prisma = fakePrismaClient(() => dbHolder.current as FakeDb);
  return { prisma, db: prisma };
});
vi.mock("../sentry.js", () => ({ captureError }));
vi.mock("../mail/providers/dispatch.js", () => ({ mailActionsFor }));

import { MAX_SUBJECT_LENGTH } from "../mail/reply-subject.js";
import {
  CREATE_DRAFT_TOOL,
  CREATE_DRAFT_TOOL_NAME,
  createReplyDraft,
  executeCreateDraft,
  MAX_DRAFT_BODY_LENGTH,
} from "../mcp/create-draft.js";
import { DRAFT_DEDUPE_WINDOW_MS, recentDraftCount } from "../mcp/draft-dedupe.js";

const BODY = "Thanks, Thursday works for me.\n\nBest,\nYongrean";
const cp = (...codes: number[]) => String.fromCodePoint(...codes);
const LS = cp(0x2028);
const RLO = cp(0x202e);
const ZWSP = cp(0x200b);
const EMOJI = cp(0x1f4c5);

/** A fresh user per test: the duplicate-draft memory lives in module state by design. */
let seq = 0;
let USER: string;
let ctx: { userId: string };
let bodySeq = 0;
/** A body no earlier call in this file used, for tests that draft more than once. */
const freshBody = () => `${BODY} (${++bodySeq})`;

let db: FakeDb;
/** Every provider double made in a test, so the no-send check covers them all. */
let made: Array<{ sendEmail: ReturnType<typeof vi.fn> }>;

type ActionOverrides = Partial<Record<keyof MailProviderActions, unknown>>;

function fakeActions(provider = "GOOGLE", overrides: ActionOverrides = {}) {
  const actions = {
    provider,
    sendEmail: vi.fn(async () => ({ success: true })),
    createDraft: vi.fn(async () => ({
      success: true,
      draftId: "draft-1",
      messageId: "msg-1",
      url: "https://mail.google.com/mail/u/0/#drafts",
    })),
    getReplyHeaders: vi.fn(async () => ({
      messageId: "<orig@mail.example>",
      references: "<root@mail.example>",
    })),
    ...overrides,
  };
  made = [...made, actions as { sendEmail: ReturnType<typeof vi.fn> }];
  return actions;
}

/** Install `actions` as what the dispatcher resolves, and return it typed for assertions. */
function useProvider(provider = "GOOGLE", overrides: ActionOverrides = {}) {
  const actions = fakeActions(provider, overrides);
  mailActionsFor.mockResolvedValue(actions);
  return actions;
}

const run = async (args: Record<string, unknown>) =>
  JSON.parse(await executeCreateDraft(ctx, args)) as Record<string, unknown>;

const valid = (extra: Record<string, unknown> = {}) => ({
  email_id: "gm-1",
  body: BODY,
  ...extra,
});

beforeEach(() => {
  made = [];
  seq += 1;
  USER = `draft-user-${seq}`;
  ctx = { userId: USER };
  captureError.mockReset();
  mailActionsFor.mockReset();
  db = createFakeDb({
    emailMessage: [
      {
        id: "email-db-1",
        userId: USER,
        gmailId: "gm-1",
        threadId: "thread-1",
        from: "Alice Kim <alice@example.com>",
        subject: "Quarterly plan",
        linkedInboxAccountId: null,
      },
      {
        id: "email-db-2",
        userId: USER,
        gmailId: "gm-2",
        threadId: "thread-2",
        from: "Bob <bob@example.org>",
        subject: "Re: Lunch",
        linkedInboxAccountId: "acct-2",
      },
      {
        id: "email-foreign",
        userId: "someone-else",
        gmailId: "gm-foreign",
        threadId: "thread-x",
        from: "Mallory <mallory@example.net>",
        subject: "Not yours",
        linkedInboxAccountId: null,
      },
    ],
  });
  dbHolder.current = db;
});

afterEach(() => {
  // The promise this whole tool rests on, asserted on every test in this file.
  for (const actions of made) expect(actions.sendEmail).not.toHaveBeenCalled();
});

describe("the tool definition", () => {
  const params = CREATE_DRAFT_TOOL.function.parameters as {
    properties: Record<string, { type: string; maxLength?: number }>;
    required: string[];
    additionalProperties: boolean;
  };

  it("is named create_draft", () => {
    expect(CREATE_DRAFT_TOOL_NAME).toBe("create_draft");
    expect(CREATE_DRAFT_TOOL.function.name).toBe("create_draft");
  });

  it("offers exactly email_id, body and subject: no recipient, no headers, no html, no attachments", () => {
    expect(Object.keys(params.properties).sort()).toEqual(["body", "email_id", "subject"]);
    expect(params.required).toEqual(["email_id", "body"]);
    expect(params.additionalProperties).toBe(false);
  });

  it("publishes the same length bounds the server enforces", () => {
    expect(params.properties.body.maxLength).toBe(MAX_DRAFT_BODY_LENGTH);
    expect(params.properties.subject.maxLength).toBe(MAX_SUBJECT_LENGTH);
    expect(MAX_DRAFT_BODY_LENGTH).toBe(20_000);
  });

  it("tells the agent it only drafts, to the original sender", () => {
    expect(CREATE_DRAFT_TOOL.function.description).toMatch(/never sent/i);
    expect(CREATE_DRAFT_TOOL.function.description).toMatch(/original sender/i);
  });

  it("no longer tells the agent that Outlook is unavailable", () => {
    expect(CREATE_DRAFT_TOOL.function.description).not.toMatch(/outlook/i);
  });
});

describe("a Gmail draft — the success path", () => {
  it("creates the reply draft and answers {draft_id, provider, to}", async () => {
    const actions = useProvider();
    expect(await run(valid())).toEqual({
      success: true,
      draft_id: "draft-1",
      provider: "GOOGLE",
      to: "alice@example.com",
    });
    expect(actions.createDraft).toHaveBeenCalledTimes(1);
  });

  it("hands the provider the pinned recipient, derived subject, the row's thread and the server-resolved reply headers", async () => {
    const actions = useProvider();
    await run(valid());
    const [userId, draft] = actions.createDraft.mock.calls[0] as unknown as [
      string,
      Record<string, unknown>,
    ];
    expect(userId).toBe(USER);
    expect(draft).toEqual({
      to: "alice@example.com",
      subject: "Re: Quarterly plan",
      body: BODY,
      threadId: "thread-1",
      linkedInboxAccountId: null,
      reply: {
        inReplyTo: "<orig@mail.example>",
        references: "<root@mail.example> <orig@mail.example>",
      },
    });
    // No attachments key at all: a draft made here can never carry a file.
    expect(Object.keys(draft).sort()).toEqual([
      "body",
      "linkedInboxAccountId",
      "reply",
      "subject",
      "threadId",
      "to",
    ]);
  });

  it("accepts the Klorn row id as well as the provider id", async () => {
    const actions = useProvider();
    const out = await run(valid({ email_id: "email-db-1" }));
    expect(out).toMatchObject({ success: true, to: "alice@example.com" });
    // The provider is asked about the PROVIDER id of the row, not the id the agent typed.
    expect(actions.getReplyHeaders).toHaveBeenCalledWith(USER, "gm-1", null);
  });

  it("answers draft_id null (still a success) when the provider returns no id", async () => {
    useProvider("GOOGLE", { createDraft: vi.fn(async () => ({ success: true, url: "u" })) });
    expect(await run(valid())).toMatchObject({ success: true, draft_id: null });
  });

  it("reads only the email row: no other table is touched and nothing is written locally", async () => {
    useProvider();
    await run(valid());
    expect(db.reads).toEqual(["emailMessage"]);
    expect(db.writes).toEqual({});
  });
});

describe("resolution: the row decides, scoped to the caller", () => {
  it("an id that belongs to another user is not found, and nothing is asked of any provider", async () => {
    const actions = useProvider();
    for (const id of ["email-foreign", "gm-foreign"]) {
      expect(await run(valid({ email_id: id }))).toMatchObject({ code: "NOT_FOUND" });
    }
    expect(mailActionsFor).not.toHaveBeenCalled();
    expect(actions.getReplyHeaders).not.toHaveBeenCalled();
    expect(actions.createDraft).not.toHaveBeenCalled();
  });

  it("an unknown id is not found", async () => {
    const actions = useProvider();
    expect(await run(valid({ email_id: "no-such-mail" }))).toMatchObject({ code: "NOT_FOUND" });
    expect(actions.createDraft).not.toHaveBeenCalled();
  });

  it("a mail of a linked inbox is drafted on THAT account at every step, never the primary", async () => {
    const actions = useProvider();
    await run(valid({ email_id: "gm-2" }));
    expect(mailActionsFor).toHaveBeenCalledWith(USER, "acct-2");
    expect(actions.getReplyHeaders).toHaveBeenCalledWith(USER, "gm-2", "acct-2");
    expect(actions.createDraft.mock.calls[0]?.[1]).toMatchObject({
      linkedInboxAccountId: "acct-2",
      threadId: "thread-2",
      to: "bob@example.org",
      subject: "Re: Lunch",
    });
  });

  it("a primary-inbox mail resolves the primary (null), not some linked account", async () => {
    useProvider();
    await run(valid());
    expect(mailActionsFor).toHaveBeenCalledWith(USER, null);
  });

  it("returns the provider named by the dispatcher, not a hard-coded one", async () => {
    useProvider("ICLOUD", {
      createDraft: vi.fn(async () => ({ success: true, draftId: "d-9", url: "u" })),
    });
    expect(await run(valid({ email_id: "gm-2" }))).toMatchObject({ provider: "ICLOUD" });
  });
});

describe("Outlook drafts natively (step B0b)", () => {
  const outlook = (overrides: ActionOverrides = {}) =>
    useProvider("OUTLOOK", {
      nativeReply: true,
      // The Graph path threads by the original's id; it has no header text to give.
      getReplyHeaders: vi.fn(async () => ({})),
      ...overrides,
    });

  it("creates the draft: the original sender as recipient, the row's provider id as the reply target, no header context", async () => {
    const actions = outlook();
    expect(await run(valid({ email_id: "gm-2" }))).toEqual({
      success: true,
      draft_id: "draft-1",
      provider: "OUTLOOK",
      to: "bob@example.org",
    });
    expect(actions.createDraft).toHaveBeenCalledTimes(1);
    expect(actions.createDraft.mock.calls[0]?.[1]).toEqual({
      to: "bob@example.org",
      subject: "Re: Lunch",
      body: BODY,
      threadId: "thread-2",
      linkedInboxAccountId: "acct-2",
      replyToProviderMessageId: "gm-2",
    });
  });

  it("takes the reply target from the stored row, never from the id the agent typed", async () => {
    const actions = outlook();
    await run(valid({ email_id: "email-db-2" }));
    const draft = actions.createDraft.mock.calls[0]?.[1] as { replyToProviderMessageId?: string };
    expect(draft.replyToProviderMessageId).toBe("gm-2");
    expect(draft.replyToProviderMessageId).not.toBe("email-db-2");
  });

  it("never lets the agent name the reply target or the recipient: every such argument is refused", async () => {
    const actions = outlook();
    const attempts: Array<Record<string, unknown>> = [
      { replyToProviderMessageId: "gm-1" },
      { reply_to_message_id: "gm-1" },
      { in_reply_to_email_id: "gm-1" },
      { provider_message_id: "gm-1" },
      { to: "attacker@evil.test" },
    ];
    for (const extra of attempts) {
      expect(await run(valid({ email_id: "gm-2", ...extra })), JSON.stringify(extra)).toMatchObject(
        {
          code: "INVALID_ARGUMENT",
        },
      );
    }
    expect(actions.createDraft).not.toHaveBeenCalled();
  });

  it("stays pinned to the original From however the original addresses replies", async () => {
    // Graph's createReply would address the original's Reply-To. The recipient handed
    // to the provider is the parsed From, and the provider sets it explicitly.
    const actions = outlook();
    await run(valid({ email_id: "gm-2" }));
    expect((actions.createDraft.mock.calls[0]?.[1] as { to: string }).to).toBe("bob@example.org");
  });

  it("answers a soft Outlook failure (mailbox not connected) unchanged and remembers nothing", async () => {
    const before = recentDraftCount();
    const failure = { error: "Outlook account is not connected" };
    outlook({ createDraft: vi.fn(async () => failure) });
    expect(await executeCreateDraft(ctx, valid({ email_id: "gm-2" }))).toBe(
      JSON.stringify(failure),
    );
    expect(recentDraftCount()).toBe(before);
  });

  it("a hard Graph failure is answered generically, without the provider's text", async () => {
    outlook({
      createDraft: vi.fn(async () => {
        throw new Error("Graph POST /me/messages/SECRET/createReply failed: http 500");
      }),
    });
    const text = await executeCreateDraft(ctx, valid({ email_id: "gm-2" }));
    expect(JSON.parse(text)).toMatchObject({ code: "UNAVAILABLE" });
    expect(text).not.toContain("SECRET");
  });
});

describe("providers that cannot hold a draft", () => {
  it("a provider whose createDraft is unsupported has its result returned unchanged", async () => {
    const refusal = {
      unsupported: true,
      error: "This mailbox's provider does not support drafts from Klorn yet.",
    };
    const actions = useProvider("NAVER", { createDraft: vi.fn(async () => refusal) });
    expect(await executeCreateDraft(ctx, valid({ email_id: "gm-2" }))).toBe(
      JSON.stringify(refusal),
    );
    expect(actions.createDraft).toHaveBeenCalledTimes(1);
  });

  it("a soft provider failure (not connected, no-reply sender) is returned unchanged", async () => {
    for (const failure of [
      { error: "Gmail not connected." },
      {
        error:
          "This address (noreply@x.com) is a no-reply system sender. Klorn will not create a Gmail draft.",
      },
    ]) {
      useProvider("GOOGLE", { createDraft: vi.fn(async () => failure) });
      expect(await executeCreateDraft(ctx, valid())).toBe(JSON.stringify(failure));
    }
  });

  it("a hard provider failure is captured and answered generically, never with the provider's message", async () => {
    useProvider("GOOGLE", {
      createDraft: vi.fn(async () => {
        throw new Error("socket hang up at 10.0.0.7:443 token=ya29.secret");
      }),
    });
    const text = await executeCreateDraft(ctx, valid());
    expect(JSON.parse(text)).toMatchObject({ code: "UNAVAILABLE" });
    expect(text).not.toContain("10.0.0.7");
    expect(text).not.toContain("ya29");
    expect(captureError).toHaveBeenCalledTimes(1);
  });

  it("a failed header fetch that throws is also generic (the draft is never attempted)", async () => {
    const actions = useProvider("GOOGLE", {
      getReplyHeaders: vi.fn(async () => {
        throw new Error("boom");
      }),
    });
    expect(await run(valid())).toMatchObject({ code: "UNAVAILABLE" });
    expect(actions.createDraft).not.toHaveBeenCalled();
  });

  it("a database failure is generic too", async () => {
    useProvider();
    const broken = createFakeDb({ emailMessage: [] });
    broken.model("emailMessage").findFirst = async () => {
      throw new Error("connection terminated");
    };
    dbHolder.current = broken;
    const text = await executeCreateDraft(ctx, valid());
    expect(JSON.parse(text)).toMatchObject({ code: "UNAVAILABLE" });
    expect(text).not.toContain("connection terminated");
  });
});

describe("threading: the server resolves the headers, the caller cannot supply any", () => {
  it("asks the provider for the headers of the original message and passes them on as `reply`", async () => {
    const actions = useProvider();
    await run(valid());
    expect(actions.getReplyHeaders).toHaveBeenCalledTimes(1);
    expect(actions.getReplyHeaders).toHaveBeenCalledWith(USER, "gm-1", null);
    expect(actions.createDraft.mock.calls[0]?.[1]).toMatchObject({
      reply: {
        inReplyTo: "<orig@mail.example>",
        references: "<root@mail.example> <orig@mail.example>",
      },
    });
  });

  it("with only the message id, References is that id alone", async () => {
    const actions = useProvider("GOOGLE", {
      getReplyHeaders: vi.fn(async () => ({ messageId: "<only@mail.example>" })),
    });
    await run(valid());
    expect(actions.createDraft.mock.calls[0]?.[1]).toMatchObject({
      reply: { inReplyTo: "<only@mail.example>", references: "<only@mail.example>" },
    });
  });

  it("with only a References chain, there is no In-Reply-To", async () => {
    const actions = useProvider("GOOGLE", {
      getReplyHeaders: vi.fn(async () => ({ references: "<a@x> <b@x>" })),
    });
    await run(valid());
    const reply = (actions.createDraft.mock.calls[0]?.[1] as { reply: Record<string, unknown> })
      .reply;
    expect(reply).toEqual({ references: "<a@x> <b@x>" });
  });

  it("when the provider has no headers (best-effort {}), the draft goes out with no reply key and threads by threadId alone", async () => {
    const actions = useProvider("GOOGLE", { getReplyHeaders: vi.fn(async () => ({})) });
    expect(await run(valid())).toMatchObject({ success: true });
    const draft = actions.createDraft.mock.calls[0]?.[1] as Record<string, unknown>;
    expect(draft).not.toHaveProperty("reply");
    expect(draft.threadId).toBe("thread-1");
  });

  it("refuses any header-shaped argument outright, and creates nothing", async () => {
    const actions = useProvider();
    const attempts: Array<Record<string, unknown>> = [
      { in_reply_to: "<evil@x>" },
      { inReplyTo: "<evil@x>" },
      { references: "<evil@x>" },
      { reply: { inReplyTo: "<evil@x>", references: "<evil@x>" } },
      { headers: { "In-Reply-To": "<evil@x>" } },
      { thread_id: "someone-elses-thread" },
      { threadId: "someone-elses-thread" },
    ];
    for (const extra of attempts) {
      expect(await run(valid(extra)), JSON.stringify(extra)).toMatchObject({
        code: "INVALID_ARGUMENT",
      });
    }
    expect(actions.createDraft).not.toHaveBeenCalled();
    expect(actions.getReplyHeaders).not.toHaveBeenCalled();
  });
});

describe("the recipient is pinned", () => {
  it("is the original sender's address only, display name dropped", async () => {
    const actions = useProvider();
    await run(valid());
    expect(actions.createDraft.mock.calls[0]?.[1]).toMatchObject({ to: "alice@example.com" });
  });

  it("refuses every recipient-shaped argument outright, so a hostile mail cannot redirect the agent's draft", async () => {
    const actions = useProvider();
    const attempts: Array<Record<string, unknown>> = [
      { to: "attacker@evil.test" },
      { recipient: "attacker@evil.test" },
      { cc: "attacker@evil.test" },
      { bcc: "attacker@evil.test" },
      { reply_to: "attacker@evil.test" },
      { from: "attacker@evil.test" },
      { to: ["attacker@evil.test"] },
    ];
    for (const extra of attempts) {
      expect(await run(valid(extra)), JSON.stringify(extra)).toMatchObject({
        code: "INVALID_ARGUMENT",
      });
    }
    expect(actions.createDraft).not.toHaveBeenCalled();
  });

  it("even a caller that reaches the inner function with a `to` cannot move the recipient", async () => {
    const actions = useProvider();
    const smuggled = { emailId: "gm-1", body: BODY, subject: null, to: "attacker@evil.test" };
    await createReplyDraft(ctx, smuggled as never);
    expect(actions.createDraft.mock.calls[0]?.[1]).toMatchObject({ to: "alice@example.com" });
  });

  it("ignores a Reply-To header even when a provider supplies one: the sender controls it, so it never picks the recipient", async () => {
    for (const replyTo of [
      "Support Desk <support@example.org>",
      "a@x.com, b@y.com",
      "attacker@evil.test",
    ]) {
      const actions = useProvider("GOOGLE", {
        getReplyHeaders: vi.fn(async () => ({ messageId: "<m@x>", replyTo })),
      });
      expect(await run(valid({ body: freshBody() })), replyTo).toMatchObject({
        to: "alice@example.com",
      });
      expect(actions.createDraft.mock.calls[0]?.[1], replyTo).toMatchObject({
        to: "alice@example.com",
      });
    }
  });

  it("an unusable From is refused before ANY provider call, not guessed at", async () => {
    const actions = useProvider();
    for (const from of ["a@x.com, b@y.com", "", "undisclosed-recipients:;", "no at sign"]) {
      Object.assign(db.tables.emailMessage[0], { from });
      expect(await run(valid()), from).toMatchObject({ code: "NO_REPLY_ADDRESS" });
    }
    expect(mailActionsFor).not.toHaveBeenCalled();
    expect(actions.getReplyHeaders).not.toHaveBeenCalled();
    expect(actions.createDraft).not.toHaveBeenCalled();
  });

  it("takes a From with a comment in the display name", async () => {
    const actions = useProvider();
    Object.assign(db.tables.emailMessage[0], { from: "Jane Doe (Acme) <jane@acme.com>" });
    expect(await run(valid())).toMatchObject({ to: "jane@acme.com" });
    expect(actions.createDraft.mock.calls[0]?.[1]).toMatchObject({ to: "jane@acme.com" });
  });
});

describe("subject", () => {
  const subjectSent = async (args: Record<string, unknown>, actions = useProvider()) => {
    await run(valid({ body: freshBody(), ...args }));
    return (actions.createDraft.mock.calls[0]?.[1] as { subject: string }).subject;
  };

  it("is Re: <original> when none is given, or when it is null", async () => {
    expect(await subjectSent({})).toBe("Re: Quarterly plan");
    expect(await subjectSent({ subject: null })).toBe("Re: Quarterly plan");
  });

  it("does not double Re:", async () => {
    const actions = useProvider();
    await run(valid({ email_id: "gm-2" }));
    expect((actions.createDraft.mock.calls[0]?.[1] as { subject: string }).subject).toBe(
      "Re: Lunch",
    );
  });

  it("uses the subject the agent gave, trimmed", async () => {
    expect(await subjectSent({ subject: "  Thursday works  " })).toBe("Thursday works");
  });

  it("accepts a subject of exactly the cap, non-ASCII included", async () => {
    expect(await subjectSent({ subject: "x".repeat(MAX_SUBJECT_LENGTH) })).toHaveLength(
      MAX_SUBJECT_LENGTH,
    );
    expect(await subjectSent({ subject: "회의 \u{1F4C5}" })).toBe("회의 \u{1F4C5}");
  });

  const refused: Array<[string, unknown]> = [
    ["an interior CRLF (header injection)", "Hi\r\nBcc: attacker@evil.test"],
    ["an interior LF", "Hi\nBcc: attacker@evil.test"],
    ["an interior CR", "Hi\rBcc: attacker@evil.test"],
    ["a trailing CRLF (it must not be trimmed away)", "Hi\r\n"],
    ["a leading LF", "\nHi"],
    ["a NUL byte", "Hi\u0000there"],
    ["a unicode line separator", `Hi${LS}there`],
    ["only invisible characters", `${ZWSP}${RLO}`],
    ["a tab", "Hi\tthere"],
    ["a subject one over the cap", "x".repeat(MAX_SUBJECT_LENGTH + 1)],
    ["an empty string", ""],
    ["whitespace only", "   "],
    ["a number", 7],
    ["an object", { text: "Hi" }],
    ["an array", ["Hi"]],
  ];
  for (const [label, subject] of refused) {
    it(`refuses ${label}, and creates nothing`, async () => {
      const actions = useProvider();
      expect(await run(valid({ subject }))).toMatchObject({ code: "INVALID_ARGUMENT" });
      expect(actions.createDraft).not.toHaveBeenCalled();
    });
  }

  it("strips bidi and zero-width controls from a supplied subject and from the derived one", async () => {
    expect(await subjectSent({ subject: `Invoice ${RLO}fdp.exe` })).toBe("Invoice fdp.exe");
    Object.assign(db.tables.emailMessage[0], { subject: `pay${ZWSP}pal` });
    expect(await subjectSent({})).toBe("Re: paypal");
  });

  it("measures the subject cap in code points: a cap's worth of emoji is accepted", async () => {
    const subject = EMOJI.repeat(MAX_SUBJECT_LENGTH);
    expect(await subjectSent({ subject })).toBe(subject);
    const actions = useProvider();
    expect(
      await run(valid({ body: freshBody(), subject: EMOJI.repeat(MAX_SUBJECT_LENGTH + 1) })),
    ).toMatchObject({ code: "INVALID_ARGUMENT" });
    expect(actions.createDraft).not.toHaveBeenCalled();
  });

  it("flattens control characters in the ORIGINAL subject when it derives the reply subject", async () => {
    Object.assign(db.tables.emailMessage[0], { subject: "Hello\r\nBcc: attacker@evil.test" });
    expect(await subjectSent({})).toBe("Re: Hello Bcc: attacker@evil.test");
  });
});

describe("body", () => {
  const bodySent = async (body: string) => {
    const actions = useProvider();
    await run(valid({ body }));
    return (actions.createDraft.mock.calls[0]?.[1] as { body: string }).body;
  };

  it("passes the text through exactly: newlines, unicode and emoji untouched", async () => {
    const text = "안녕하세요,\n\n  일정 확인했습니다. \u{1F44D}\r\n\nThanks";
    expect(await bodySent(text)).toBe(text);
  });

  it("accepts exactly the cap", async () => {
    expect(await bodySent("x".repeat(MAX_DRAFT_BODY_LENGTH))).toHaveLength(MAX_DRAFT_BODY_LENGTH);
  });

  it("measures the cap in code points, like the schema's maxLength: a cap's worth of emoji is accepted, one more is not", async () => {
    const atCap = EMOJI.repeat(MAX_DRAFT_BODY_LENGTH);
    expect(await bodySent(atCap)).toBe(atCap);
    const actions = useProvider();
    const out = await run({ email_id: "gm-1", body: EMOJI.repeat(MAX_DRAFT_BODY_LENGTH + 1) });
    expect(out).toMatchObject({ code: "INVALID_ARGUMENT" });
    expect(actions.createDraft).not.toHaveBeenCalled();
  });

  it("does not interpret markup: HTML-looking text is handed over as the plain text it is", async () => {
    const text = "<b>bold</b> & <script>alert(1)</script>";
    expect(await bodySent(text)).toBe(text);
  });

  const refused: Array<[string, unknown]> = [
    ["a missing body", undefined],
    ["null", null],
    ["an empty string", ""],
    ["whitespace only", " \n\t "],
    ["a number", 5],
    ["an object", { text: "hi" }],
    ["an array", ["hi"]],
    ["one character over the cap", "x".repeat(MAX_DRAFT_BODY_LENGTH + 1)],
    ["a NUL byte", "hello\u0000world"],
  ];
  for (const [label, body] of refused) {
    it(`refuses ${label}, and reads nothing`, async () => {
      const actions = useProvider();
      expect(await run({ email_id: "gm-1", body })).toMatchObject({ code: "INVALID_ARGUMENT" });
      expect(actions.createDraft).not.toHaveBeenCalled();
      expect(db.reads).toEqual([]);
    });
  }

  it("refuses html and attachment arguments outright", async () => {
    const actions = useProvider();
    for (const extra of [
      { html: "<p>hi</p>" },
      { html_body: "<p>hi</p>" },
      { attachments: [{ filename: "a.txt" }] },
      { attachment_ids: ["att-1"] },
      { include_brief_attachment: true },
    ]) {
      expect(await run(valid(extra)), JSON.stringify(extra)).toMatchObject({
        code: "INVALID_ARGUMENT",
      });
    }
    expect(actions.createDraft).not.toHaveBeenCalled();
  });
});

describe("email_id", () => {
  const refused: Array<[string, unknown]> = [
    ["missing", undefined],
    ["null", null],
    ["a number", 42],
    ["an object", { id: "gm-1" }],
    ["empty", ""],
    ["blank", "   "],
    ["over 256 characters", "g".repeat(257)],
  ];
  for (const [label, email_id] of refused) {
    it(`refuses ${label} before touching the database`, async () => {
      const actions = useProvider();
      expect(await run({ email_id, body: BODY })).toMatchObject({ code: "INVALID_ARGUMENT" });
      expect(db.reads).toEqual([]);
      expect(mailActionsFor).not.toHaveBeenCalled();
      expect(actions.createDraft).not.toHaveBeenCalled();
    });
  }

  it("trims the id it looks up", async () => {
    useProvider();
    expect(await run(valid({ email_id: "  gm-1  " }))).toMatchObject({ success: true });
  });
});

describe("it never sends", () => {
  it("does not call sendEmail on any path: success, refusal, unsupported, error", async () => {
    const actions = useProvider();
    await run(valid());
    await run(valid({ to: "x@y.co" }));
    await run(valid({ email_id: "no-such-mail" }));
    useProvider("OUTLOOK", { nativeReply: true });
    await run(valid({ email_id: "gm-2" }));
    // The afterEach above re-checks every double this test made.
    expect(actions.sendEmail).not.toHaveBeenCalled();
  });

  it("has no send path in the module: no sendEmail / send_email / executeToolCall / gmail import", () => {
    const modules = [
      "mcp/create-draft.ts",
      "mcp/draft-dedupe.ts",
      "mail/single-address.ts",
      "mail/reply-subject.ts",
      "mail/header-text.ts",
      "mail/email-lookup.ts",
    ];
    for (const file of modules) {
      const source = readFileSync(new URL(`../${file}`, import.meta.url), "utf8");
      expect(source, file).not.toMatch(/sendEmail|send_email|executeToolCall|sendMessage/);
      expect(source, file).not.toMatch(/from "\.\.\/mail\/gmail\.js"/);
      expect(source, file).not.toMatch(/from "\.\.\/agentcore\//);
    }
  });
});

describe("hygiene", () => {
  it("never mutates the arguments it is given", async () => {
    useProvider();
    const args = Object.freeze({ email_id: "gm-1", body: BODY, subject: "Hi" });
    expect(await executeCreateDraft(ctx, args)).toContain('"success":true');
  });

  it("tolerates arguments that are not an object", async () => {
    const actions = useProvider();
    for (const args of [null, undefined, "gm-1", 7, [] as unknown as Record<string, unknown>]) {
      const out = JSON.parse(await executeCreateDraft(ctx, args as never));
      expect(out.code).toBe("INVALID_ARGUMENT");
    }
    expect(actions.createDraft).not.toHaveBeenCalled();
  });

  it("errors carry a code and a message, and the message never echoes the agent's input", async () => {
    useProvider();
    const out = await run({ email_id: "gm-1", body: BODY, to: "attacker@evil.test" });
    expect(JSON.stringify(out)).not.toContain("attacker@evil.test");
    expect(out).toEqual({ error: expect.any(String), code: "INVALID_ARGUMENT" });
  });
});

describe("duplicate drafts: a retry of the same draft returns the first one", () => {
  const sameCall = (extra: Record<string, unknown> = {}) => valid({ body: "Same text.", ...extra });

  it("a second identical call within the window returns the FIRST draft id and creates nothing", async () => {
    const actions = useProvider();
    const first = await run(sameCall());
    const second = await run(sameCall());
    expect(first).toEqual({
      success: true,
      draft_id: "draft-1",
      provider: "GOOGLE",
      to: "alice@example.com",
    });
    expect(second).toEqual({ ...first, deduplicated: true });
    expect(actions.createDraft).toHaveBeenCalledTimes(1);
    expect(mailActionsFor).toHaveBeenCalledTimes(1);
    expect(actions.getReplyHeaders).toHaveBeenCalledTimes(1);
  });

  it("the same draft addressed by the other id form (Klorn id vs provider id) is still the same draft", async () => {
    const actions = useProvider();
    await run(sameCall({ email_id: "gm-1" }));
    expect(await run(sameCall({ email_id: "email-db-1" }))).toMatchObject({ deduplicated: true });
    expect(actions.createDraft).toHaveBeenCalledTimes(1);
  });

  it("a different body, subject or email is a different draft", async () => {
    const actions = useProvider();
    await run(sameCall());
    expect(await run(sameCall({ body: "Other text." }))).not.toHaveProperty("deduplicated");
    expect(await run(sameCall({ subject: "A new subject" }))).not.toHaveProperty("deduplicated");
    expect(await run(sameCall({ email_id: "gm-2" }))).not.toHaveProperty("deduplicated");
    expect(actions.createDraft).toHaveBeenCalledTimes(4);
  });

  it("another user's identical call is its own draft (memory is per user)", async () => {
    const actions = useProvider();
    await run(sameCall());
    const other = `${USER}-other`;
    db.tables.emailMessage.push({ ...db.tables.emailMessage[0], id: "row-other", userId: other });
    const result = JSON.parse(await executeCreateDraft({ userId: other }, sameCall()));
    expect(result).toMatchObject({ success: true });
    expect(result).not.toHaveProperty("deduplicated");
    expect(actions.createDraft).toHaveBeenCalledTimes(2);
  });

  it("forgets after the window, so a deliberate later draft is created", async () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date("2026-09-30T10:00:00.000Z"));
      const actions = useProvider();
      await run(sameCall());
      vi.advanceTimersByTime(DRAFT_DEDUPE_WINDOW_MS - 1);
      expect(await run(sameCall())).toMatchObject({ deduplicated: true });
      vi.advanceTimersByTime(1);
      expect(await run(sameCall())).not.toHaveProperty("deduplicated");
      expect(actions.createDraft).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it("does not remember a failed attempt: the retry creates the draft", async () => {
    const createDraft = vi
      .fn()
      .mockResolvedValueOnce({ error: "Gmail not connected." })
      .mockResolvedValueOnce({ success: true, draftId: "draft-2", url: "u" });
    useProvider("GOOGLE", { createDraft });
    expect(await run(sameCall())).toEqual({ error: "Gmail not connected." });
    expect(await run(sameCall())).toMatchObject({ success: true, draft_id: "draft-2" });
    expect(createDraft).toHaveBeenCalledTimes(2);
  });

  it("does not remember a draft that came back with no id (there is nothing to return later)", async () => {
    const createDraft = vi.fn(async () => ({ success: true, url: "u" }));
    useProvider("GOOGLE", { createDraft });
    await run(sameCall());
    await run(sameCall());
    expect(createDraft).toHaveBeenCalledTimes(2);
  });

  it("remembers only what was really created: a refusal or an unsupported mailbox leaves nothing behind", async () => {
    const before = recentDraftCount();
    useProvider("NAVER", {
      createDraft: vi.fn(async () => ({ unsupported: true, error: "No drafts here." })),
    });
    await run(sameCall({ email_id: "gm-2" }));
    await run(sameCall({ to: "x@y.co" }));
    await run(sameCall({ email_id: "no-such-mail" }));
    expect(recentDraftCount()).toBe(before);
  });
});
