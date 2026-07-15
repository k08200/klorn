import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  feedbackFindMany: vi.fn(),
}));

vi.mock("../db.js", () => ({ prisma: { feedbackEvent: { findMany: mocks.feedbackFindMany } } }));
vi.mock("../llm/llm-credentials.js", () => ({ getUserLlmCredentials: vi.fn() }));
vi.mock("../llm/openai.js", () => ({ createCompletion: vi.fn(), MODEL: "test-model" }));

import {
  buildAttachmentCandidateProfile,
  buildAttachmentCorrectionGuidance,
  type EmailAttachmentView,
} from "../email-attachments.js";

describe("email attachment candidate profile", () => {
  beforeEach(() => {
    mocks.feedbackFindMany.mockReset();
    mocks.feedbackFindMany.mockResolvedValue([]);
  });

  it("preserves portfolio urls when building a candidate profile", () => {
    const profile = buildAttachmentCandidateProfile([
      attachment({
        filename: "kim-profile.pdf",
        category: "profile",
        extractedFields: {
          name: "김하나",
          role: "배우",
          links: "https://example.com/showreel/actor?id=7",
          skills: "액션, 영어",
        },
      }),
    ]);

    expect(profile?.links).toEqual(["https://example.com/showreel/actor?id=7"]);
    expect(profile?.skills).toEqual(["액션", "영어"]);
  });

  it("does not treat a generic contact-only document as a candidate", () => {
    const profile = buildAttachmentCandidateProfile([
      attachment({
        filename: "invoice.pdf",
        category: "invoice",
        extractedFields: {
          contact: "billing@example.com",
          amount: "KRW 100,000",
        },
      }),
    ]);

    expect(profile).toBeNull();
  });

  it("surfaces candidate files that need manual review", () => {
    const profile = buildAttachmentCandidateProfile([
      attachment({
        filename: "headshot-profile.jpg",
        mimeType: "image/jpeg",
        category: "profile",
        textPreview: "파일명: headshot-profile.jpg\n상태: 이미지 파일 - OCR 분석 대기",
        analysisStatus: "ANALYZED",
      }),
      attachment({
        filename: "actor-profile.hwp",
        category: "profile",
        analysisStatus: "UNSUPPORTED",
      }),
    ]);

    expect(profile?.pipelineStatus).toBe("needs_analysis");
    expect(profile?.manualReviewFiles).toEqual([
      expect.objectContaining({ filename: "headshot-profile.jpg", reason: "Image OCR needed" }),
      expect.objectContaining({
        filename: "actor-profile.hwp",
        reason: "Text extraction unavailable",
      }),
    ]);
    expect(profile?.evidenceFiles.every((file) => file.needsManualReview)).toBe(true);
  });

  it("detects audition image assets by filename without treating every image as a candidate", () => {
    const profile = buildAttachmentCandidateProfile([
      attachment({
        filename: "headshot_leejiyoon.jpg",
        mimeType: "image/jpeg",
        category: "image",
        textPreview: "파일명: headshot_leejiyoon.jpg\n상태: 이미지 파일 - OCR 분석 대기",
        analysisStatus: "ANALYZED",
      }),
      attachment({
        filename: "receipt.jpg",
        mimeType: "image/jpeg",
        category: "image",
        textPreview: "파일명: receipt.jpg\n상태: 이미지 파일 - OCR 분석 대기",
        analysisStatus: "ANALYZED",
      }),
    ]);

    expect(profile?.evidenceFiles.map((file) => file.filename)).toEqual(["headshot_leejiyoon.jpg"]);
    expect(profile?.pipelineStatus).toBe("needs_analysis");
    expect(profile?.manualReviewFiles).toEqual([
      expect.objectContaining({ filename: "headshot_leejiyoon.jpg", reason: "Image OCR needed" }),
    ]);
  });

  it("turns recent attachment corrections into soft guidance", async () => {
    mocks.feedbackFindMany.mockResolvedValueOnce([
      {
        evidence: JSON.stringify({
          filename: "headshot.jpg",
          category: "profile",
          fieldKeys: ["name", "height", "skills"],
        }),
        createdAt: new Date("2026-05-12T00:00:00.000Z"),
      },
    ]);

    const guidance = await buildAttachmentCorrectionGuidance("user-1");

    expect(guidance).toContain("Recent user corrections");
    expect(guidance).toContain("category corrected to profile");
    expect(guidance).toContain("name, height, skills");
  });
});

function attachment(overrides: Partial<EmailAttachmentView>): EmailAttachmentView {
  return {
    id: "att-1",
    emailId: "email-1",
    filename: "file.pdf",
    mimeType: "application/pdf",
    size: 123,
    summary: null,
    textPreview: null,
    keyPoints: [],
    extractedFields: {},
    category: null,
    analysisStatus: "ANALYZED",
    analysisError: null,
    ...overrides,
  };
}
