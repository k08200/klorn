/**
 * Mail v2 reader: the header's Done also sends the reply-needed DISMISSED
 * signal — the pure rules in
 * packages/web/src/app/email/[id]/_v2/reader-done-feedback.ts.
 */

import { describe, expect, it } from "vitest";
import {
  type DoneFeedbackInput,
  doneFeedbackRequest,
} from "../../../web/src/app/email/[id]/_v2/reader-done-feedback";
import { REPLY_SIGNAL_BY_CHOICE } from "../routes/email.js";

const BASE: DoneFeedbackInput = {
  emailId: "mail-1",
  needsReply: true,
  replyState: null,
  sentFor: null,
};

describe("doneFeedbackRequest", () => {
  it("sends the old menu's Done payload for a reply-needed mail", () => {
    expect(doneFeedbackRequest(BASE)).toEqual({
      path: "/api/email/mail-1/reply-needed/feedback",
      body: { choice: "done" },
    });
  });

  it("is the choice the API records as DISMISSED", () => {
    const request = doneFeedbackRequest(BASE);
    expect(request).not.toBeNull();
    expect(REPLY_SIGNAL_BY_CHOICE[request?.body.choice ?? "needed"]).toBe("DISMISSED");
  });

  it("sends nothing for a mail never judged reply-needed", () => {
    expect(doneFeedbackRequest({ ...BASE, needsReply: false })).toBeNull();
  });

  it("does not send twice for the same mail", () => {
    expect(doneFeedbackRequest({ ...BASE, sentFor: "mail-1" })).toBeNull();
  });

  it("still sends for another mail after one was sent", () => {
    expect(doneFeedbackRequest({ ...BASE, sentFor: "mail-0" })).not.toBeNull();
  });

  it("leaves an explicit reply state the user picked in the menu standing", () => {
    for (const choice of ["needed", "today", "waiting_on_me", "waiting_on_them", "not_needed"]) {
      expect(
        doneFeedbackRequest({ ...BASE, replyState: { emailId: "mail-1", choice } }),
      ).toBeNull();
    }
  });

  it("does not resend when a Done is already stored", () => {
    expect(
      doneFeedbackRequest({ ...BASE, replyState: { emailId: "mail-1", choice: "done" } }),
    ).toBeNull();
  });

  it("replaces a stored Later, as picking Done after Later did in the old menu", () => {
    expect(
      doneFeedbackRequest({ ...BASE, replyState: { emailId: "mail-1", choice: "later" } }),
    ).not.toBeNull();
  });

  it("ignores a reply state seen for a different mail", () => {
    expect(
      doneFeedbackRequest({ ...BASE, replyState: { emailId: "mail-0", choice: "needed" } }),
    ).not.toBeNull();
  });

  it("encodes the id into the path", () => {
    expect(doneFeedbackRequest({ ...BASE, emailId: "a/b" })?.path).toBe(
      "/api/email/a%2Fb/reply-needed/feedback",
    );
  });
});
