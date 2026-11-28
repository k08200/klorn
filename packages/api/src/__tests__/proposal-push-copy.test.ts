/**
 * proposalPushContent — the device push of an agent approval. Under
 * NOTIFY_PUSH_PRESENTATION a reply draft (`send_email` + `in_reply_to_email_id`
 * naming one of the user's stored mails, addressed to that mail's sender) reads
 * the NT0 agent copy: "답장 초안 준비됨 · Terry Smith" / the draft's first line in
 * quotes. Draft text is message content, so no send_email push shows model
 * text as its body unless NOTIFY_PUSH_QUOTE is also open: a fixed line instead.
 * Whenever the text changes, the old text rides as `policyText` for the noise
 * policy. Another tool, or the flag off, is exactly the old push.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const db = vi.hoisted(() => ({
  findFirst: vi.fn(),
  config: { notificationLanguage: "ko" } as Record<string, unknown> | null,
}));

vi.mock("../db.js", () => ({
  prisma: {
    emailMessage: { findFirst: db.findFirst },
    automationConfig: { findUnique: vi.fn(async () => db.config) },
  },
}));

import { proposalPushContent } from "../agentcore/proposal-push-target.js";

const FALLBACK = { title: "[Klorn] Review needed", body: "Reply to Terry about the quote" };
const REPLY = {
  to: "terry@acme.com",
  subject: "Re: 견적서 최종 확인",
  body: "네, 오늘 17시 전에 최종본 보내드리겠습니다.\n\n감사합니다.",
  in_reply_to_email_id: "gm_abc",
};
const MAIL = { id: "em_1", from: "Terry Smith <terry@acme.com>", threadId: "thr-1" };

beforeEach(() => {
  db.findFirst.mockReset();
  db.config = { notificationLanguage: "ko" };
  delete process.env.NOTIFY_PUSH_PRESENTATION;
  delete process.env.NOTIFY_PUSH_QUOTE;
});

afterEach(() => {
  delete process.env.NOTIFY_PUSH_PRESENTATION;
  delete process.env.NOTIFY_PUSH_QUOTE;
});

describe("proposalPushContent", () => {
  it("flag off: the old push plus the native deep link, read exactly as before", async () => {
    db.findFirst.mockResolvedValue({ id: "em_1" });

    const out = await proposalPushContent("u1", "send_email", REPLY, "pa_9", FALLBACK);

    expect(out).toEqual({ ...FALLBACK, emailId: "em_1", pendingActionId: "pa_9" });
    expect(db.findFirst).toHaveBeenCalledWith({
      where: { userId: "u1", OR: [{ id: "gm_abc" }, { gmailId: "gm_abc" }] },
      select: { id: true },
    });
  });

  it("flag on, quote open: the person in the title and the draft's first line as the body", async () => {
    process.env.NOTIFY_PUSH_PRESENTATION = "on";
    process.env.NOTIFY_PUSH_QUOTE = "on";
    db.findFirst.mockResolvedValue(MAIL);

    const out = await proposalPushContent("u1", "send_email", REPLY, "pa_9", FALLBACK);

    expect(out).toEqual({
      title: "답장 초안 준비됨 · Terry Smith",
      body: "“네, 오늘 17시 전에 최종본 보내드리겠습니다.”",
      emailId: "em_1",
      pendingActionId: "pa_9",
      presentation: { kind: "agent", senderDisplayName: "Terry Smith", threadId: "thr-1" },
      policyText: FALLBACK,
    });
    expect(db.findFirst).toHaveBeenCalledWith({
      where: { userId: "u1", OR: [{ id: "gm_abc" }, { gmailId: "gm_abc" }] },
      select: { id: true, from: true, threadId: true },
    });
  });

  it("flag on, quote closed: a fixed line, never the draft", async () => {
    process.env.NOTIFY_PUSH_PRESENTATION = "on";
    db.config = { notificationLanguage: "en" };
    db.findFirst.mockResolvedValue(MAIL);

    const out = await proposalPushContent("u1", "send_email", REPLY, "pa_9", FALLBACK);

    expect(out.title).toBe("Reply draft ready · Terry Smith");
    expect(out.body).toBe("Review it before it is sent");
    expect(out.policyText).toEqual(FALLBACK);
    const { policyText: _old, ...shown } = out;
    expect(JSON.stringify(shown)).not.toContain("17시");
  });

  it("flag on: a draft addressed to someone else does not name the mail's sender", async () => {
    process.env.NOTIFY_PUSH_PRESENTATION = "on";
    process.env.NOTIFY_PUSH_QUOTE = "on";
    db.findFirst.mockResolvedValue(MAIL);

    const out = await proposalPushContent(
      "u1",
      "send_email",
      { ...REPLY, to: "someone@else.com" },
      "pa_9",
      FALLBACK,
    );

    expect(out).toEqual({ ...FALLBACK, emailId: "em_1", pendingActionId: "pa_9" });
  });

  it("flag on: a recipient list holding the sender, in any case, is a reply to them", async () => {
    process.env.NOTIFY_PUSH_PRESENTATION = "on";
    db.findFirst.mockResolvedValue(MAIL);

    const out = await proposalPushContent(
      "u1",
      "send_email",
      { ...REPLY, to: "cc@acme.com; Terry <TERRY@ACME.COM>" },
      "pa_9",
      FALLBACK,
    );

    expect(out.title).toBe("답장 초안 준비됨 · Terry Smith");
  });

  it("flag on, quote closed: a send_email push that is not a resolved reply shows no model text", async () => {
    process.env.NOTIFY_PUSH_PRESENTATION = "on";
    const fresh = { to: "new@acme.com", subject: "Hello", body: "Secret plan inside" };

    const out = await proposalPushContent("u1", "send_email", fresh, "pa_1", FALLBACK);

    expect(out).toEqual({
      title: FALLBACK.title,
      body: "보내기 전에 확인하세요",
      policyText: FALLBACK,
    });
    expect(db.findFirst).not.toHaveBeenCalled();
  });

  it("flag on: a sender with no display name is named by domain and carries no name field", async () => {
    process.env.NOTIFY_PUSH_PRESENTATION = "on";
    db.findFirst.mockResolvedValue({ id: "em_1", from: "terry@acme.com", threadId: null });

    const out = await proposalPushContent("u1", "send_email", REPLY, "pa_9", FALLBACK);

    expect(out.title).toBe("답장 초안 준비됨 · acme.com");
    expect(out.presentation).toEqual({ kind: "agent" });
    const { policyText: _old, ...shown } = out;
    expect(JSON.stringify(shown)).not.toContain("terry@acme.com");
  });

  it("flag on, quote open: anything but a reply draft to the user's own mail is the old push", async () => {
    process.env.NOTIFY_PUSH_PRESENTATION = "on";
    process.env.NOTIFY_PUSH_QUOTE = "on";
    expect(
      await proposalPushContent("u1", "create_event", { title: "x" }, "pa_1", FALLBACK),
    ).toEqual(FALLBACK);
    expect(
      await proposalPushContent("u1", "send_email", { to: "a@b.c", body: "hi" }, "pa_1", FALLBACK),
    ).toEqual(FALLBACK);
    db.findFirst.mockResolvedValue(null);
    expect(await proposalPushContent("u1", "send_email", REPLY, "pa_1", FALLBACK)).toEqual(
      FALLBACK,
    );
  });

  it("flag on, quote open: a failed mail read is the old push with no deep link, as before", async () => {
    process.env.NOTIFY_PUSH_PRESENTATION = "on";
    process.env.NOTIFY_PUSH_QUOTE = "on";
    vi.spyOn(console, "error").mockImplementation(() => {});
    vi.spyOn(console, "warn").mockImplementation(() => {});
    db.findFirst.mockRejectedValue(new Error("db down"));

    expect(await proposalPushContent("u1", "send_email", REPLY, "pa_1", FALLBACK)).toEqual(
      FALLBACK,
    );
  });
});
