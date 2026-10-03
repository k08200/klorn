// Pins two pure pieces of the settings split (productization plan P3). The web
// package has no unit-test runner, so they are exercised from here — same
// arrangement as web-tool-labels.test.ts.
import { describe, expect, it } from "vitest";
import {
  mergeStoredProfile,
  profileSavePlan,
  type UserProfile,
} from "../../../web/src/app/settings/_sections/profile-save-plan";
import { legacyAnchorSection } from "../../../web/src/app/settings/sections";

const PROFILE: UserProfile = { name: "Ada", language: "ko", timezone: "Asia/Seoul" };

describe("profileSavePlan", () => {
  it("identity form writes only the display name", () => {
    expect(profileSavePlan("identity", PROFILE)).toEqual({ name: "Ada", locale: null });
  });

  it("locale form writes only language and timezone, never the name", () => {
    expect(profileSavePlan("locale", PROFILE)).toEqual({
      name: null,
      locale: { language: "ko", timezone: "Asia/Seoul" },
    });
  });

  it("identity form still saves an emptied name rather than skipping the write", () => {
    expect(profileSavePlan("identity", { ...PROFILE, name: "" }).name).toBe("");
  });
});

describe("mergeStoredProfile", () => {
  const locale = { language: "ko" as const, timezone: "Asia/Seoul" };

  it("replaces language and timezone and keeps every other stored field", () => {
    const stored = JSON.stringify({ name: "Old", language: "en", timezone: "UTC", extra: 1 });
    expect(JSON.parse(mergeStoredProfile(stored, locale))).toEqual({
      name: "Old",
      language: "ko",
      timezone: "Asia/Seoul",
      extra: 1,
    });
  });

  it("starts from an empty object when nothing usable is stored", () => {
    for (const stored of [null, "", "not json", "[1]", '"text"', "null"]) {
      expect(JSON.parse(mergeStoredProfile(stored, locale))).toEqual(locale);
    }
  });
});

describe("legacyAnchorSection", () => {
  it("maps pre-split element ids and section ids to their section", () => {
    expect(legacyAnchorSection("reply-tone")).toBe("assistant");
    expect(legacyAnchorSection("briefing-time")).toBe("notifications");
    expect(legacyAnchorSection("profile-tz")).toBe("appearance");
    expect(legacyAnchorSection("current-pw")).toBe("account-billing");
    expect(legacyAnchorSection("data")).toBe("data");
  });

  it("returns null for unknown anchors and for Object.prototype member names", () => {
    for (const anchor of ["", "nope", "constructor", "toString", "__proto__", "hasOwnProperty"]) {
      expect(legacyAnchorSection(anchor)).toBeNull();
    }
  });
});
