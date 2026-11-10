/**
 * Web reply-draft panel: the AI-draft Send names the mail it answers — the pure
 * request builder in packages/web/src/app/email/[id]/reply-draft-send.ts.
 * The route side (stamp, chip, threading, ownership) is pinned by
 * routes-email-send-in-reply-to.test.ts.
 */

import { describe, expect, it } from "vitest";
import { replyDraftSendRequest } from "../../../web/src/app/email/[id]/reply-draft-send";

const DRAFT = {
  to: "  Carol <carol@example.com> ",
  subject: "Re: Lunch?",
  body: "Sure, 3pm.\n\n— Y",
  candidateProfile: null,
};

describe("replyDraftSendRequest", () => {
  it("posts to /api/email/send with the mail it answers", () => {
    const request = replyDraftSendRequest("mail-1", DRAFT);
    expect(request.path).toBe("/api/email/send");
    expect(request.body.inReplyToEmailId).toBe("mail-1");
  });

  it("sends the confirmed bytes unchanged and nothing else", () => {
    expect(replyDraftSendRequest("mail-1", DRAFT).body).toEqual({
      to: "  Carol <carol@example.com> ",
      subject: "Re: Lunch?",
      body: "Sure, 3pm.\n\n— Y",
      inReplyToEmailId: "mail-1",
    });
  });
});
