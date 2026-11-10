/**
 * mark_read over MCP — the id contract (step A2a). list_emails / read_email
 * hand an MCP client the raw Gmail message id (mail/gmail.ts listEmails:
 * `id: msg.id`; readEmail echoes its input), so mark_read must accept exactly
 * that, resolve it to the caller's OWN row only, and never act on another
 * user's message. The real executor runs; only the DB and the mail provider
 * seam are mocked.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const findFirst = vi.hoisted(() => vi.fn());
const markAsRead = vi.hoisted(() => vi.fn());
const mailActionsFor = vi.hoisted(() => vi.fn());

vi.mock("../db.js", () => {
  const prisma = { emailMessage: { findFirst } };
  return { prisma, db: prisma };
});
vi.mock("../sentry.js", () => ({ captureError: vi.fn() }));
vi.mock("../mail/providers/dispatch.js", () => ({ mailActionsFor }));

import { executeToolCall } from "../agentcore/tool-executor.js";

beforeEach(() => {
  findFirst.mockReset();
  markAsRead.mockReset();
  mailActionsFor.mockReset();
  markAsRead.mockResolvedValue({ success: true });
  mailActionsFor.mockResolvedValue({ markAsRead });
});

describe("mark_read id contract", () => {
  it("accepts the Gmail id that list_emails returns and marks that message read", async () => {
    findFirst.mockResolvedValueOnce({ gmailId: "18c3f0a1b2c3d4e5", linkedInboxAccountId: null });
    const out = await executeToolCall("user-1", "mark_read", { email_id: "18c3f0a1b2c3d4e5" });
    expect(JSON.parse(out)).toEqual({ success: true });
    expect(markAsRead).toHaveBeenCalledWith("user-1", "18c3f0a1b2c3d4e5", null);
  });

  it("scopes the row lookup to the calling user (ownership), by Klorn id OR Gmail id", async () => {
    findFirst.mockResolvedValueOnce(null);
    await executeToolCall("user-1", "mark_read", { email_id: "someone-elses-id" });
    expect(findFirst).toHaveBeenCalledWith({
      where: {
        userId: "user-1",
        OR: [{ id: "someone-elses-id" }, { gmailId: "someone-elses-id" }],
      },
      select: { gmailId: true, linkedInboxAccountId: true },
    });
  });

  it("routes a linked-inbox message through that inbox's account, not the primary", async () => {
    findFirst.mockResolvedValueOnce({ gmailId: "g-linked", linkedInboxAccountId: "linked-9" });
    await executeToolCall("user-1", "mark_read", { email_id: "g-linked" });
    expect(mailActionsFor).toHaveBeenCalledWith("user-1", "linked-9");
    expect(markAsRead).toHaveBeenCalledWith("user-1", "g-linked", "linked-9");
  });

  it("for an id with no row, acts through the caller's OWN primary client only", async () => {
    findFirst.mockResolvedValueOnce(null);
    await executeToolCall("user-1", "mark_read", { email_id: "g-unsynced" });
    // No row means no linked inbox: the primary account of user-1, never a
    // client belonging to anyone else.
    expect(mailActionsFor).toHaveBeenCalledWith("user-1", null);
    expect(markAsRead).toHaveBeenCalledWith("user-1", "g-unsynced", undefined);
  });

  it("answers a structured error for a missing or blank email_id and never calls the provider", async () => {
    for (const args of [{}, { email_id: "" }, { email_id: "   " }, { email_id: 7 }]) {
      const out = JSON.parse(await executeToolCall("user-1", "mark_read", args));
      expect(out.error).toMatch(/email_id/);
    }
    expect(markAsRead).not.toHaveBeenCalled();
  });
});
