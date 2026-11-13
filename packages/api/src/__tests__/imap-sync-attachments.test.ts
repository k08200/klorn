/**
 * The IMAP poll used to hand persist `htmlBody: ""` and `attachments: []` for
 * every message. It now passes the decoded HTML part and, once per message
 * (needsAttachmentScan), the attachment rows in Gmail's model.
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
const needsAttachmentScan = vi.hoisted(() => vi.fn());
const wasAttachmentScanned = vi.hoisted(() => vi.fn());
const rememberAttachmentScan = vi.hoisted(() => vi.fn());
const extract = vi.hoisted(() => vi.fn());

vi.mock("../judge/email-firewall.js", () => ({ persistGmailEmail }));
vi.mock("../mail/attachment-scan-gate.js", () => ({
  needsAttachmentScan,
  wasAttachmentScanned,
  rememberAttachmentScan,
}));
vi.mock("../mail/attachment-extract-isolated.js", () => ({
  extractAttachmentContentIsolated: extract,
}));
vi.mock("../db.js", () => ({ prisma: {}, db: {} }));
vi.mock("../sentry.js", () => ({ captureError: vi.fn() }));

const { syncImapInbox } = await import("../mail/imap-sync.js");
const { IMAP_PROVIDERS } = await import("../mail/imap-providers.js");

const CRLF = "\r\n";
const PDF = Buffer.from("%PDF-1.4 견적");
const MESSAGE = [
  "--mix",
  'Content-Type: multipart/alternative; boundary="alt"',
  "",
  "--alt",
  "Content-Type: text/plain; charset=utf-8",
  "",
  "견적서 첨부합니다",
  "--alt",
  "Content-Type: text/html; charset=utf-8",
  "",
  "<p>견적서 <b>첨부</b>합니다</p>",
  "--alt--",
  "--mix",
  "Content-Type: application/pdf",
  "Content-Disposition: attachment; filename*=UTF-8''%EA%B2%AC%EC%A0%81%EC%84%9C.pdf",
  "Content-Transfer-Encoding: base64",
  "",
  PDF.toString("base64"),
  "--mix--",
  "",
].join(CRLF);

function armMessage() {
  imap.fetch.mockImplementation(async function* () {
    yield {
      uid: 7,
      envelope: {
        from: [{ name: "Kim", address: "kim@example.com" }],
        to: [{ address: "me@icloud.com" }],
        subject: "견적",
        date: new Date("2026-11-01T00:00:00Z"),
      },
      flags: new Set<string>(),
      headers: Buffer.from(`Content-Type: multipart/mixed; boundary="mix"${CRLF}`),
      bodyParts: new Map([["text", Buffer.from(MESSAGE)]]),
    };
  });
}

const sync = () =>
  syncImapInbox({
    provider: IMAP_PROVIDERS.ICLOUD,
    userId: "u1",
    email: "me@icloud.com",
    password: "app-pw",
    host: "imap.mail.me.com:993",
  });

const persisted = () => persistGmailEmail.mock.calls[0]?.[1];

describe("syncImapInbox → HTML body and attachments", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    armMessage();
    persistGmailEmail.mockResolvedValue({ emailId: "e1", isNew: true });
    needsAttachmentScan.mockResolvedValue(true);
    wasAttachmentScanned.mockReturnValue(false);
    extract.mockResolvedValue({ text: "견적 금액 100만원", status: "readable" });
  });

  it("persists the decoded HTML part as htmlBody", async () => {
    await sync();

    expect(persisted()).toMatchObject({
      body: "견적서 첨부합니다",
      htmlBody: "<p>견적서 <b>첨부</b>합니다</p>",
    });
  });

  it("persists the attachment once, keyed by IMAP section, with extracted text", async () => {
    await sync();

    expect(needsAttachmentScan).toHaveBeenCalledWith("u1", "icloud-imap:me@icloud.com:7");
    expect(extract).toHaveBeenCalledWith(PDF, "견적서.pdf", "application/pdf");
    expect(persisted()?.attachments).toEqual([
      {
        gmailAttachmentId: "2",
        partKey: "2",
        filename: "견적서.pdf",
        mimeType: "application/pdf",
        size: PDF.length,
        contentId: null,
        contentText: "견적 금액 100만원",
      },
    ]);
  });

  it("does not re-read attachments a stored row already has (no per-poll extraction)", async () => {
    needsAttachmentScan.mockResolvedValue(false);

    await sync();

    expect(extract).not.toHaveBeenCalled();
    expect(persisted()?.attachments).toEqual([]);
    // ...and remembers it, so the next poll skips even the lookup.
    expect(rememberAttachmentScan).toHaveBeenCalledWith("u1", "icloud-imap:me@icloud.com:7");
  });

  it("skips the lookup and the walk for a message this process already listed", async () => {
    wasAttachmentScanned.mockReturnValue(true);

    await sync();

    expect(needsAttachmentScan).not.toHaveBeenCalled();
    expect(extract).not.toHaveBeenCalled();
    expect(persisted()).toMatchObject({
      htmlBody: "<p>견적서 <b>첨부</b>합니다</p>",
      attachments: [],
    });
  });

  it("does not remember a message whose rows it hands to persist (stored rows answer next time)", async () => {
    await sync();
    expect(rememberAttachmentScan).not.toHaveBeenCalled();
  });

  it("still persists the message when the attachment lookup fails", async () => {
    needsAttachmentScan.mockRejectedValue(new Error("db down"));

    const result = await sync();

    expect(persisted()).toMatchObject({ subject: "견적", attachments: [] });
    expect(result.errors).toBe(0);
  });

  it("asks nothing of the database for a message without attachments", async () => {
    imap.fetch.mockImplementation(async function* () {
      yield {
        uid: 8,
        envelope: { subject: "plain" },
        flags: new Set<string>(),
        headers: Buffer.from(`Content-Type: text/plain${CRLF}`),
        bodyParts: new Map([["text", Buffer.from("hello")]]),
      };
    });

    await sync();

    expect(needsAttachmentScan).not.toHaveBeenCalled();
    expect(persisted()).toMatchObject({ htmlBody: "", attachments: [] });
  });
});
