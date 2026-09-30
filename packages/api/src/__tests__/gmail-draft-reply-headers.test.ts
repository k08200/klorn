/**
 * Step B0: reply threading headers on Gmail drafts.
 *
 * `createEmailDraft` and `sendEmail` build their MIME through the same
 * builder. These tests decode the `raw` payload handed to the Gmail API and
 * pin: In-Reply-To / References appear when given, the no-reply MIME is
 * byte-identical to what the builder produced before B0, CR/LF header
 * injection is neutralised on both the draft and the send path, and the linked
 * inbox account id still selects the account.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

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

const CRLF = "\r\n";
const ORIGINAL_ID = "<orig-1@mail.example.com>";
const CHAIN = "<root@mail.example.com> <mid@mail.example.com>";
const REFERENCES = `${CHAIN} ${ORIGINAL_ID}`;

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

function decodeRaw(raw: string): string {
  return Buffer.from(raw, "base64url").toString("utf8");
}

function headerLines(mime: string): string[] {
  return mime.split(`${CRLF}${CRLF}`)[0].split(CRLF);
}

function draftMime(): string {
  const call = m.draftsCreate.mock.calls[0][0];
  return decodeRaw(call.requestBody.message.raw);
}

function sentMime(): string {
  const call = m.messagesSend.mock.calls[0][0];
  return decodeRaw(call.requestBody.raw);
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
    const result = await createEmailDraft(
      "u1",
      "boss@corp.com",
      "Re: hi",
      "sounds good",
      "t1",
      [],
      null,
      { inReplyTo: ORIGINAL_ID, references: REFERENCES },
    );
    expect(result).toMatchObject({ success: true, draftId: "d1" });
    const lines = headerLines(draftMime());
    expect(lines).toContain(`In-Reply-To: ${ORIGINAL_ID}`);
    expect(lines).toContain(`References: ${REFERENCES}`);
    expect(m.draftsCreate.mock.calls[0][0].requestBody.message.threadId).toBe("t1");
  });

  it("emits exactly the pre-B0 MIME when no reply context is given", async () => {
    await createEmailDraft("u1", "boss@corp.com", "Re: hi", "sounds good", "t1");
    expect(draftMime()).toBe(PRE_B0_PLAIN_MIME);
  });

  it("emits exactly the pre-B0 MIME for an empty reply context object", async () => {
    await createEmailDraft("u1", "boss@corp.com", "Re: hi", "sounds good", "t1", [], null, {});
    expect(draftMime()).toBe(PRE_B0_PLAIN_MIME);
  });

  it("emits only the header that was given", async () => {
    await createEmailDraft("u1", "boss@corp.com", "Re: hi", "sounds good", "t1", [], null, {
      inReplyTo: ORIGINAL_ID,
    });
    const lines = headerLines(draftMime());
    expect(lines).toContain(`In-Reply-To: ${ORIGINAL_ID}`);
    expect(lines.some((l) => l.startsWith("References:"))).toBe(false);
  });

  it("puts the headers in the top-level header block of a multipart draft", async () => {
    const attachment = { filename: "a.txt", mimeType: "text/plain", content: Buffer.from("hi") };
    await createEmailDraft(
      "u1",
      "boss@corp.com",
      "Re: hi",
      "sounds good",
      "t1",
      [attachment],
      null,
      {
        inReplyTo: ORIGINAL_ID,
        references: REFERENCES,
      },
    );
    const lines = headerLines(draftMime());
    expect(lines).toContain(`In-Reply-To: ${ORIGINAL_ID}`);
    expect(lines).toContain(`References: ${REFERENCES}`);
    expect(lines.some((l) => l.startsWith("Content-Type: multipart/mixed"))).toBe(true);
  });

  it("strips CR/LF from In-Reply-To so a value cannot inject a header", async () => {
    await createEmailDraft("u1", "boss@corp.com", "Re: hi", "sounds good", "t1", [], null, {
      inReplyTo: `${ORIGINAL_ID}${CRLF}Bcc: evil@attacker.com`,
    });
    const lines = headerLines(draftMime());
    expect(lines.some((l) => /^bcc:/i.test(l))).toBe(false);
    expect(lines).toContain(`In-Reply-To: ${ORIGINAL_ID} Bcc: evil@attacker.com`);
  });

  it("strips a bare LF and a blank-line body split from References", async () => {
    await createEmailDraft("u1", "boss@corp.com", "Re: hi", "sounds good", "t1", [], null, {
      references: `${ORIGINAL_ID}\n\nInjected body`,
    });
    const mime = draftMime();
    expect(mime.split(`${CRLF}${CRLF}`)).toHaveLength(2);
    expect(mime.endsWith(`${CRLF}${CRLF}sounds good`)).toBe(true);
    expect(headerLines(mime)).toContain(`References: ${ORIGINAL_ID} Injected body`);
  });

  it("omits a header whose value is only line breaks and whitespace", async () => {
    await createEmailDraft("u1", "boss@corp.com", "Re: hi", "sounds good", "t1", [], null, {
      inReplyTo: `${CRLF} `,
      references: "\n",
    });
    expect(draftMime()).toBe(PRE_B0_PLAIN_MIME);
  });

  it("creates the draft on the linked account and keeps the reply headers", async () => {
    await createEmailDraft("u1", "boss@corp.com", "Re: hi", "sounds good", "t1", [], "acct-1", {
      inReplyTo: ORIGINAL_ID,
    });
    expect(m.linkedFindFirst).toHaveBeenCalledWith({
      where: { id: "acct-1", userId: "u1", provider: "GOOGLE" },
    });
    expect(m.userTokenFindFirst).not.toHaveBeenCalled();
    expect(headerLines(draftMime())).toContain(`In-Reply-To: ${ORIGINAL_ID}`);
  });

  it("still refuses a no-reply recipient when reply context is given", async () => {
    const result = await createEmailDraft(
      "u1",
      "noreply@corp.com",
      "Re: hi",
      "sounds good",
      "t1",
      [],
      null,
      { inReplyTo: ORIGINAL_ID },
    );
    expect(result).toMatchObject({ error: expect.stringContaining("no-reply") });
    expect(m.draftsCreate).not.toHaveBeenCalled();
  });
});

describe("sendEmail reply headers share the same guard", () => {
  it("emits In-Reply-To and References and passes the threadId", async () => {
    await sendEmail("u1", "boss@corp.com", "Re: hi", "sounds good", [], {
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
    await sendEmail("u1", "boss@corp.com", "Re: hi", "sounds good", [], { threadId: "t1" });
    expect(sentMime()).toBe(PRE_B0_PLAIN_MIME);
  });

  it("strips CR/LF from In-Reply-To and References so a value cannot inject a header", async () => {
    await sendEmail("u1", "boss@corp.com", "Re: hi", "sounds good", [], {
      inReplyTo: `${ORIGINAL_ID}${CRLF}Bcc: evil@attacker.com`,
      references: `${CHAIN}${CRLF}X-Injected: 1`,
    });
    const lines = headerLines(sentMime());
    expect(lines.some((l) => /^(bcc|x-injected):/i.test(l))).toBe(false);
    expect(lines).toContain(`In-Reply-To: ${ORIGINAL_ID} Bcc: evil@attacker.com`);
    expect(lines).toContain(`References: ${CHAIN} X-Injected: 1`);
  });

  it("omits a header whose value is only line breaks and whitespace", async () => {
    await sendEmail("u1", "boss@corp.com", "Re: hi", "sounds good", [], {
      inReplyTo: `${CRLF} `,
      references: "\n",
    });
    expect(sentMime()).toBe(PRE_B0_PLAIN_MIME);
  });
});
