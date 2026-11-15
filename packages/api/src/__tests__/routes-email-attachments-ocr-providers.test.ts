/**
 * POST /:id/attachments/ocr reads an attachment's bytes from the message's own
 * mailbox (mail/attachment-bytes.ts), not from Gmail alone: an iCloud/Naver/preset
 * IMAP row by UID and section, an Outlook row through Graph. The mailbox is
 * resolved once, up front: a disconnected one answers 409 before any row is read
 * or touched, as the old Gmail-only check did. A part that cannot be fetched
 * (404/413/502) marks only its own row VISION_FAILED.
 *
 * The real attachment-bytes.ts runs; its provider edges (IMAP session, Outlook
 * Graph, Gmail client) and the vision call are faked.
 */

import { Readable } from "node:stream";
import Fastify from "fastify";
import { beforeEach, describe, expect, it, vi } from "vitest";

const createVisionCompletion = vi.hoisted(() => vi.fn());
const attachmentUpdate = vi.hoisted(() => vi.fn(async () => ({})));
const attachmentFindMany = vi.hoisted(() => vi.fn());
const emailFindFirst = vi.hoisted(() => vi.fn());
const linkedFindFirst = vi.hoisted(() => vi.fn());
const resolveMailClient = vi.hoisted(() => vi.fn());
const resolveOutlookBearer = vi.hoisted(() => vi.fn());
const fetchOutlookAttachmentBytes = vi.hoisted(() => vi.fn());
const findCheckedAccount = vi.hoisted(() => vi.fn());
const runAccountTask = vi.hoisted(() => vi.fn());
const imapClient = vi.hoisted(() => ({
  mailbox: { uidValidity: 1700n } as { uidValidity: unknown },
  getMailboxLock: vi.fn(),
  download: vi.fn(),
}));

vi.mock("../auth.js", () => ({
  requireAuth: async () => {},
  getUserId: () => "user-1",
  resolveEffectiveJwtSecret: () => "test-secret",
}));
vi.mock("../db.js", () => {
  const prisma = {
    emailAttachment: { findMany: attachmentFindMany, update: attachmentUpdate },
    emailMessage: { findFirst: emailFindFirst },
    linkedInboxAccount: { findFirst: linkedFindFirst },
  };
  return { prisma, db: prisma };
});
vi.mock("googleapis", () => ({
  google: { gmail: () => ({ users: { messages: { attachments: { get: vi.fn() } } } }) },
}));
vi.mock("../mail/gmail.js", () => ({ resolveMailClient, GMAIL_TOOLS: [] }));
vi.mock("../mail/outlook-token.js", () => ({ resolveOutlookBearer }));
vi.mock("../mail/outlook-attachments.js", () => ({ fetchOutlookAttachmentBytes }));
vi.mock("../mail/providers/imap-account.js", () => ({
  findCheckedAccount,
  sessionAccountFor: vi.fn((_p, userId, checked) => ({ userId, rowId: checked.id })),
}));
vi.mock("../mail/providers/imap-session.js", () => ({
  runAccountTask,
  withImapClient: vi.fn((_p, _a, run) => run(imapClient)),
}));
vi.mock("../mail/email-attachments.js", () => ({
  analyzeEmailAttachmentsForEmail: vi.fn(),
  analyzePendingEmailAttachments: vi.fn(),
  buildAttachmentCandidateProfile: vi.fn(() => null),
  buildAttachmentCorrectionGuidance: vi.fn(async () => ""),
  listEmailAttachments: vi.fn(async () => []),
}));
vi.mock("../mail/email-candidate-intake.js", () => ({
  syncCandidateIntakeForEmail: vi.fn(),
  syncRecentCandidateIntakes: vi.fn(),
}));
vi.mock("../learning/feedback.js", () => ({ recordFeedback: vi.fn() }));
vi.mock("../mail/file-conversion-store.js", () => ({ saveConversionResult: vi.fn() }));
vi.mock("../mail/file-conversions.js", () => ({
  convertEmailAttachment: vi.fn(),
  FileConversionError: class extends Error {},
  normalizeConversionTarget: vi.fn(() => "pdf"),
  requiresOriginalAttachment: vi.fn(() => true),
  SUPPORTED_CONVERSION_TARGETS: ["pdf"],
}));
vi.mock("../llm/llm-credentials.js", () => ({ getUserLlmCredentials: vi.fn(async () => ({})) }));
vi.mock("../llm/openai.js", () => ({ createVisionCompletion, VISION_MODEL: "test-vision" }));

import { MAX_ATTACHMENT_DOWNLOAD_BYTES } from "../mail/attachment-bytes.js";
import { registerEmailAttachmentsRoutes } from "../routes/email-attachments.js";

const PDF = Buffer.from("%PDF-1.7 견적");

const attachmentRow = (overrides: Record<string, unknown> = {}) => ({
  id: "a1",
  gmailAttachmentId: "2",
  partKey: "2",
  filename: "invoice.pdf",
  mimeType: "application/pdf",
  size: 40_000,
  contentText: null,
  analysisStatus: "PENDING",
  ...overrides,
});

async function ocr() {
  const app = Fastify();
  await app.register(registerEmailAttachmentsRoutes, { prefix: "/api/email" });
  const res = await app.inject({ method: "POST", url: "/api/email/e1/attachments/ocr" });
  await app.close();
  return res;
}

const updates = () =>
  (attachmentUpdate.mock.calls as unknown as Array<[{ data: Record<string, unknown> }]>).map(
    ([arg]) => arg.data,
  );

beforeEach(() => {
  vi.clearAllMocks();
  createVisionCompletion.mockResolvedValue({
    choices: [{ message: { content: '{"ocrText":"INVOICE 4821","summary":"Invoice"}' } }],
  });
  attachmentFindMany.mockResolvedValue([attachmentRow()]);
  imapClient.mailbox = { uidValidity: 1700n };
  imapClient.getMailboxLock.mockResolvedValue({ release: vi.fn() });
  imapClient.download.mockResolvedValue({ content: Readable.from([PDF]) });
  runAccountTask.mockImplementation((_p, _a, task) =>
    task({ signal: new AbortController().signal }),
  );
  findCheckedAccount.mockResolvedValue({
    id: "acc-icloud",
    email: "me@example.com",
    host: "imap.mail.me.com:993",
    passwordCipher: "c",
    inboxUidValidity: "1700",
  });
  resolveOutlookBearer.mockResolvedValue({ accessToken: "at", email: "me@example.com" });
});

describe("POST /:id/attachments/ocr → IMAP mailbox", () => {
  beforeEach(() => {
    linkedFindFirst.mockResolvedValue({ provider: "ICLOUD" });
    emailFindFirst.mockResolvedValue({
      id: "e1",
      gmailId: "icloud-imap:me@example.com:42",
      linkedInboxAccountId: "acc-icloud",
      messageIdHeader: "<abc@x.example.com>",
    });
  });

  it("fetches the bytes over IMAP by UID and section and stores the analysis", async () => {
    const res = await ocr();

    expect(res.statusCode).toBe(200);
    expect(res.json().results).toEqual([
      { attachmentId: "a1", filename: "invoice.pdf", status: "analyzed" },
    ]);
    expect(linkedFindFirst).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: "acc-icloud", userId: "user-1" } }),
    );
    expect(imapClient.download).toHaveBeenCalledWith("42", "2", {
      uid: true,
      maxBytes: MAX_ATTACHMENT_DOWNLOAD_BYTES + 1,
    });
    expect(resolveMailClient).not.toHaveBeenCalled();
    // The vision call saw the IMAP bytes.
    const call = createVisionCompletion.mock.calls[0]?.[0] as {
      messages: Array<{ content: unknown }>;
    };
    expect(JSON.stringify(call.messages)).toContain(PDF.toString("base64"));
    expect(updates()).toEqual([
      expect.objectContaining({ analysisStatus: "ANALYZED", contentText: "INVOICE 4821" }),
    ]);
  });

  it("asks for partKey on the rows and messageIdHeader on the message", async () => {
    await ocr();

    expect(emailFindFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        select: expect.objectContaining({ linkedInboxAccountId: true, messageIdHeader: true }),
      }),
    );
    expect(attachmentFindMany).toHaveBeenCalledWith(
      expect.objectContaining({ select: expect.objectContaining({ partKey: true }) }),
    );
  });

  it("answers 409 for a disconnected mailbox before any row is read or updated", async () => {
    findCheckedAccount.mockResolvedValue({ error: "iCloud mailbox is not connected." });
    attachmentFindMany.mockResolvedValue([
      attachmentRow({ id: "logo", filename: "logo.png", mimeType: "image/png", size: 300 }),
      attachmentRow(),
    ]);

    const res = await ocr();

    expect(res.statusCode).toBe(409);
    expect(res.json()).toEqual({ error: "iCloud mailbox is not connected." });
    expect(attachmentFindMany).not.toHaveBeenCalled();
    expect(attachmentUpdate).not.toHaveBeenCalled();
    expect(createVisionCompletion).not.toHaveBeenCalled();
  });

  it("marks only the row whose part could not be found VISION_FAILED", async () => {
    attachmentFindMany.mockResolvedValue([
      attachmentRow({ id: "gone" }),
      attachmentRow({ id: "ok" }),
    ]);
    imapClient.download
      .mockResolvedValueOnce({})
      .mockResolvedValueOnce({ content: Readable.from([PDF]) });
    emailFindFirst.mockResolvedValue({
      id: "e1",
      gmailId: "icloud-imap:me@example.com:42",
      linkedInboxAccountId: "acc-icloud",
      messageIdHeader: null,
    });

    const res = await ocr();

    expect(res.statusCode).toBe(200);
    expect(res.json().results.map((r: { status: string }) => r.status)).toEqual([
      "failed",
      "analyzed",
    ]);
    expect(updates()).toEqual([
      { analysisStatus: "VISION_FAILED", analysisError: "Attachment body not found" },
      expect.objectContaining({ analysisStatus: "ANALYZED" }),
    ]);
  });

  it("marks a row VISION_FAILED with the session layer's short error (502)", async () => {
    runAccountTask.mockResolvedValue({ error: "iCloud did not answer in time." });

    const res = await ocr();

    expect(res.statusCode).toBe(200);
    expect(updates()).toEqual([
      { analysisStatus: "VISION_FAILED", analysisError: "iCloud did not answer in time." },
    ]);
    expect(createVisionCompletion).not.toHaveBeenCalled();
  });
});

describe("POST /:id/attachments/ocr → Outlook mailbox", () => {
  beforeEach(() => {
    linkedFindFirst.mockResolvedValue({ provider: "OUTLOOK" });
    emailFindFirst.mockResolvedValue({
      id: "e1",
      gmailId: "outlook:me@example.com:AAMk=",
      linkedInboxAccountId: "acc-o",
      messageIdHeader: null,
    });
    attachmentFindMany.mockResolvedValue([
      attachmentRow({ gmailAttachmentId: "att-1", partKey: null }),
    ]);
  });

  it("fetches the bytes through Graph and stores the analysis", async () => {
    fetchOutlookAttachmentBytes.mockResolvedValue({ bytes: PDF });

    const res = await ocr();

    expect(res.statusCode).toBe(200);
    expect(resolveOutlookBearer).toHaveBeenCalledWith("user-1", "acc-o");
    expect(fetchOutlookAttachmentBytes).toHaveBeenCalledWith(
      "at",
      "AAMk=",
      "att-1",
      MAX_ATTACHMENT_DOWNLOAD_BYTES,
    );
    expect(updates()).toEqual([expect.objectContaining({ analysisStatus: "ANALYZED" })]);
  });

  it("marks a too-large part VISION_FAILED (413)", async () => {
    fetchOutlookAttachmentBytes.mockResolvedValue({ tooLarge: true });

    await ocr();

    expect(updates()).toEqual([
      {
        analysisStatus: "VISION_FAILED",
        analysisError: "Attachment is too large to download here",
      },
    ]);
  });

  it("answers 409 when Outlook is not connected, touching no row", async () => {
    resolveOutlookBearer.mockResolvedValue(null);

    const res = await ocr();

    expect(res.statusCode).toBe(409);
    expect(res.json()).toEqual({ error: "Outlook not connected" });
    expect(attachmentUpdate).not.toHaveBeenCalled();
  });
});
