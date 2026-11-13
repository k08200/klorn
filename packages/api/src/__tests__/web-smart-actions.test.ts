/**
 * Web smart actions — the pure model in
 * packages/web/src/components/smart-actions/model.ts:
 *   - hidden unless the server says `user.smartActions` (flag off = invisible);
 *   - Send hashes exactly the { to, subject, body } on screen, byte-identical to
 *     the API's sendEmailPayloadHash, so the server can refuse anything else;
 *   - the calendar card cannot save until the date and time are answered — an
 *     ambiguous hour leaves the time empty until the user picks AM or PM;
 *   - a duplicate is added only after the user saw it ("Add anyway").
 * And the copy: the approved approval sentence, verbatim, in every locale's
 * smartActions table — never "auto-send", "signed receipts" or "always asks".
 */

import type { SmartEventProposalWire } from "@klorn/contract";
import { describe, expect, it } from "vitest";
import {
  apiErrorStatus,
  canSaveEvent,
  duplicateFromError,
  eventSaveRequest,
  initialEventChoice,
  replySendRequest,
  sendPayloadHash,
  smartActionPath,
  smartActionsVisible,
  twelveHourLabel,
  withDateTime,
} from "../../../web/src/components/smart-actions/model";
import de from "../../../web/src/lib/locales/de";
import en from "../../../web/src/lib/locales/en";
import es from "../../../web/src/lib/locales/es";
import fr from "../../../web/src/lib/locales/fr";
import ja from "../../../web/src/lib/locales/ja";
import ko from "../../../web/src/lib/locales/ko";
import zh from "../../../web/src/lib/locales/zh";
import { sendEmailPayloadHash } from "../judge/attention-floor.js";

const PROPOSAL: SmartEventProposalWire = {
  title: "Office meeting",
  date: "2026-11-13",
  time: null,
  durationMinutes: 30,
  location: "The office",
  timeZone: "Asia/Seoul",
  quote: "Can we meet 내일 3시 at the office?",
  question: { kind: "meridiem", am: "03:00", pm: "15:00" },
  existing: [],
};

describe("smartActionsVisible", () => {
  it("shows only when the server opened smart actions to this user", () => {
    expect(smartActionsVisible({ smartActions: true }, "e1")).toBe(true);
    expect(smartActionsVisible({ smartActions: false }, "e1")).toBe(false);
    expect(smartActionsVisible({}, "e1")).toBe(false);
    expect(smartActionsVisible(null, "e1")).toBe(false);
  });

  it("never offers them on a demo mail or without a mail", () => {
    expect(smartActionsVisible({ smartActions: true }, "demo-1")).toBe(false);
    expect(smartActionsVisible({ smartActions: true }, "")).toBe(false);
    expect(smartActionsVisible({ smartActions: true }, undefined)).toBe(false);
  });
});

describe("smartActionPath", () => {
  it("encodes the mail id into the smart-actions route", () => {
    expect(smartActionPath("a/b", "reply")).toBe("/api/smart-actions/emails/a%2Fb/reply");
  });
});

describe("the Send payload hash", () => {
  it.each([
    { to: "boss@corp.com", subject: "Re: Q4", body: "Sounds good." },
    { to: " Boss@Corp.COM ", subject: "Re: 회의", body: "네, 내일 뵙겠습니다.\n\n— Y" },
    { to: "a@b.c", subject: "Re: café", body: 'café ✓ "quotes" \\ </script>' },
  ])("matches the API's sendEmailPayloadHash for %j", (payload) => {
    expect(sendPayloadHash(payload)).toBe(sendEmailPayloadHash(payload));
  });

  it("binds the edited body the user is looking at", () => {
    const draft = { to: "boss@corp.com", subject: "Re: Q4", body: "AI draft" };
    const request = replySendRequest(draft, "My edited text");
    expect(request).toEqual({
      body: "My edited text",
      payloadHash: sendEmailPayloadHash({ ...draft, body: "My edited text" }),
    });
  });
});

describe("apiErrorStatus", () => {
  it("reads the status apiFetch throws", () => {
    expect(apiErrorStatus(new Error('API 409: {"error":"x"}'))).toBe(409);
    expect(apiErrorStatus(new Error("network"))).toBeNull();
    expect(apiErrorStatus("API 500: x")).toBeNull();
  });
});

describe("duplicateFromError", () => {
  it("reads the overlapping events of a 409 and nothing else", () => {
    const existing = [{ id: "ev-0", title: "Sync", startTime: "a", endTime: "b" }];
    expect(
      duplicateFromError(new Error(`API 409: ${JSON.stringify({ error: "x", existing })}`)),
    ).toEqual(existing);
    expect(duplicateFromError(new Error('API 409: {"error":"refused"}'))).toBeNull();
    expect(duplicateFromError(new Error("API 409: not json"))).toBeNull();
    expect(duplicateFromError(new Error(`API 500: ${JSON.stringify({ existing })}`))).toBeNull();
  });
});

describe("the calendar confirm card", () => {
  it("cannot save while the AM/PM question is open", () => {
    const choice = initialEventChoice(PROPOSAL);
    expect(choice.time).toBe("");
    expect(canSaveEvent(choice)).toBe(false);
    // Picking the PM option fills the time; then Save opens.
    expect(canSaveEvent(withDateTime(choice, { time: "15:00" }))).toBe(true);
  });

  it("cannot save a length the API would refuse", () => {
    const ready = initialEventChoice({ ...PROPOSAL, time: "15:00", question: null });
    expect(canSaveEvent({ ...ready, durationMinutes: 0 })).toBe(false);
    expect(canSaveEvent({ ...ready, durationMinutes: 3 })).toBe(false);
    expect(canSaveEvent({ ...ready, durationMinutes: 1441 })).toBe(false);
    expect(canSaveEvent({ ...ready, durationMinutes: 7.5 })).toBe(false);
    expect(canSaveEvent({ ...ready, durationMinutes: 1440 })).toBe(true);
  });

  it("cannot save without a day, a real time, or a title", () => {
    const ready = initialEventChoice({ ...PROPOSAL, time: "15:00", question: null });
    expect(canSaveEvent(ready)).toBe(true);
    expect(canSaveEvent({ ...ready, date: "" })).toBe(false);
    expect(canSaveEvent({ ...ready, time: "3pm" })).toBe(false);
    expect(canSaveEvent({ ...ready, title: "   " })).toBe(false);
  });

  it("starts from the proposal and sends only what the user confirmed", () => {
    const ready = withDateTime(initialEventChoice(PROPOSAL), { time: "15:00" });
    expect(eventSaveRequest({ ...ready, title: " Office meeting ", reminderMinutes: 30 })).toEqual({
      title: "Office meeting",
      date: "2026-11-13",
      time: "15:00",
      durationMinutes: 30,
      location: "The office",
      reminderMinutes: 30,
    });
  });

  it("adds a duplicate only after the user saw it", () => {
    const existing = [
      {
        id: "ev-0",
        title: "Sync",
        startTime: "2026-11-13T06:00:00Z",
        endTime: "2026-11-13T07:00:00Z",
      },
    ];
    const choice = initialEventChoice({ ...PROPOSAL, time: "15:00", question: null, existing });
    expect(eventSaveRequest(choice).allowDuplicate).toBe(true);
    // Moving the time drops the warning: the server checks the new slot again.
    const moved = withDateTime(choice, { time: "17:00" });
    expect(moved.existing).toEqual([]);
    expect(eventSaveRequest(moved).allowDuplicate).toBeUndefined();
  });

  it("labels an AM/PM option on a 12-hour clock", () => {
    expect(twelveHourLabel("03:00")).toBe("3:00");
    expect(twelveHourLabel("15:30")).toBe("3:30");
    expect(twelveHourLabel("00:00")).toBe("12:00");
    expect(twelveHourLabel("12:00")).toBe("12:00");
  });
});

describe("smart actions copy", () => {
  const LOCALES = { en, ko, ja, zh, es, fr, de };
  const APPROVED =
    "Nothing goes out without your say-so — sends, permanent deletes and forwards wait for your approval, or for an auto-reply rule you set up yourself.";
  const FORBIDDEN = /auto-?send|signed receipt|always asks|always waits|never sends/i;

  it("uses the approved approval sentence verbatim in English", () => {
    expect(en["smartActions.reply.approval"]).toBe(APPROVED);
  });

  it.each(Object.entries(LOCALES))("%s has every key and no forbidden claim", (_name, table) => {
    const keys = Object.keys(en).filter((key) => key.startsWith("smartActions."));
    expect(keys.length).toBeGreaterThan(10);
    for (const key of keys) {
      const value = (table as Record<string, string>)[key];
      expect(value, key).toBeTruthy();
      expect(value, key).not.toMatch(FORBIDDEN);
    }
  });
});
