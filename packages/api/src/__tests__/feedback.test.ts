import { beforeEach, describe, expect, it, vi } from "vitest";

const createSpy = vi.fn(async () => ({}));

vi.mock("../db.js", () => {
  const prisma = {
    feedbackEvent: { create: createSpy },
  };
  return { prisma, db: prisma };
});

const { recordFeedback, recipientFromToolArgs } = await import("../feedback.js");

beforeEach(() => createSpy.mockClear());

describe("recordFeedback", () => {
  it("writes a row with the structured signal payload", async () => {
    await recordFeedback({
      userId: "u",
      source: "PENDING_ACTION",
      sourceId: "pa-1",
      signal: "APPROVED",
      toolName: "send_email",
      recipient: "sarah@x.com",
      threadId: "c-1",
    });
    const call = createSpy.mock.calls[0]?.[0] as {
      data: {
        userId: string;
        source: string;
        sourceId: string;
        signal: string;
        toolName: string | null;
        recipient: string | null;
        threadId: string | null;
        evidence: string | null;
      };
    };
    expect(call.data).toMatchObject({
      userId: "u",
      source: "PENDING_ACTION",
      sourceId: "pa-1",
      signal: "APPROVED",
      toolName: "send_email",
      recipient: "sarah@x.com",
      threadId: "c-1",
      evidence: null,
    });
  });

  it("normalises optional fields to null when omitted", async () => {
    await recordFeedback({
      userId: "u",
      source: "PENDING_ACTION",
      sourceId: "pa-2",
      signal: "REJECTED",
    });
    const call = createSpy.mock.calls[0]?.[0] as {
      data: {
        toolName: string | null;
        recipient: string | null;
        threadId: string | null;
        evidence: string | null;
      };
    };
    expect(call.data.toolName).toBeNull();
    expect(call.data.recipient).toBeNull();
    expect(call.data.threadId).toBeNull();
    expect(call.data.evidence).toBeNull();
  });

  it("records failed execution signals with evidence", async () => {
    await recordFeedback({
      userId: "u",
      source: "PENDING_ACTION",
      sourceId: "pa-failed",
      signal: "FAILED",
      toolName: "send_email",
      evidence: "SMTP rejected recipient",
    });
    const call = createSpy.mock.calls[0]?.[0] as {
      data: { signal: string; toolName: string | null; evidence: string | null };
    };
    expect(call.data).toMatchObject({
      signal: "FAILED",
      toolName: "send_email",
      evidence: "SMTP rejected recipient",
    });
  });

  it("never throws when prisma fails — feedback is observability, not control flow", async () => {
    createSpy.mockRejectedValueOnce(new Error("db down"));
    await expect(
      recordFeedback({
        userId: "u",
        source: "PENDING_ACTION",
        sourceId: "pa-3",
        signal: "APPROVED",
      }),
    ).resolves.toBeUndefined();
  });
});

describe("recipientFromToolArgs", () => {
  it("pulls 'to' when present", () => {
    expect(recipientFromToolArgs(JSON.stringify({ to: "sarah@x.com", body: "hi" }))).toBe(
      "sarah@x.com",
    );
  });

  it("falls back to alternate keys", () => {
    expect(recipientFromToolArgs(JSON.stringify({ recipient: "alex@x.com" }))).toBe("alex@x.com");
    expect(recipientFromToolArgs(JSON.stringify({ email: "j@y.com" }))).toBe("j@y.com");
  });

  it("returns null when args have no recognised recipient field", () => {
    expect(recipientFromToolArgs(JSON.stringify({ subject: "hello" }))).toBeNull();
  });

  it("returns null on malformed JSON", () => {
    expect(recipientFromToolArgs("{not json")).toBeNull();
  });

  it("trims whitespace and ignores empty strings", () => {
    expect(recipientFromToolArgs(JSON.stringify({ to: "  sarah@x.com  " }))).toBe("sarah@x.com");
    expect(recipientFromToolArgs(JSON.stringify({ to: "   " }))).toBeNull();
  });
});
