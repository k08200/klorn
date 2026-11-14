/**
 * The IMAP poll and the single-UID ingest hand persist the envelope's RFC 5322
 * Message-ID (messageIdHeader), so an attachment can still be fetched after the
 * message left INBOX (attachment-bytes.ts). Trimmed; dropped when longer than
 * RFC 5322's 998-character line limit or when it carries a control character.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const imap = vi.hoisted(() => ({
  fetch: vi.fn(),
  release: vi.fn(),
}));

class FakeImapFlow {
  connect = vi.fn(async () => undefined);
  getMailboxLock = vi.fn(async () => ({ release: imap.release }));
  logout = vi.fn(async () => undefined);
  close = vi.fn();
  on = vi.fn();
  status = vi.fn(async () => ({ messages: 1 }));
  fetch = imap.fetch;
}

vi.mock("imapflow", () => ({ ImapFlow: FakeImapFlow }));

const persistGmailEmail = vi.hoisted(() => vi.fn());
vi.mock("../judge/email-firewall.js", () => ({ persistGmailEmail }));
vi.mock("../mail/attachment-scan-gate.js", () => ({
  needsAttachmentScan: vi.fn(async () => false),
  wasAttachmentScanned: vi.fn(() => true),
  rememberAttachmentScan: vi.fn(),
}));
vi.mock("../db.js", () => ({ prisma: {}, db: {} }));
vi.mock("../sentry.js", () => ({ captureError: vi.fn() }));

const { syncImapInbox, syncImapMessage } = await import("../mail/imap-sync.js");
const { IMAP_PROVIDERS } = await import("../mail/imap-providers.js");
const { envelopeMessageId, MAX_STORED_MESSAGE_ID_LENGTH } = await import(
  "../mail/imap-envelope.js"
);

function arm(messageId: string | null | undefined) {
  imap.fetch.mockImplementation(async function* () {
    yield {
      uid: 7,
      envelope: {
        from: [{ name: "Kim", address: "kim@example.com" }],
        to: [{ address: "me@example.com" }],
        subject: "hello",
        date: new Date("2026-11-01T00:00:00Z"),
        messageId,
      },
      flags: new Set<string>(),
      headers: Buffer.from("Content-Type: text/plain\r\n"),
      bodyParts: new Map([["text", Buffer.from("hi")]]),
    };
  });
}

const account = {
  provider: IMAP_PROVIDERS.ICLOUD,
  userId: "u1",
  email: "me@example.com",
  password: "app-pw",
  host: "imap.mail.me.com:993",
};

const persistedHeader = () => persistGmailEmail.mock.calls[0]?.[1]?.messageIdHeader;

beforeEach(() => {
  vi.clearAllMocks();
  persistGmailEmail.mockResolvedValue({ emailId: "e1", isNew: true });
});

describe("IMAP ingest → messageIdHeader", () => {
  it("the poll persists the envelope's Message-ID, trimmed", async () => {
    arm("  <abc@x.example.com>  ");

    await syncImapInbox(account);

    expect(persistedHeader()).toBe("<abc@x.example.com>");
  });

  it("the single-UID ingest (undo) persists it the same way", async () => {
    arm("<abc@x.example.com>");

    await syncImapMessage({ ...account, linkedInboxAccountId: "acc-1", uid: 7 });

    expect(persistedHeader()).toBe("<abc@x.example.com>");
  });

  it.each([
    ["absent", undefined],
    ["null", null],
    ["blank", "   "],
    ["over-long", `<${"a".repeat(MAX_STORED_MESSAGE_ID_LENGTH)}@x.example.com>`],
    ["CRLF-carrying", "<abc@x.example.com>\r\nBcc: victim@example.com"],
    ["NUL-carrying", "<abc\u0000@x.example.com>"],
  ])("stores null for a %s Message-ID", async (_label, value) => {
    arm(value);

    await syncImapInbox(account);

    expect(persistGmailEmail).toHaveBeenCalledTimes(1);
    expect(persistedHeader()).toBeNull();
  });
});

describe("envelopeMessageId", () => {
  it("keeps a value of exactly the limit and drops one past it", () => {
    const atLimit = `<${"a".repeat(MAX_STORED_MESSAGE_ID_LENGTH - 2)}>`;
    expect(MAX_STORED_MESSAGE_ID_LENGTH).toBe(998);
    expect(envelopeMessageId(atLimit)).toBe(atLimit);
    expect(envelopeMessageId(`${atLimit}x`)).toBeNull();
  });

  it("is case-preserving and leaves inner spaces alone", () => {
    expect(envelopeMessageId(" <AbC@X.example.com> ")).toBe("<AbC@X.example.com>");
  });
});
