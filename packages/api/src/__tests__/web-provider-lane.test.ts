// The sign-in page's provider lane, and the stale Google-review notice.
// Run from the api suite because the web package has no unit-test runner
// (see web-auth-surfaces.test.ts).
import { describe, expect, it } from "vitest";
import de from "../../../web/src/lib/locales/de";
import en from "../../../web/src/lib/locales/en";
import es from "../../../web/src/lib/locales/es";
import fr from "../../../web/src/lib/locales/fr";
import ja from "../../../web/src/lib/locales/ja";
import ko from "../../../web/src/lib/locales/ko";
import zh from "../../../web/src/lib/locales/zh";
import { providerLane } from "../../../web/src/lib/provider-lane";

const CACHED = { providers: [{ id: "google" }, { id: "apple" }, { id: "naver" }] } as never;

describe("providerLane", () => {
  it("renders the server's empty, closed lane until mount, even with a cached list", () => {
    // The server has no localStorage; the hydrating client must match it.
    expect(providerLane(null, CACHED)).toEqual({ extras: [], resolved: false });
    expect(providerLane(null, undefined)).toEqual({ extras: [], resolved: false });
  });

  it("after mount in a browser, the cached or fetched list opens the lane", () => {
    expect(providerLane(false, CACHED)).toEqual({ extras: ["apple", "naver"], resolved: true });
    expect(providerLane(false, { providers: [] } as never)).toEqual({ extras: [], resolved: true });
    expect(providerLane(false, undefined)).toEqual({ extras: [], resolved: false });
  });

  it("never shows Apple or Naver in the native shell", () => {
    expect(providerLane(true, CACHED)).toEqual({ extras: [], resolved: false });
  });

  it("drops ids it does not know, in server order", () => {
    const data = { providers: [{ id: "naver" }, { id: "github" }, { id: "apple" }] } as never;
    expect(providerLane(false, data).extras).toEqual(["naver", "apple"]);
  });
});

describe("invite-only notice", () => {
  // Google approved Klorn's OAuth verification on 2026-10-03; the cap is a
  // beta decision now, not a review the user is waiting on.
  const REVIEW =
    /Google|security review|보안 심사|セキュリティ審査|安全审核|revisión de seguridad|revue de sécurité|Sicherheitsprüfung/i;
  it.each(
    Object.entries({ en, ko, ja, zh, es, fr, de }),
  )("%s no longer blames a pending Google review", (_locale, dict) => {
    const body = (dict as Record<string, string>)["auth.inviteOnlyBody"];
    expect(body).toBeTruthy();
    expect(body).not.toMatch(REVIEW);
  });
});
