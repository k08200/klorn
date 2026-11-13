/**
 * The download and convert routes fetch bytes through fetchStoredAttachmentBytes
 * (mail/attachment-bytes.ts), so an iCloud, Naver or Outlook row downloads from
 * its own mailbox. The route owns the row lookup (id AND userId) and maps the
 * fetcher's failures to their status codes.
 */

import Fastify from "fastify";
import { beforeEach, describe, expect, it, vi } from "vitest";

const fetchStoredAttachmentBytes = vi.hoisted(() => vi.fn());
vi.mock("../mail/attachment-bytes.js", () => ({ fetchStoredAttachmentBytes }));

const resolveMailClient = vi.hoisted(() => vi.fn());
const attachmentFindFirst = vi.hoisted(() => vi.fn());
const emailFindFirst = vi.hoisted(() => vi.fn());
const attachmentFindMany = vi.hoisted(() => vi.fn(async () => []));
const gmailAttachmentsGet = vi.hoisted(() =>
  vi.fn(async () => ({ data: { data: Buffer.from("x").toString("base64url") } })),
);

vi.mock("../auth.js", () => ({
  requireAuth: async () => {},
  getUserId: () => "user-1",
  resolveEffectiveJwtSecret: () => "test-secret",
}));
vi.mock("../db.js", () => {
  const prisma = {
    emailAttachment: { findFirst: attachmentFindFirst, findMany: attachmentFindMany },
    emailMessage: { findFirst: emailFindFirst },
    // The download/convert routes ask which provider a linked inbox is (attachment-bytes.ts).
    linkedInboxAccount: { findFirst: async () => ({ provider: "GOOGLE" }) },
  };
  return { prisma, db: prisma };
});
vi.mock("googleapis", () => ({
  google: {
    gmail: () => ({
      users: { messages: { attachments: { get: gmailAttachmentsGet } } },
    }),
  },
}));
vi.mock("../mail/gmail.js", () => ({ resolveMailClient, GMAIL_TOOLS: [] }));
vi.mock("../mail/email-attachments.js", () => ({
  analyzeEmailAttachmentsForEmail: vi.fn(),
  analyzePendingEmailAttachments: vi.fn(),
  buildAttachmentCandidateProfile: vi.fn(() => null),
  buildAttachmentCorrectionGuidance: vi.fn(),
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
vi.mock("../llm/llm-credentials.js", () => ({ getUserLlmCredentials: vi.fn() }));
vi.mock("../llm/openai.js", () => ({
  createVisionCompletion: vi.fn(),
  VISION_MODEL: "test-vision",
}));
vi.mock("../mail/vision-attachment-policy.js", () => ({
  isDecorativeImage: vi.fn(() => false),
  isVisionAttachment: vi.fn(() => false),
  MAX_VISION_ATTACHMENT_BYTES: 10_000_000,
  VISION_OCR_MAX_TOKENS: 16_000,
}));

import { registerEmailAttachmentsRoutes } from "../routes/email-attachments.js";

const ICLOUD_ROW = {
  id: "a1",
  gmailAttachmentId: "2",
  partKey: "2",
  filename: "견적서.pdf",
  mimeType: "application/pdf",
  email: { gmailId: "icloud-imap:me@icloud.com:7", linkedInboxAccountId: "acc-icloud" },
};

async function download() {
  const app = Fastify();
  await app.register(registerEmailAttachmentsRoutes, { prefix: "/api/email" });
  const res = await app.inject({ method: "GET", url: "/api/email/e1/attachments/a1/download" });
  await app.close();
  return res;
}

beforeEach(() => {
  vi.clearAllMocks();
  attachmentFindFirst.mockResolvedValue(ICLOUD_ROW);
});

describe("attachment download through the row's own mailbox", () => {
  it("looks the row up by id AND the caller, then serves the fetched bytes", async () => {
    fetchStoredAttachmentBytes.mockResolvedValue({ ok: true, bytes: Buffer.from("%PDF") });

    const res = await download();

    expect(attachmentFindFirst).toHaveBeenCalledWith(
      expect.objectContaining({ where: expect.objectContaining({ id: "a1", userId: "user-1" }) }),
    );
    expect(fetchStoredAttachmentBytes).toHaveBeenCalledWith("user-1", ICLOUD_ROW);
    expect(res.statusCode).toBe(200);
    expect(res.rawPayload).toEqual(Buffer.from("%PDF"));
    // A Korean name used to throw in the header writer (500); it now rides in filename*.
    expect(res.headers["content-disposition"]).toBe(
      `attachment; filename="___.pdf"; filename*=UTF-8''${encodeURIComponent("견적서.pdf")}`,
    );
    expect(resolveMailClient).not.toHaveBeenCalled();
  });

  it("answers 404 for another user's attachment without fetching anything", async () => {
    attachmentFindFirst.mockResolvedValue(null);

    const res = await download();

    expect(res.statusCode).toBe(404);
    expect(fetchStoredAttachmentBytes).not.toHaveBeenCalled();
  });

  it.each([
    [409, "iCloud mailbox is not connected."],
    [413, "Attachment is too large to download here"],
    [502, "iCloud did not answer in time."],
  ])("maps a %i failure through", async (status, error) => {
    fetchStoredAttachmentBytes.mockResolvedValue({ ok: false, status, error });

    const res = await download();

    expect(res.statusCode).toBe(status);
    expect(res.json()).toEqual({ error });
  });
});
