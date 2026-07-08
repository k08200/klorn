/**
 * download/convert/ocr in routes/email-attachments.ts (#761, same class as
 * #757): the source message may live on a linked secondary Gmail inbox, not
 * the primary. All three must resolve credentials via resolveMailClient with
 * that message's linkedInboxAccountId, not always the primary account.
 */

import Fastify from "fastify";
import { beforeEach, describe, expect, it, vi } from "vitest";

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
}));
vi.mock("../db.js", () => {
  const prisma = {
    emailAttachment: { findFirst: attachmentFindFirst, findMany: attachmentFindMany },
    emailMessage: { findFirst: emailFindFirst },
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
vi.mock("../gmail.js", () => ({ resolveMailClient, GMAIL_TOOLS: [] }));
vi.mock("../email-attachments.js", () => ({
  analyzeEmailAttachmentsForEmail: vi.fn(),
  analyzePendingEmailAttachments: vi.fn(),
  buildAttachmentCandidateProfile: vi.fn(() => null),
  buildAttachmentCorrectionGuidance: vi.fn(),
  listEmailAttachments: vi.fn(async () => []),
}));
vi.mock("../email-candidate-intake.js", () => ({
  syncCandidateIntakeForEmail: vi.fn(),
  syncRecentCandidateIntakes: vi.fn(),
}));
vi.mock("../feedback.js", () => ({ recordFeedback: vi.fn() }));
vi.mock("../file-conversion-store.js", () => ({ saveConversionResult: vi.fn() }));
vi.mock("../file-conversions.js", () => ({
  convertEmailAttachment: vi.fn(),
  FileConversionError: class extends Error {},
  normalizeConversionTarget: vi.fn(() => "pdf"),
  requiresOriginalAttachment: vi.fn(() => true),
  SUPPORTED_CONVERSION_TARGETS: ["pdf"],
}));
vi.mock("../llm-credentials.js", () => ({ getUserLlmCredentials: vi.fn() }));
vi.mock("../openai.js", () => ({ createVisionCompletion: vi.fn(), VISION_MODEL: "test-vision" }));
vi.mock("../vision-attachment-policy.js", () => ({
  isDecorativeImage: vi.fn(() => false),
  isVisionAttachment: vi.fn(() => false),
  MAX_VISION_ATTACHMENT_BYTES: 10_000_000,
}));

import { registerEmailAttachmentsRoutes } from "../routes/email-attachments.js";

async function buildApp() {
  const app = Fastify();
  await app.register(registerEmailAttachmentsRoutes, { prefix: "/api/email" });
  return app;
}

beforeEach(() => {
  resolveMailClient.mockReset();
  attachmentFindFirst.mockReset();
  emailFindFirst.mockReset();
  attachmentFindMany.mockClear();
  gmailAttachmentsGet.mockClear();
  resolveMailClient.mockResolvedValue({}); // truthy auth object
});

describe("GET /:id/attachments/:attachmentId/download", () => {
  it("resolves credentials with the message's linkedInboxAccountId (#761)", async () => {
    attachmentFindFirst.mockResolvedValue({
      id: "a1",
      gmailAttachmentId: "ga1",
      filename: "f.pdf",
      mimeType: "application/pdf",
      email: { gmailId: "g1", linkedInboxAccountId: "linked-acct-1" },
    });
    const app = await buildApp();
    const res = await app.inject({
      method: "GET",
      url: "/api/email/e1/attachments/a1/download",
    });
    expect(res.statusCode).toBe(200);
    expect(resolveMailClient).toHaveBeenCalledWith("user-1", "linked-acct-1");
    await app.close();
  });

  it("resolves credentials with undefined (primary) for a non-linked message", async () => {
    attachmentFindFirst.mockResolvedValue({
      id: "a1",
      gmailAttachmentId: "ga1",
      filename: "f.pdf",
      mimeType: "application/pdf",
      email: { gmailId: "g1", linkedInboxAccountId: null },
    });
    const app = await buildApp();
    await app.inject({ method: "GET", url: "/api/email/e1/attachments/a1/download" });
    expect(resolveMailClient).toHaveBeenCalledWith("user-1", null);
    await app.close();
  });
});

describe("POST /:id/attachments/:attachmentId/convert", () => {
  it("resolves credentials with the message's linkedInboxAccountId (#761)", async () => {
    attachmentFindFirst.mockResolvedValue({
      id: "a1",
      gmailAttachmentId: "ga1",
      filename: "f.docx",
      mimeType: "application/msword",
      keyPoints: null,
      extractedFields: null,
      category: null,
      analysisStatus: "ANALYZED",
      analysisError: null,
      email: { gmailId: "g1", linkedInboxAccountId: "linked-acct-2" },
    });
    const app = await buildApp();
    await app.inject({
      method: "POST",
      url: "/api/email/e1/attachments/a1/convert",
      payload: { targetFormat: "pdf" },
    });
    expect(resolveMailClient).toHaveBeenCalledWith("user-1", "linked-acct-2");
    await app.close();
  });
});

describe("POST /:id/attachments/ocr", () => {
  it("resolves credentials with the message's linkedInboxAccountId (#761)", async () => {
    emailFindFirst.mockResolvedValue({
      id: "e1",
      gmailId: "g1",
      linkedInboxAccountId: "linked-acct-3",
    });
    const app = await buildApp();
    const res = await app.inject({ method: "POST", url: "/api/email/e1/attachments/ocr" });
    expect(res.statusCode).toBe(200);
    expect(resolveMailClient).toHaveBeenCalledWith("user-1", "linked-acct-3");
    await app.close();
  });

  it("resolves credentials with undefined (primary) for a non-linked message", async () => {
    emailFindFirst.mockResolvedValue({ id: "e1", gmailId: "g1", linkedInboxAccountId: null });
    const app = await buildApp();
    await app.inject({ method: "POST", url: "/api/email/e1/attachments/ocr" });
    expect(resolveMailClient).toHaveBeenCalledWith("user-1", null);
    await app.close();
  });
});
