import { describe, expect, it } from "vitest";
import { inboxAuthKind } from "../mail/inbox-credentials.js";

// Phase 0a of the multi-provider plan: LinkedInboxAccount rows stop being
// implicitly-Google. A row's credential shape is now decided by its provider —
// OAuth providers carry a token cipher, IMAP providers carry host + password
// cipher — and every consumer asks this one function instead of assuming.
// "broken" means the row claims a provider but lacks that provider's
// credentials; callers treat it like needsReconnect, never as a crash.
describe("inboxAuthKind", () => {
  const oauthRow = { accessToken: "cipher", imapHost: null, imapPasswordCipher: null };
  const imapRow = { accessToken: null, imapHost: "imap.naver.com", imapPasswordCipher: "cipher" };

  it("KLORN carries no credentials and is never broken for lacking them (E1a)", () => {
    const bare = { accessToken: null, imapHost: null, imapPasswordCipher: null };
    expect(inboxAuthKind({ provider: "KLORN", ...bare })).toBe("none");
  });

  it("GOOGLE with a token cipher is oauth", () => {
    expect(inboxAuthKind({ provider: "GOOGLE", ...oauthRow })).toBe("oauth");
  });

  it("OUTLOOK with a token cipher is oauth", () => {
    expect(inboxAuthKind({ provider: "OUTLOOK", ...oauthRow })).toBe("oauth");
  });

  it("GOOGLE without a token is broken, not imap", () => {
    expect(inboxAuthKind({ provider: "GOOGLE", ...imapRow })).toBe("broken");
  });

  it("NAVER with host + password cipher is imap", () => {
    expect(inboxAuthKind({ provider: "NAVER", ...imapRow })).toBe("imap");
  });

  it("ICLOUD and generic IMAP follow the imap shape", () => {
    expect(inboxAuthKind({ provider: "ICLOUD", ...imapRow, imapHost: "imap.mail.me.com" })).toBe(
      "imap",
    );
    expect(inboxAuthKind({ provider: "IMAP", ...imapRow, imapHost: "mail.example.com" })).toBe(
      "imap",
    );
  });

  it("an IMAP provider missing its password cipher is broken", () => {
    expect(
      inboxAuthKind({
        provider: "NAVER",
        accessToken: null,
        imapHost: "imap.naver.com",
        imapPasswordCipher: null,
      }),
    ).toBe("broken");
  });

  it("an IMAP provider missing its host is broken", () => {
    expect(
      inboxAuthKind({
        provider: "ICLOUD",
        accessToken: null,
        imapHost: null,
        imapPasswordCipher: "cipher",
      }),
    ).toBe("broken");
  });

  it("an IMAP provider carrying a stray OAuth token is still imap — provider decides", () => {
    expect(
      inboxAuthKind({
        provider: "NAVER",
        accessToken: "stale",
        imapHost: "imap.naver.com",
        imapPasswordCipher: "cipher",
      }),
    ).toBe("imap");
  });
});
