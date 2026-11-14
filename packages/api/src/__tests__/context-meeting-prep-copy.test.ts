/**
 * Meeting prep text (server side, for the evening review): a deterministic
 * template in each notification language, one line per item, and every line
 * keeps the source it was rendered from. A suggestion is labelled as one.
 */

import type { MeetingPrep, MeetingPrepItem } from "@klorn/contract";
import { describe, expect, it } from "vitest";
import { prepCopy, renderPrepHeader, renderPrepLines } from "../context/meeting-prep-copy.js";
import { NOTIFICATION_LANGUAGES } from "../notify/notification-strings.js";

const TZ = "Asia/Seoul";

const items: MeetingPrepItem[] = [
  {
    kind: "commitment",
    owner: "USER",
    title: "Send the quote",
    dueAt: "2099-03-06T09:00:00.000Z",
    confirmed: true,
    counterpartyName: "Alice",
    match: "address",
    source: { kind: "commitment", commitmentId: "c-1" },
  },
  {
    kind: "commitment",
    owner: "COUNTERPARTY",
    title: "Signed NDA",
    dueAt: null,
    confirmed: false,
    counterpartyName: null,
    match: "domain",
    source: { kind: "commitment", commitmentId: "c-2" },
  },
  {
    kind: "unanswered",
    from: "Alice",
    subject: "Quote request",
    receivedAt: "2099-03-01T01:00:00.000Z",
    match: "address",
    source: { kind: "email", emailId: "m-1" },
  },
  {
    kind: "thread",
    from: "Bob",
    subject: "",
    receivedAt: "2099-02-28T01:00:00.000Z",
    match: "domain",
    source: { kind: "email", emailId: "m-2" },
  },
];

const meeting: MeetingPrep = {
  eventId: "ev-1",
  title: "Acme sync",
  startTime: "2099-03-03T01:00:00.000Z",
  endTime: "2099-03-03T02:00:00.000Z",
  attendees: ["alice@acme.com"],
  items,
};

describe("renderPrepLines", () => {
  it.each(NOTIFICATION_LANGUAGES)("%s: one sourced, non-empty line per item", (lang) => {
    const lines = renderPrepLines(items, lang, TZ);
    expect(lines.map((l) => l.source)).toEqual(items.map((i) => i.source));
    for (const line of lines) expect(line.text.trim().length).toBeGreaterThan(0);
  });

  it.each(
    NOTIFICATION_LANGUAGES,
  )("%s: labels the unconfirmed commitment as a suggestion", (lang) => {
    const lines = renderPrepLines(items, lang, TZ);
    const marker = prepCopy(lang).suggestion("").trim();
    expect(lines[1]?.text).toContain(marker);
    expect(lines[0]?.text).not.toContain(marker);
  });

  it("names the deadline and the subject; an empty subject reads as no subject", () => {
    const lines = renderPrepLines(items, "en", TZ);
    expect(lines[0]?.text).toBe("You promised: Send the quote (by Fri, Mar 6)");
    expect(lines[1]?.text).toBe("Suggestion: They owe you: Signed NDA");
    expect(lines[2]?.text).toBe("Unanswered: Alice — Quote request");
    expect(lines[3]?.text).toBe("Recent: Bob — (no subject)");
  });

  it("falls back to English for an unknown language", () => {
    expect(renderPrepLines(items, "xx" as never, TZ)[2]?.text).toBe(
      "Unanswered: Alice — Quote request",
    );
  });
});

describe("renderPrepHeader", () => {
  it("states the local start time and the title", () => {
    expect(renderPrepHeader(meeting, "en", TZ)).toBe("Before 10:00 AM Acme sync");
    expect(renderPrepHeader(meeting, "ko", TZ)).toContain("Acme sync");
  });
});
