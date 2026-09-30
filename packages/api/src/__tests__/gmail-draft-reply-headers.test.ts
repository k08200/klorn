/**
 * Step B0: reply threading headers on Gmail drafts and sends.
 *
 * `createEmailDraft` and `sendEmail` build their MIME through one builder, and
 * reply headers go through `mail/reply-headers.ts` on both paths. These tests
 * decode the `raw` payload handed to the Gmail API and pin: In-Reply-To and
 * References appear (as parsed message ids) when given, the no-reply MIME is
 * byte-identical to what the builder produced before B0 for both the plain and
 * the multipart branch, header order is fixed, injection input never reaches a
 * header on either path, and the linked inbox account id still selects the
 * account.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const m = vi.hoisted(() => ({
  userTokenFindFirst: vi.fn(),
  linkedFindFirst: vi.fn(),
  linkedUpdateMany: vi.fn(async () => ({ count: 1 })),
  draftsCreate: vi.fn(),
  messagesSend: vi.fn(),
}));

vi.mock("../db.js", () => {
  const prisma = {
    userToken: { findFirst: m.userTokenFindFirst },
    linkedInboxAccount: { findFirst: m.linkedFindFirst, updateMany: m.linkedUpdateMany },
  };
  return { prisma, db: prisma };
});
vi.mock("../crypto-tokens.js", () => ({
  decryptToken: (v: string) => `plain:${v}`,
  decryptOptional: (v: string | null) => (v ? `plain:${v}` : null),
  encryptToken: (v: string) => `enc:${v}`,
  encryptOptional: (v: string | null) => (v ? `enc:${v}` : null),
}));
vi.mock("googleapis", () => ({
  google: {
    auth: {
      OAuth2: class {
        setCredentials() {}
        on() {}
      },
    },
    gmail: () => ({
      users: { drafts: { create: m.draftsCreate }, messages: { send: m.messagesSend } },
    }),
  },
}));

import { createEmailDraft, sendEmail } from "../mail/gmail.js";
import { MAX_HEADER_LINE_LENGTH } from "../mail/reply-headers.js";

const CRLF = "\r\n";
/** Separators and control characters that must never reach a header line. */
const FORBIDDEN_CHARS = ["\u2028", "\u2029", "\u0085", "\u0000", "\u007f"];
const ORIGINAL_ID = "<orig-1@mail.example.com>";
const CHAIN = "<root@mail.example.com> <mid@mail.example.com>";
const REFERENCES = `${CHAIN} ${ORIGINAL_ID}`;

const BASE = { to: "boss@corp.com", subject: "Re: hi", body: "sounds good", threadId: "t1" };

/** The MIME exactly as the builder emitted it before B0, for a plain draft. */
const PRE_B0_PLAIN_MIME = [
  "To: boss@corp.com",
  "Subject: =?UTF-8?B?UmU6IGhp?=",
  "MIME-Version: 1.0",
  "Content-Type: text/plain; charset=utf-8",
  "Content-Transfer-Encoding: 8bit",
  "",
  "sounds good",
].join(CRLF);

/** The multipart branch with Date.now and Math.random stubbed (see STUBBED_*). */
const STUBBED_NOW = 1_700_000_000_000;
const STUBBED_RANDOM = 0.5;
const BOUNDARY = "klorn_loyw3v28_i";
const ATTACHMENT = { filename: "a.txt", mimeType: "text/plain", content: Buffer.from("hi") };
const PRE_B0_MULTIPART_MIME = [
  "To: boss@corp.com",
  "Subject: =?UTF-8?B?UmU6IGhp?=",
  "MIME-Version: 1.0",
  `Content-Type: multipart/mixed; boundary="${BOUNDARY}"`,
  "",
  `--${BOUNDARY}`,
  "Content-Type: text/plain; charset=utf-8",
  "Content-Transfer-Encoding: 8bit",
  "",
  "sounds good",
  `--${BOUNDARY}`,
  'Content-Type: text/plain; name="a.txt"',
  "Content-Transfer-Encoding: base64",
  "Content-Disposition: attachment; filename=\"a.txt\"; filename*=UTF-8''a.txt",
  "",
  "aGk=",
  `--${BOUNDARY}--`,
  "",
].join(CRLF);

type MailPath = "draft" | "send";
const PATHS: MailPath[] = ["draft", "send"];

function decodeRaw(raw: string): string {
  return Buffer.from(raw, "base64url").toString("utf8");
}

function headerBlock(mime: string): string {
  return mime.split(`${CRLF}${CRLF}`)[0];
}

/** Header lines with folded continuations joined, one string per header. */
function headerLines(mime: string): string[] {
  return headerBlock(mime).replace(/\r\n /g, " ").split(CRLF);
}

function headerNames(mime: string): string[] {
  return headerLines(mime).map((line) => line.split(":")[0]);
}

function draftMime(): string {
  return decodeRaw(m.draftsCreate.mock.calls[0][0].requestBody.message.raw);
}

function sentMime(): string {
  return decodeRaw(m.messagesSend.mock.calls[0][0].requestBody.raw);
}

/** Build the same message through the draft or the send path. */
async function mimeVia(
  path: MailPath,
  reply: { inReplyTo?: unknown; references?: unknown },
  attachments: (typeof ATTACHMENT)[] = [],
): Promise<string> {
  if (path === "draft") {
    await createEmailDraft("u1", { ...BASE, attachments, reply: reply as never });
    return draftMime();
  }
  await sendEmail("u1", BASE.to, BASE.subject, BASE.body, attachments, {
    threadId: BASE.threadId,
    ...(reply as object),
  });
  return sentMime();
}

beforeEach(() => {
  vi.clearAllMocks();
  m.userTokenFindFirst.mockResolvedValue({
    id: "tok-1",
    accessToken: "AT",
    refreshToken: "RT",
    expiresAt: null,
  });
  m.linkedFindFirst.mockResolvedValue({
    id: "acct-1",
    accessToken: "AT2",
    refreshToken: "RT2",
    expiresAt: null,
  });
  m.draftsCreate.mockResolvedValue({ data: { id: "d1", message: { id: "m1" } } });
  m.messagesSend.mockResolvedValue({ data: { id: "s1", threadId: "t1" } });
});

describe("createEmailDraft reply headers", () => {
  it("adds In-Reply-To and References to the draft MIME next to the threadId", async () => {
    const result = await createEmailDraft("u1", {
      ...BASE,
      reply: { inReplyTo: ORIGINAL_ID, references: REFERENCES },
    });
    expect(result).toMatchObject({ success: true, draftId: "d1" });
    const lines = headerLines(draftMime());
    expect(lines).toContain(`In-Reply-To: ${ORIGINAL_ID}`);
    expect(lines).toContain(`References: ${REFERENCES}`);
    expect(m.draftsCreate.mock.calls[0][0].requestBody.message.threadId).toBe("t1");
  });

  it("emits exactly the pre-B0 MIME when no reply context is given", async () => {
    await createEmailDraft("u1", BASE);
    expect(draftMime()).toBe(PRE_B0_PLAIN_MIME);
  });

  it("emits exactly the pre-B0 MIME for an empty reply context object", async () => {
    await createEmailDraft("u1", { ...BASE, reply: {} });
    expect(draftMime()).toBe(PRE_B0_PLAIN_MIME);
  });

  it("emits only the header that was given", async () => {
    await createEmailDraft("u1", { ...BASE, reply: { inReplyTo: ORIGINAL_ID } });
    const lines = headerLines(draftMime());
    expect(lines).toContain(`In-Reply-To: ${ORIGINAL_ID}`);
    expect(lines.some((l) => l.startsWith("References:"))).toBe(false);
  });

  it("puts the headers in the top-level header block of a multipart draft", async () => {
    await createEmailDraft("u1", {
      ...BASE,
      attachments: [ATTACHMENT],
      reply: { inReplyTo: ORIGINAL_ID, references: REFERENCES },
    });
    const lines = headerLines(draftMime());
    expect(lines).toContain(`In-Reply-To: ${ORIGINAL_ID}`);
    expect(lines).toContain(`References: ${REFERENCES}`);
    expect(lines.some((l) => l.startsWith("Content-Type: multipart/mixed"))).toBe(true);
  });

  it("creates the draft on the linked account and keeps the reply headers", async () => {
    await createEmailDraft("u1", {
      ...BASE,
      linkedInboxAccountId: "acct-1",
      reply: { inReplyTo: ORIGINAL_ID },
    });
    expect(m.linkedFindFirst).toHaveBeenCalledWith({
      where: { id: "acct-1", userId: "u1", provider: "GOOGLE" },
    });
    expect(m.userTokenFindFirst).not.toHaveBeenCalled();
    expect(headerLines(draftMime())).toContain(`In-Reply-To: ${ORIGINAL_ID}`);
  });

  it("still refuses a no-reply recipient when reply context is given", async () => {
    const result = await createEmailDraft("u1", {
      ...BASE,
      to: "noreply@corp.com",
      reply: { inReplyTo: ORIGINAL_ID },
    });
    expect(result).toMatchObject({ error: expect.stringContaining("no-reply") });
    expect(m.draftsCreate).not.toHaveBeenCalled();
  });

  it("treats a non-object reply argument as absent", async () => {
    await createEmailDraft("u1", { ...BASE, reply: 5 as never });
    expect(draftMime()).toBe(PRE_B0_PLAIN_MIME);
  });
});

describe("reply headers are parsed into message ids on both paths", () => {
  it.each(PATHS)("%s: keeps only the id when CRLF plus a header name follows", async (path) => {
    const mime = await mimeVia(path, {
      inReplyTo: `${ORIGINAL_ID}${CRLF}Bcc: evil@attacker.com`,
      references: `${CHAIN}${CRLF}X-Injected: 1`,
    });
    const lines = headerLines(mime);
    expect(lines).toContain(`In-Reply-To: ${ORIGINAL_ID}`);
    expect(lines).toContain(`References: ${CHAIN}`);
    expect(lines.some((l) => /^(bcc|x-injected):/i.test(l))).toBe(false);
    expect(headerBlock(mime)).not.toContain("evil@attacker.com");
  });

  it.each(PATHS)("%s: a lone CR cannot start a header line", async (path) => {
    const mime = await mimeVia(path, { inReplyTo: `${ORIGINAL_ID}\rBcc: evil@attacker.com` });
    expect(headerBlock(mime)).not.toMatch(/\r(?!\n)/);
    expect(headerBlock(mime)).not.toContain("evil@attacker.com");
    expect(headerLines(mime)).toContain(`In-Reply-To: ${ORIGINAL_ID}`);
  });

  it.each(PATHS)("%s: a blank-line body split cannot end the header block", async (path) => {
    const mime = await mimeVia(path, { references: `${ORIGINAL_ID}\n\nInjected body` });
    expect(mime.split(`${CRLF}${CRLF}`)).toHaveLength(2);
    expect(mime.endsWith(`${CRLF}${CRLF}sounds good`)).toBe(true);
    expect(headerLines(mime)).toContain(`References: ${ORIGINAL_ID}`);
  });

  it.each(PATHS)("%s: U+2028, U+0085, NUL and DEL never reach a header", async (path) => {
    const mime = await mimeVia(path, {
      inReplyTo: `${ORIGINAL_ID}\u2028\u0085\u0000\u007f`,
      references: `<a@x.com>\u2028<b@x.com>\u0000<c@x.com>`,
    });
    expect(FORBIDDEN_CHARS.filter((ch) => headerBlock(mime).includes(ch))).toEqual([]);
    expect(headerLines(mime)).toContain("References: <a@x.com> <b@x.com> <c@x.com>");
  });

  it.each(PATHS)("%s: omits a header that has no valid message id", async (path) => {
    const mime = await mimeVia(path, { inReplyTo: `${CRLF} `, references: "not an id\n" });
    expect(mime).toBe(PRE_B0_PLAIN_MIME);
  });

  it.each(PATHS)("%s: non-string values are absent, not a TypeError", async (path) => {
    const mime = await mimeVia(path, { inReplyTo: 42, references: { id: ORIGINAL_ID } });
    expect(mime).toBe(PRE_B0_PLAIN_MIME);
    const arrayMime = await mimeVia(path, { inReplyTo: [ORIGINAL_ID], references: [ORIGINAL_ID] });
    expect(arrayMime).toBe(PRE_B0_PLAIN_MIME);
  });

  it.each(PATHS)("%s: folds a 40-id References chain to first + last 20", async (path) => {
    const all = Array.from({ length: 40 }, (_, i) => `<msg-${i}@mail.example.com>`);
    const mime = await mimeVia(path, { references: all.join(" ") });
    const kept = [all[0], ...all.slice(-20)];
    expect(headerLines(mime)).toContain(`References: ${kept.join(" ")}`);
    for (const line of headerBlock(mime).split(CRLF)) {
      expect(line.length).toBeLessThanOrEqual(MAX_HEADER_LINE_LENGTH);
    }
  });

  it("produces identical headers on the send and draft paths for identical input", async () => {
    const reply = { inReplyTo: `${ORIGINAL_ID}\r\nBcc: x@y.z`, references: `${REFERENCES}\u2028` };
    const draft = await mimeVia("draft", reply);
    m.draftsCreate.mockClear();
    const sent = await mimeVia("send", reply);
    expect(headerBlock(draft)).toBe(headerBlock(sent));
  });
});

describe("header order", () => {
  const REPLY = { inReplyTo: ORIGINAL_ID, references: REFERENCES };

  it.each(PATHS)("%s: To, Subject, In-Reply-To, References, MIME-Version", async (path) => {
    const mime = await mimeVia(path, REPLY);
    expect(headerNames(mime)).toEqual([
      "To",
      "Subject",
      "In-Reply-To",
      "References",
      "MIME-Version",
      "Content-Type",
      "Content-Transfer-Encoding",
    ]);
  });

  it.each(PATHS)("%s: the same order holds for a multipart message", async (path) => {
    const mime = await mimeVia(path, REPLY, [ATTACHMENT]);
    expect(headerNames(mime)).toEqual([
      "To",
      "Subject",
      "In-Reply-To",
      "References",
      "MIME-Version",
      "Content-Type",
    ]);
  });
});

describe("B0 leaves the no-reply builder output unchanged", () => {
  let nowSpy: ReturnType<typeof vi.spyOn>;
  let randomSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    nowSpy = vi.spyOn(Date, "now").mockReturnValue(STUBBED_NOW);
    randomSpy = vi.spyOn(Math, "random").mockReturnValue(STUBBED_RANDOM);
  });

  afterEach(() => {
    nowSpy.mockRestore();
    randomSpy.mockRestore();
  });

  it.each(PATHS)("%s: the multipart (attachment) MIME is byte-identical", async (path) => {
    const mime = await mimeVia(path, {}, [ATTACHMENT]);
    expect(mime).toBe(PRE_B0_MULTIPART_MIME);
  });
});

describe("sendEmail reply headers", () => {
  it("emits In-Reply-To and References and passes the threadId", async () => {
    await sendEmail("u1", BASE.to, BASE.subject, BASE.body, [], {
      threadId: "t1",
      inReplyTo: ORIGINAL_ID,
      references: REFERENCES,
    });
    const lines = headerLines(sentMime());
    expect(lines).toContain(`In-Reply-To: ${ORIGINAL_ID}`);
    expect(lines).toContain(`References: ${REFERENCES}`);
    expect(m.messagesSend.mock.calls[0][0].requestBody.threadId).toBe("t1");
  });

  it("emits exactly the pre-B0 MIME when no reply headers are given", async () => {
    await sendEmail("u1", BASE.to, BASE.subject, BASE.body, [], { threadId: "t1" });
    expect(sentMime()).toBe(PRE_B0_PLAIN_MIME);
  });
});
