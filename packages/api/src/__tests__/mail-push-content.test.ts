/**
 * Decision N1 (2026-11-08): every surface shows an urgent-mail notification the
 * same way. Title = the sender's display name only (the OS already shows the
 * app name). Body = the subject (localized stand-in when empty), then the
 * reason line: the verified quote from the mail when there is one (NC1), else
 * the judge's one-line reason. Web actions: Reply and Later for a PUSH mail,
 * Later for a MEETING mail. There is no Silent / Mute action.
 */

import { describe, expect, it } from "vitest";
import {
  MAIL_PUSH_REASON_MAX,
  mailPushContent,
  mailPushReplyPath,
  mailPushWebActions,
} from "../notify/mail-push-content.js";
import { NOTIFICATION_LANGUAGES, notificationCopy } from "../notify/notification-strings.js";
import { pushActionCopy } from "../notify/push-action-strings.js";

describe("mailPushContent", () => {
  it("titles the notification with the sender's name only, no app prefix", () => {
    const content = mailPushContent({
      from: "Alice Kim <alice@example.com>",
      subject: "Contract",
      reason: { text: "Signature needed today", verified: false },
      language: "en",
    });
    expect(content.title).toBe("Alice Kim");
    expect(content.title).not.toContain("Klorn");
  });

  it("puts the subject on line 1 and the reason on line 2", () => {
    const content = mailPushContent({
      from: "Alice <alice@example.com>",
      subject: "Contract",
      reason: { text: "Signature needed today", verified: false },
      language: "en",
    });
    expect(content.body).toBe("Contract\nSignature needed today");
  });

  it("omits the reason line when there is no reason", () => {
    for (const reason of [
      null,
      undefined,
      { text: "", verified: false },
      { text: "   ", verified: false },
    ]) {
      const content = mailPushContent({ from: "a@b.c", subject: "Hi", reason, language: "en" });
      expect(content.body).toBe("Hi");
    }
  });

  it.each(NOTIFICATION_LANGUAGES)("%s: an empty subject uses the localized stand-in", (lang) => {
    const content = mailPushContent({
      from: "Bob <b@x.io>",
      subject: "",
      reason: null,
      language: lang,
    });
    expect(content.body).toBe(notificationCopy(lang).noSubject);
  });

  it("falls back to the raw address when the From header has no display name", () => {
    expect(mailPushContent({ from: "b@x.io", subject: "s", language: "en" }).title).toBe("b@x.io");
  });

  it("keeps mail-authored text on one line each (no injected extra lines or control chars)", () => {
    const content = mailPushContent({
      from: '"Evil\nKlorn Security" <e@x.io>',
      subject: "Pay now\r\nYour account is locked\u0007",
      reason: { text: "line one\nline two", verified: false },
      language: "en",
    });
    expect(content.title).toBe("Evil Klorn Security");
    expect(content.body.split("\n")).toEqual([
      "Pay now Your account is locked",
      "line one line two",
    ]);
  });

  it("drops bidi override marks that would reorder what the user reads", () => {
    const content = mailPushContent({
      from: "a@b.c",
      subject: "Invoice \u202egnp.exe\u202c",
      language: "en",
    });
    expect(content.body).toBe("Invoice gnp.exe");
  });

  it("caps the reason line", () => {
    const content = mailPushContent({
      from: "a@b.c",
      subject: "s",
      reason: { text: "x".repeat(500), verified: false },
      language: "en",
    });
    const reasonLine = content.body.split("\n")[1] ?? "";
    expect(reasonLine.length).toBeLessThanOrEqual(MAIL_PUSH_REASON_MAX);
    expect(reasonLine.endsWith("…")).toBe(true);
  });

  it("strips HTML from mail text: notifications are plain text and carry no markup", () => {
    const content = mailPushContent({
      from: "<b>Mallory</b> <m@b.c>",
      subject: 'Invoice <img src=x onerror=alert(1)> <a href="https://e.vil">due</a>',
      reason: { text: "<script>alert(1)</script>Pay today", verified: false },
      language: "en",
    });
    expect(content.title).toBe("Mallory");
    expect(content.body).toBe("Invoice due\nalert(1) Pay today");
    expect(content.title + content.body).not.toMatch(/[<>]/);
  });

  it("keeps a comparison that is not a tag", () => {
    const content = mailPushContent({
      from: "a@b.c",
      subject: "Q3: cost < 5% > plan",
      language: "en",
    });
    expect(content.body).toBe("Q3: cost < 5% > plan");
  });

  it("a subject that is only markup reads as the localized no-subject stand-in", () => {
    const content = mailPushContent({ from: "a@b.c", subject: "<div></div>", language: "en" });
    expect(content.body).toBe(notificationCopy("en").noSubject);
  });

  it("titles a bare <address> From header with the address", () => {
    expect(mailPushContent({ from: "<b@x.io>", subject: "s", language: "en" }).title).toBe(
      "b@x.io",
    );
  });

  it("bounds the work on a huge subject before any pattern runs", () => {
    const content = mailPushContent({
      from: "a@b.c",
      subject: `${"<a ".repeat(50_000)}tail`,
      language: "en",
    });
    expect(content.body.length).toBeLessThanOrEqual(180);
  });
});

describe("mailPushContent — reason line (NC1)", () => {
  it("a verified quote replaces the short reason, in curly quotes", () => {
    const content = mailPushContent({
      from: "Alice <a@b.c>",
      subject: "Contract",
      reason: {
        text: "Signature needed today",
        verified: true,
        quote: "Please sign by 5pm today",
        quoteIn: "body",
      },
      language: "en",
    });
    expect(content.body).toBe("Contract\n“Please sign by 5pm today”");
  });

  it("quotation marks the quote already carries are not doubled", () => {
    const content = mailPushContent({
      from: "a@b.c",
      subject: "s",
      reason: { text: "t", verified: true, quote: '"Please sign by 5pm"' },
      language: "en",
    });
    expect(content.body.split("\n")[1]).toBe("“Please sign by 5pm”");
  });

  it("an unverified quote is never shown: the short reason is", () => {
    const content = mailPushContent({
      from: "a@b.c",
      subject: "s",
      reason: { text: "Looks urgent", verified: false, quote: "wire the money now" },
      language: "en",
    });
    expect(content.body).toBe("s\nLooks urgent");
  });

  it("a verified reason with an empty quote falls back to the text", () => {
    const content = mailPushContent({
      from: "a@b.c",
      subject: "s",
      reason: { text: "Looks urgent", verified: true, quote: "  " },
      language: "en",
    });
    expect(content.body).toBe("s\nLooks urgent");
  });

  it("caps a long quote, marks included", () => {
    const content = mailPushContent({
      from: "a@b.c",
      subject: "s",
      reason: { text: "t", verified: true, quote: "y".repeat(400) },
      language: "en",
    });
    const line = content.body.split("\n")[1] ?? "";
    expect(line.length).toBeLessThanOrEqual(MAIL_PUSH_REASON_MAX);
    expect(line.startsWith("“")).toBe(true);
    expect(line.endsWith("…”")).toBe(true);
  });
});

describe("mailPushWebActions", () => {
  it.each(NOTIFICATION_LANGUAGES)("%s: a PUSH mail offers Reply then Later, localized", (lang) => {
    const copy = pushActionCopy(lang);
    expect(mailPushWebActions("PUSH", lang)).toEqual([
      { action: "reply", title: copy.reply },
      { action: "later", title: copy.later },
    ]);
  });

  it("a MEETING mail offers Later only (no verified meeting link exists for a mail)", () => {
    expect(mailPushWebActions("MEETING", "en")).toEqual([{ action: "later", title: "Later" }]);
  });

  it("never offers a silencing or retiering action on the web", () => {
    for (const lane of ["PUSH", "MEETING"] as const) {
      const ids = mailPushWebActions(lane, "en").map((a) => a.action);
      expect(ids).not.toContain("silent");
      expect(ids).not.toContain("queue");
      expect(ids.length).toBeLessThanOrEqual(2);
    }
  });
});

describe("mailPushReplyPath", () => {
  it("is a same-origin reader path with the reply composer focused", () => {
    expect(mailPushReplyPath("email-1")).toBe("/email/email-1?focus=reply");
  });

  it("encodes the id so it can never leave the path", () => {
    expect(mailPushReplyPath("../x?y#z")).toBe("/email/..%2Fx%3Fy%23z?focus=reply");
  });
});
