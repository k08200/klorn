/**
 * Klorn Teams web rules (packages/web/src/app/settings/_sections/org/model.ts):
 * when Settings offers the Team section, how an invite token is read from the
 * link's fragment, the seat count a checkout starts from, and which server
 * refusals get their own localized message.
 */

import { describe, expect, it } from "vitest";
import {
  apiErrorCode,
  CAP_OPTIONS,
  capFromOption,
  clampSeats,
  defaultSeats,
  formatUsd,
  inviteTokenFromHash,
  isInviteToken,
  isOwner,
  orgErrorKey,
  seatStatusKey,
  showTeamSection,
} from "../../../web/src/app/settings/_sections/org/model";
import en from "../../../web/src/lib/locales/en";

const TOKEN = "a".repeat(64);

describe("Team section visibility", () => {
  it("shows for saved teams (team mode) or an organization (Klorn Teams), exactly true", () => {
    expect(showTeamSection(true, undefined)).toBe(true);
    expect(showTeamSection(false, true)).toBe(true);
    expect(showTeamSection(null, true)).toBe(true);
    expect(showTeamSection(false, false)).toBe(false);
    expect(showTeamSection(null, undefined)).toBe(false);
  });

  it("treats only the OWNER role as an owner", () => {
    expect(isOwner({ role: "OWNER" })).toBe(true);
    expect(isOwner({ role: "MEMBER" })).toBe(false);
    expect(isOwner(null)).toBe(false);
  });
});

describe("invite tokens in the link fragment", () => {
  it("reads a 64-hex token from #token=", () => {
    expect(inviteTokenFromHash(`#token=${TOKEN}`)).toBe(TOKEN);
    expect(inviteTokenFromHash(`token=${TOKEN}`)).toBe(TOKEN);
  });

  it("refuses anything else", () => {
    for (const hash of ["", "#", "#token=abc", `#token=${"z".repeat(64)}`, `#t=${TOKEN}`]) {
      expect(inviteTokenFromHash(hash)).toBeNull();
    }
    expect(isInviteToken(TOKEN)).toBe(true);
    expect(isInviteToken(null)).toBe(false);
    expect(isInviteToken(`${TOKEN}0`)).toBe(false);
  });
});

describe("seats and caps", () => {
  it("starts a checkout at the member count, within 2–150", () => {
    expect(defaultSeats(1)).toBe(2);
    expect(defaultSeats(7)).toBe(7);
    expect(defaultSeats(400)).toBe(150);
    expect(clampSeats(Number.NaN)).toBe(2);
    expect(clampSeats(3.6)).toBe(4);
  });

  it("offers no cap or OFF/SHADOW/SUGGEST, and maps the empty choice to null", () => {
    expect(CAP_OPTIONS.map((option) => option.value)).toEqual(["", "SUGGEST", "SHADOW", "OFF"]);
    expect(capFromOption("")).toBeNull();
    expect(capFromOption("AUTO")).toBeNull();
    expect(capFromOption("SHADOW")).toBe("SHADOW");
  });

  it("names every subscription state, and none for an unknown one", () => {
    expect(seatStatusKey("past_due")).toBe("settings.org.seats.status.pastDue");
    expect(seatStatusKey(null)).toBe("settings.org.seats.status.none");
    expect(seatStatusKey("weird")).toBe("settings.org.seats.status.none");
  });

  it("formats whole dollars without cents", () => {
    expect(formatUsd(3000, "en-US")).toBe("$30");
    expect(formatUsd(2650, "en-US")).toBe("$26.50");
  });
});

describe("org refusals", () => {
  it("reads the code apiFetch's error carries", () => {
    const err = new Error('API 403: {"error":"x","code":"OWNER_ONLY"}');
    expect(apiErrorCode(err)).toBe("OWNER_ONLY");
    expect(apiErrorCode(new Error("API 500: <html>"))).toBeNull();
    expect(apiErrorCode("nope")).toBeNull();
  });

  it("gives a known refusal its own message and anything else the generic one", () => {
    const known = new Error('API 410: {"error":"x","code":"INVITE_EXPIRED"}');
    expect(orgErrorKey(known)).toBe("settings.org.error.INVITE_EXPIRED");
    expect(orgErrorKey(new Error('API 400: {"code":"SOMETHING_NEW"}'))).toBe(
      "settings.org.error.generic",
    );
  });

  it("has an English string for every key the pages use", () => {
    const keys = [
      ...CAP_OPTIONS.map((option) => option.key),
      ...["active", "trialing", "past_due", "paused", "canceled", null].map(seatStatusKey),
      orgErrorKey(new Error('API 410: {"code":"INVITE_USED"}')),
      orgErrorKey(new Error('API 429: {"code":"rate-limited"}')),
      "settings.org.error.generic",
    ];
    for (const key of keys) expect(en[key], key).toBeTypeOf("string");
  });
});
