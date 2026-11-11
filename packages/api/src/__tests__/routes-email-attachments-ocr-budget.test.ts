/**
 * The OCR route asks for the FULL text of an attachment as JSON. With the
 * native Anthropic adapter's default 4,096-token cap, a text-dense multi-page
 * PDF is cut off mid-JSON, the adapter returns "" for the truncated answer,
 * and the row lands in VISION_FAILED ("no readable text") with its summary
 * and fields thrown away. The vision call must carry an explicit output budget.
 */

import Fastify from "fastify";
import { beforeEach, describe, expect, it, vi } from "vitest";

const createVisionCompletion = vi.hoisted(() =>
  vi.fn(async () => ({ choices: [{ message: { content: '{"ocrText":"INVOICE 4821"}' } }] })),
);
const attachmentUpdate = vi.hoisted(() => vi.fn(async () => ({})));

vi.mock("../auth.js", () => ({
  requireAuth: async () => {},
  getUserId: () => "user-1",
  resolveEffectiveJwtSecret: () => "test-secret",
}));
vi.mock("../db.js", () => {
  const prisma = {
    emailAttachment: {
      findMany: vi.fn(async () => [
        {
          id: "a1",
          filename: "invoice.pdf",
          mimeType: "application/pdf",
          size: 40_000,
          contentText: null,
          analysisStatus: "PENDING",
          gmailAttachmentId: "ga1",
        },
      ]),
      update: attachmentUpdate,
    },
    emailMessage: {
      findFirst: vi.fn(async () => ({ id: "e1", gmailId: "g1", linkedInboxAccountId: null })),
    },
  };
  return { prisma, db: prisma };
});
vi.mock("googleapis", () => ({
  google: {
    gmail: () => ({
      users: {
        messages: {
          attachments: {
            get: vi.fn(async () => ({
              data: { data: Buffer.from("%PDF-1.7 x").toString("base64url") },
            })),
          },
        },
      },
    }),
  },
}));
vi.mock("../mail/gmail.js", () => ({
  resolveMailClient: vi.fn(async () => ({})),
  GMAIL_TOOLS: [],
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

import { VISION_OCR_MAX_TOKENS } from "../mail/vision-attachment-policy.js";
import { registerEmailAttachmentsRoutes } from "../routes/email-attachments.js";

beforeEach(() => {
  createVisionCompletion.mockClear();
  attachmentUpdate.mockClear();
});

describe("POST /:id/attachments/ocr — output budget", () => {
  it("gives the vision call room for a multi-page document, not the 4,096 default", async () => {
    const app = Fastify();
    await app.register(registerEmailAttachmentsRoutes, { prefix: "/api/email" });
    const res = await app.inject({ method: "POST", url: "/api/email/e1/attachments/ocr" });
    await app.close();

    expect(res.statusCode).toBe(200);
    expect(createVisionCompletion).toHaveBeenCalledTimes(1);
    const params = createVisionCompletion.mock.calls[0]?.[0] as unknown as { max_tokens?: number };
    expect(params.max_tokens).toBe(VISION_OCR_MAX_TOKENS);
    expect(VISION_OCR_MAX_TOKENS).toBeGreaterThan(4096);
    expect(attachmentUpdate).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ analysisStatus: "ANALYZED" }),
      }),
    );
  });
});
