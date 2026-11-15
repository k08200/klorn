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
  ceilingKeys,
  clampSeats,
  defaultSeats,
  formatUsd,
  inviteTokenFromHash,
  isInviteToken,
  isOwner,
  orgErrorKey,
  parseSeats,
  parseSeatsFrom,
  SEAT_MANAGEMENT_CODES,
  INVITE_TOKEN_STORAGE_KEY as STORED_TOKEN_KEY,
  seatFloor,
  seatStatusKey,
  showTeamSection,
  subscriptionActions,
  TERMINAL_INVITE_CODES,
} from "../../../web/src/app/settings/_sections/org/model";
import en from "../../../web/src/lib/locales/en";
import { SESSION_STATE_PREFIXES } from "../../../web/src/lib/logout-cleanup";

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

  it("lets a seat count be typed in full and accepts only 2–150", () => {
    expect(parseSeats("1")).toBeNull();
    expect(parseSeats("12")).toBe(12);
    expect(parseSeats(" 150 ")).toBe(150);
    for (const bad of ["151", "2.5", "", "abc", "-3", "1e2"]) expect(parseSeats(bad)).toBeNull();
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

describe("seat management after purchase", () => {
  it("never lets the seat count fall below two or the members", () => {
    expect([0, 1, 2, 5, 150, 200].map(seatFloor)).toEqual([2, 2, 2, 5, 150, 150]);
    expect(parseSeatsFrom("4", 5)).toBeNull();
    expect(parseSeatsFrom("5", 5)).toBe(5);
    expect(parseSeatsFrom("151", 5)).toBeNull();
    expect(parseSeatsFrom("abc", 2)).toBeNull();
  });

  it("offers each owner action only in the subscription states Paddle allows it", () => {
    const at = "2026-12-14T00:00:00.000Z";
    expect(subscriptionActions({ status: "active", cancelAt: null })).toEqual({
      changeSeats: true,
      cancel: true,
      resume: false,
      portal: true,
    });
    expect(subscriptionActions({ status: "trialing", cancelAt: at })).toEqual({
      changeSeats: false,
      cancel: false,
      resume: true,
      portal: true,
    });
    // Past due: Paddle refuses updates but takes a period-end cancel, and the
    // portal is where the payment method is fixed.
    expect(subscriptionActions({ status: "past_due", cancelAt: null })).toEqual({
      changeSeats: false,
      cancel: true,
      resume: false,
      portal: true,
    });
    expect(subscriptionActions({ status: "paused", cancelAt: null })).toEqual({
      changeSeats: false,
      cancel: false,
      resume: false,
      portal: true,
    });
    for (const status of ["canceled", null]) {
      expect(Object.values(subscriptionActions({ status, cancelAt: null }))).toEqual([
        false,
        false,
        false,
        false,
      ]);
    }
  });

  it("gives every seat-management refusal its own message", () => {
    expect([...SEAT_MANAGEMENT_CODES].sort()).toEqual(
      [
        "BILLING_PROVIDER_ERROR",
        "CANCEL_SCHEDULED",
        "NO_SUBSCRIPTION",
        "PORTAL_PAYER_ONLY",
        "SEATS_BELOW_MEMBERS",
        "SEATS_CHANGED",
        "SEATS_INCREASE_PAYER_ONLY",
        "SEAT_CHANGE_UNSUPPORTED",
        "SUBSCRIPTION_NOT_ACTIVE",
        "SUBSCRIPTION_PAUSED",
        "TEAM_BILLING_UNAVAILABLE",
      ].sort(),
    );
    for (const code of SEAT_MANAGEMENT_CODES) {
      const key = orgErrorKey(new Error(`API 409: {"code":"${code}"}`));
      expect(key).toBe(`settings.org.error.${code}`);
      expect(en[key], key).toBeTypeOf("string");
    }
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

  it("forgets an invite link only after a refusal it can never recover from", () => {
    expect([...TERMINAL_INVITE_CODES].sort()).toEqual([
      "ALREADY_IN_ORG",
      "INVITE_EXPIRED",
      "INVITE_INVALID",
      "INVITE_USED",
    ]);
    expect(TERMINAL_INVITE_CODES.has("INVITE_EMAIL_MISMATCH")).toBe(false);
    expect(TERMINAL_INVITE_CODES.has("EMAIL_NOT_VERIFIED")).toBe(false);
  });

  it("has an English string for every key the pages use", () => {
    const keys = [
      ...CAP_OPTIONS.map((option) => option.key),
      ...["active", "trialing", "past_due", "paused", "canceled", null].map(seatStatusKey),
      orgErrorKey(new Error('API 410: {"code":"INVITE_USED"}')),
      orgErrorKey(new Error('API 429: {"code":"rate-limited"}')),
      orgErrorKey(new Error('API 403: {"code":"OWNER_ONLY"}')),
      "settings.org.loadFailed",
      "settings.org.retry",
      "settings.org.error.generic",
      "settings.org.seats.change",
      "settings.org.seats.changeAction",
      "settings.org.seats.floor",
      "settings.org.seats.payerOnly",
      "settings.org.seats.pending",
      "settings.org.seats.unchanged",
      "settings.org.subscription.cancel",
      "settings.org.subscription.cancelTitle",
      "settings.org.subscription.cancelMessageNoDate",
      "settings.org.subscription.cancelConfirm",
      "settings.org.subscription.keep",
      "settings.org.subscription.endsOn",
      "settings.org.subscription.endsSoon",
      "settings.org.subscription.portal",
      "settings.org.transparency.domains",
      "settings.org.transparency.domainsLine",
    ];
    for (const key of keys) expect(en[key], key).toBeTypeOf("string");
  });
});

describe("invite token lifetime", () => {
  it("is cleared at sign-out with the other per-tab session state", () => {
    expect(SESSION_STATE_PREFIXES.some((prefix) => STORED_TOKEN_KEY.startsWith(prefix))).toBe(true);
  });
});

describe("ceilings in the transparency view", () => {
  it("names each ceiling that applies to the member, and none when there is none", () => {
    expect(ceilingKeys({ autoReplyDisabled: false, agentModeCap: null })).toEqual([]);
    expect(ceilingKeys({ autoReplyDisabled: true, agentModeCap: "SHADOW" })).toEqual([
      "settings.org.transparency.ceiling.autoReplyOff",
      "settings.org.transparency.ceiling.cap.shadow",
    ]);
    for (const cap of ["OFF", "SHADOW", "SUGGEST"] as const) {
      const [key] = ceilingKeys({ autoReplyDisabled: false, agentModeCap: cap });
      expect(en[key ?? ""], cap).toBeTypeOf("string");
    }
    expect(en["settings.org.transparency.ceiling.autoReplyOff"]).toBeTypeOf("string");
    expect(en["settings.org.transparency.ceilings"]).toBeTypeOf("string");
  });
});
