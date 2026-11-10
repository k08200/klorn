/**
 * C3: the CalDAV host guard. Discovery hands out other hosts than the registry's
 * base URL (iCloud partitions such as p42-caldav.icloud.com), so every URL the
 * client is about to request, the first one and every href and redirect after it,
 * is checked against the provider's own allowlist: https, no userinfo, no IP
 * literal, port 443 only, and a host the provider is known to serve.
 */

import { describe, expect, it } from "vitest";
import { CaldavGuardError } from "../pim/caldav/caldav-errors.js";
import {
  CALDAV_PROVIDERS,
  caldavAccountIdentity,
  checkCaldavUrl,
} from "../pim/caldav/caldav-providers.js";

const ICLOUD = CALDAV_PROVIDERS.ICLOUD;
const NAVER = CALDAV_PROVIDERS.NAVER;

function codeOf(fn: () => unknown): string | null {
  try {
    fn();
    return null;
  } catch (err) {
    return err instanceof CaldavGuardError ? err.code : `not a guard error: ${String(err)}`;
  }
}

describe("the registry pins each provider's base URL", () => {
  it("iCloud discovery starts at https://caldav.icloud.com", () => {
    expect(ICLOUD.baseUrl).toBe("https://caldav.icloud.com/");
  });

  it("Naver discovery starts at https://caldav.calendar.naver.com", () => {
    expect(NAVER.baseUrl).toBe("https://caldav.calendar.naver.com/");
  });

  it("every base URL passes its own guard", () => {
    for (const provider of Object.values(CALDAV_PROVIDERS)) {
      expect(checkCaldavUrl(provider.baseUrl, provider).href).toBe(provider.baseUrl);
    }
  });
});

describe("checkCaldavUrl: accepted", () => {
  it.each([
    "https://caldav.icloud.com/",
    "https://caldav.icloud.com/123456/principal/",
    "https://p01-caldav.icloud.com/123456/calendars/",
    "https://p180-caldav.icloud.com:443/123456/calendars/home/",
    "https://P42-CALDAV.icloud.com/x/",
  ])("iCloud %s", (url) => {
    expect(codeOf(() => checkCaldavUrl(url, ICLOUD))).toBeNull();
  });

  it("Naver's one host", () => {
    expect(
      codeOf(() => checkCaldavUrl("https://caldav.calendar.naver.com/principals/users/me/", NAVER)),
    ).toBeNull();
  });

  it("resolves a relative href against the URL it came from", () => {
    const url = checkCaldavUrl(
      new URL("/1/calendars/", "https://p03-caldav.icloud.com/1/"),
      ICLOUD,
    );
    expect(url.href).toBe("https://p03-caldav.icloud.com/1/calendars/");
  });
});

describe("checkCaldavUrl: refused", () => {
  it.each([
    ["not a url", "malformed"],
    ["http://caldav.icloud.com/", "scheme"],
    ["ftp://caldav.icloud.com/", "scheme"],
    ["file:///etc/passwd", "scheme"],
    ["https://user:pw@caldav.icloud.com/", "userinfo"],
    ["https://user@caldav.icloud.com/", "userinfo"],
    ["https://17.248.1.1/", "ip-literal"],
    ["https://[2620:149:a44::1]/", "ip-literal"],
    ["https://127.0.0.1/", "ip-literal"],
    ["https://0x7f000001/", "ip-literal"],
    ["https://caldav.icloud.com:8443/", "port"],
    ["https://caldav.icloud.com:80/", "port"],
    ["https://evil.example/", "host"],
    ["https://caldav.icloud.com.evil.example/", "host"],
    ["https://evilicloud.com/", "host"],
    ["https://www.icloud.com/", "host"],
    ["https://p42-caldav.icloud.com.cn/", "host"],
    ["https://px-caldav.icloud.com/", "host"],
    ["https://a.p42-caldav.icloud.com/", "host"],
    ["https://caldav.icloud.com./", "host"],
    ["https://localhost/", "host"],
    ["https://caldav.calendar.naver.com/", "host"],
  ])("iCloud %s -> %s", (url, code) => {
    expect(codeOf(() => checkCaldavUrl(url, ICLOUD))).toBe(code);
  });

  it.each([
    ["https://caldav.icloud.com/", "host"],
    ["https://calendar.naver.com/", "host"],
    ["https://x.caldav.calendar.naver.com/", "host"],
    ["https://caldav.calendar.naver.com:444/", "port"],
    ["http://caldav.calendar.naver.com/", "scheme"],
  ])("Naver %s -> %s: the providers never share hosts", (url, code) => {
    expect(codeOf(() => checkCaldavUrl(url, NAVER))).toBe(code);
  });
});

describe("caldavAccountIdentity: who logs in, and the address the account is listed under", () => {
  it("iCloud: the Apple ID is both, normalised", () => {
    expect(caldavAccountIdentity(ICLOUD, "  Me@iCloud.com ")).toEqual({
      username: "me@icloud.com",
      accountEmail: "me@icloud.com",
    });
  });

  it("iCloud: anything that is not an address is refused", () => {
    expect(caldavAccountIdentity(ICLOUD, "not-an-address")).toBeNull();
    expect(caldavAccountIdentity(ICLOUD, "")).toBeNull();
  });

  it("Naver: logs in with the Naver ID; an @naver.com address is reduced to it", () => {
    expect(caldavAccountIdentity(NAVER, "kim_01")).toEqual({
      username: "kim_01",
      accountEmail: "kim_01@naver.com",
    });
    expect(caldavAccountIdentity(NAVER, "Kim_01@Naver.com")).toEqual({
      username: "kim_01",
      accountEmail: "kim_01@naver.com",
    });
  });

  it.each([
    "kim@gmail.com",
    "../admin",
    "a b",
    "kim/../x",
    "",
    "k".repeat(40),
  ])("Naver: refuses %j (the ID can reach a URL path)", (value) => {
    expect(caldavAccountIdentity(NAVER, value)).toBeNull();
  });
});
