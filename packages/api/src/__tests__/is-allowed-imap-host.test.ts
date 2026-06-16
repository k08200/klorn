import { describe, expect, it } from "vitest";
import { isAllowedImapHost } from "../is-allowed-imap-host.js";

describe("isAllowedImapHost — SSRF allowlist", () => {
  it("allows the Naver IMAP host with and without the IMAPS port", () => {
    expect(isAllowedImapHost("imap.naver.com:993")).toBe(true);
    expect(isAllowedImapHost("imap.naver.com")).toBe(true);
    expect(isAllowedImapHost("  IMAP.NAVER.COM:993  ")).toBe(true);
  });

  it("rejects internal / metadata / loopback targets (the SSRF cases)", () => {
    expect(isAllowedImapHost("169.254.169.254:993")).toBe(false);
    expect(isAllowedImapHost("localhost:993")).toBe(false);
    expect(isAllowedImapHost("127.0.0.1:993")).toBe(false);
    expect(isAllowedImapHost("internal-redis:6379")).toBe(false);
    expect(isAllowedImapHost("[::1]:993")).toBe(false);
  });

  it("rejects non-IMAPS ports even on an allowed host", () => {
    expect(isAllowedImapHost("imap.naver.com:6379")).toBe(false);
    expect(isAllowedImapHost("imap.naver.com:80")).toBe(false);
  });

  it("rejects look-alike domains that merely contain the allowed suffix", () => {
    expect(isAllowedImapHost("imap.naver.com.attacker.com:993")).toBe(false);
    expect(isAllowedImapHost("fakenaver.com:993")).toBe(false);
    expect(isAllowedImapHost("naver.com.evil.com:993")).toBe(false);
  });

  it("rejects empty / malformed input", () => {
    expect(isAllowedImapHost("")).toBe(false);
    expect(isAllowedImapHost("   ")).toBe(false);
    expect(isAllowedImapHost(":993")).toBe(false);
  });
});
