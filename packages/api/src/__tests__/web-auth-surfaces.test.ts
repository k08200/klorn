// Pins the sign-in surfaces' vocabulary and the iOS install hint's gating.
// Run from the api suite because the web package has no unit-test runner
// (see web-tool-labels.test.ts).
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { IOS_INSTALL_SNOOZE_MS, shouldOfferIosInstall } from "../../../web/src/lib/ios-install";
import de from "../../../web/src/lib/locales/de";
import en from "../../../web/src/lib/locales/en";
import es from "../../../web/src/lib/locales/es";
import fr from "../../../web/src/lib/locales/fr";
import ja from "../../../web/src/lib/locales/ja";
import ko from "../../../web/src/lib/locales/ko";
import zh from "../../../web/src/lib/locales/zh";

const LOCALES = { en, ko, ja, zh, de, fr, es } as const;

const IPHONE_SAFARI =
  "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1";
const IPHONE_CHROME =
  "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) CriOS/129.0 Mobile/15E148 Safari/604.1";
const IPHONE_KAKAO = `${IPHONE_SAFARI} KAKAOTALK 10.8.0`;
const ANDROID_CHROME =
  "Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0 Mobile Safari/537.36";
const MAC_SAFARI =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Safari/605.1.15";

const NOW = Date.UTC(2026, 9, 14);
const base = {
  userAgent: IPHONE_SAFARI,
  standalone: false,
  native: false,
  dismissedAt: 0,
  now: NOW,
};

describe("shouldOfferIosInstall", () => {
  it("offers the hint in iPhone Safari running in the browser", () => {
    expect(shouldOfferIosInstall(base)).toBe(true);
  });

  it("never offers it when the app is already installed (standalone)", () => {
    expect(shouldOfferIosInstall({ ...base, standalone: true })).toBe(false);
  });

  it("never offers it inside a native shell (Capacitor / desktop wrapper)", () => {
    expect(shouldOfferIosInstall({ ...base, native: true })).toBe(false);
  });

  it.each([
    ["Chrome on iOS", IPHONE_CHROME],
    ["an in-app browser", IPHONE_KAKAO],
    ["Android", ANDROID_CHROME],
    ["desktop Safari", MAC_SAFARI],
  ])("never offers it in %s, which cannot add to the Home Screen", (_name, userAgent) => {
    expect(shouldOfferIosInstall({ ...base, userAgent })).toBe(false);
  });

  it("stays quiet for a week after a dismissal, then may ask again", () => {
    expect(shouldOfferIosInstall({ ...base, dismissedAt: NOW - 60_000 })).toBe(false);
    expect(shouldOfferIosInstall({ ...base, dismissedAt: NOW - IOS_INSTALL_SNOOZE_MS - 1 })).toBe(
      true,
    );
  });
});

/** Keys rendered by /login, /reset-password, /verify-email and the install prompts. */
function authSurfaceEntries(table: Record<string, string>): Array<[string, string]> {
  return Object.entries(table).filter(([key]) =>
    /^(auth|resetPassword|verifyEmail|pwa)\./.test(key),
  );
}

describe("sign-in surface vocabulary", () => {
  it.each(
    Object.entries(LOCALES),
  )("%s: no auth-flow string uses the retired 'decision queue' name", (_code, table) => {
    // Each locale's own word for the retired surface, so the check holds in
    // every language rather than only in English.
    const retired = table["nav.decisionQueue"].toLowerCase();
    const offenders = authSurfaceEntries(table)
      .filter(([, value]) => value.toLowerCase().includes(retired))
      .map(([key]) => key);
    expect(offenders).toEqual([]);
  });

  it.each(
    Object.entries(LOCALES),
  )("%s: carries every sign-in and install string", (_code, table) => {
    const required = [
      "auth.headline",
      "auth.headlineAccent",
      "auth.subline",
      "auth.formTitleLogin",
      "auth.formTitleRegister",
      "auth.trustLine",
      "auth.preview.caption",
      "pwa.ios.title",
      "pwa.ios.body",
      "pwa.ios.dismiss",
      "pwa.offline",
      "pwa.install.title",
    ];
    for (const key of required) expect(table[key], key).toBeTruthy();
  });

  it("the trust line states only what klorn.ai/security states", () => {
    expect(en["auth.trustLine"]).toContain("CASA Tier 2");
    expect(en["auth.trustLine"]).toMatch(/Oct(ober)? 2026/);
  });

  it("the login page no longer renders the decision-queue keys", () => {
    const src = readFileSync(join(__dirname, "../../../web/src/app/login/page.tsx"), "utf8");
    expect(src).not.toMatch(/openDecisionQueue|nav\.decisionQueue/);
  });

  it("the install prompts render no hard-coded English", () => {
    const dir = join(__dirname, "../../../web/src/components");
    for (const file of ["pwa-prompts.tsx", "ios-install-hint.tsx"]) {
      const src = readFileSync(join(dir, file), "utf8");
      expect(src, file).not.toMatch(
        /Add to Home Screen|morning briefing|You are offline|Install Klorn/,
      );
    }
  });
});
