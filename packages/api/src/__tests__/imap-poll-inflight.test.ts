/**
 * The in-flight poll guard also says when an account looks stuck: the skip of a
 * still-running poll is warned about (at most once per interval per account) and
 * reported once per account per process after it has run longer than a threshold.
 * State is only ever held for polls that are running.
 */

import { beforeEach, describe, expect, it } from "vitest";
import {
  beginPoll,
  endPoll,
  inFlightPollCount,
  isPollInFlight,
  MAX_TRACKED_STUCK_REPORTS,
  noteSkippedPoll,
  resetPollInFlightState,
  STUCK_POLL_REPORT_AFTER_MS,
  STUCK_POLL_WARN_INTERVAL_MS,
} from "../mail/imap-poll-inflight.js";

const T0 = 1_000_000;

describe("in-flight poll guard", () => {
  beforeEach(() => resetPollInFlightState());

  it("knows which polls are running", () => {
    expect(isPollInFlight("a")).toBe(false);
    beginPoll("a", T0);
    expect(isPollInFlight("a")).toBe(true);
    expect(isPollInFlight("b")).toBe(false);
    endPoll("a");
    expect(isPollInFlight("a")).toBe(false);
  });

  it("has nothing to say about an account whose poll is not running", () => {
    expect(noteSkippedPoll("a", T0)).toBeNull();
  });

  it("names the thresholds: warn every 30 min, report after 15 min", () => {
    expect(STUCK_POLL_WARN_INTERVAL_MS).toBe(30 * 60_000);
    expect(STUCK_POLL_REPORT_AFTER_MS).toBe(15 * 60_000);
  });
});

describe("warning about a skipped poll is rate-limited per account", () => {
  beforeEach(() => resetPollInFlightState());

  it("warns on the first skip and then at most once per interval", () => {
    beginPoll("a", T0);
    expect(noteSkippedPoll("a", T0 + 1_000)?.warn).toBe(true);
    expect(noteSkippedPoll("a", T0 + 2_000)?.warn).toBe(false);
    expect(noteSkippedPoll("a", T0 + 5 * 60_000)?.warn).toBe(false);
    expect(noteSkippedPoll("a", T0 + 1_000 + STUCK_POLL_WARN_INTERVAL_MS - 1)?.warn).toBe(false);
  });

  it("warns again once the interval has passed since the last warning", () => {
    beginPoll("a", T0);
    noteSkippedPoll("a", T0 + 1_000);
    expect(noteSkippedPoll("a", T0 + 1_000 + STUCK_POLL_WARN_INTERVAL_MS)?.warn).toBe(true);
    expect(noteSkippedPoll("a", T0 + 1_000 + STUCK_POLL_WARN_INTERVAL_MS + 1)?.warn).toBe(false);
  });

  it("rate-limits each account on its own", () => {
    beginPoll("a", T0);
    beginPoll("b", T0);
    expect(noteSkippedPoll("a", T0 + 1_000)?.warn).toBe(true);
    expect(noteSkippedPoll("b", T0 + 1_000)?.warn).toBe(true);
    expect(noteSkippedPoll("a", T0 + 2_000)?.warn).toBe(false);
  });

  it("starts over for a new poll of the same account", () => {
    beginPoll("a", T0);
    noteSkippedPoll("a", T0 + 1_000);
    endPoll("a");
    beginPoll("a", T0 + 10_000);
    expect(noteSkippedPoll("a", T0 + 11_000)?.warn).toBe(true);
  });

  it("says how long the poll has been running", () => {
    beginPoll("a", T0);
    expect(noteSkippedPoll("a", T0 + 42_000)?.ageMs).toBe(42_000);
  });
});

describe("reporting a stuck poll happens once, and only past the threshold", () => {
  beforeEach(() => resetPollInFlightState());

  it("does not report a normal overlap shorter than the threshold", () => {
    beginPoll("a", T0);
    expect(noteSkippedPoll("a", T0 + 1_000)?.report).toBe(false);
    expect(noteSkippedPoll("a", T0 + STUCK_POLL_REPORT_AFTER_MS - 1)?.report).toBe(false);
  });

  it("reports at the threshold, and only that once", () => {
    beginPoll("a", T0);
    expect(noteSkippedPoll("a", T0 + STUCK_POLL_REPORT_AFTER_MS)?.report).toBe(true);
    expect(noteSkippedPoll("a", T0 + STUCK_POLL_REPORT_AFTER_MS + 1_000)?.report).toBe(false);
    expect(noteSkippedPoll("a", T0 + 10 * STUCK_POLL_REPORT_AFTER_MS)?.report).toBe(false);
  });

  it("reports each account once, not once overall", () => {
    beginPoll("a", T0);
    beginPoll("b", T0);
    expect(noteSkippedPoll("a", T0 + STUCK_POLL_REPORT_AFTER_MS)?.report).toBe(true);
    expect(noteSkippedPoll("b", T0 + STUCK_POLL_REPORT_AFTER_MS)?.report).toBe(true);
  });

  it("is once per process: a later poll of the same account does not report again", () => {
    beginPoll("a", T0);
    expect(noteSkippedPoll("a", T0 + STUCK_POLL_REPORT_AFTER_MS)?.report).toBe(true);
    endPoll("a");
    beginPoll("a", T0 + 100 * 60_000);
    expect(noteSkippedPoll("a", T0 + 100 * 60_000 + STUCK_POLL_REPORT_AFTER_MS)?.report).toBe(
      false,
    );
  });

  it("measures the threshold from the start of the poll, not from the first skip", () => {
    beginPoll("a", T0);
    // the first skip only happens late: the poll has already run longer than the threshold
    expect(noteSkippedPoll("a", T0 + STUCK_POLL_REPORT_AFTER_MS + 5_000)?.report).toBe(true);
  });
});

describe("memory held for stuck polls is bounded and released", () => {
  beforeEach(() => resetPollInFlightState());

  it("holds a poll only while it runs", () => {
    beginPoll("a", T0);
    beginPoll("b", T0);
    noteSkippedPoll("a", T0 + 1_000);
    expect(inFlightPollCount()).toBe(2);
    endPoll("a");
    endPoll("b");
    expect(inFlightPollCount()).toBe(0);
  });

  it("ending a poll that is not running is harmless", () => {
    endPoll("never-started");
    expect(inFlightPollCount()).toBe(0);
  });

  it("remembers at most MAX_TRACKED_STUCK_REPORTS reported accounts; the oldest is forgotten", () => {
    const over = MAX_TRACKED_STUCK_REPORTS + 5;
    for (let i = 0; i < over; i++) {
      beginPoll(`row-${i}`, T0);
      noteSkippedPoll(`row-${i}`, T0 + STUCK_POLL_REPORT_AFTER_MS);
      endPoll(`row-${i}`);
    }
    // the oldest was forgotten: it reports again (errs towards visibility)
    beginPoll("row-0", T0);
    expect(noteSkippedPoll("row-0", T0 + STUCK_POLL_REPORT_AFTER_MS)?.report).toBe(true);
    endPoll("row-0");
    // the newest is still remembered
    beginPoll(`row-${over - 1}`, T0);
    expect(noteSkippedPoll(`row-${over - 1}`, T0 + STUCK_POLL_REPORT_AFTER_MS)?.report).toBe(false);
  });
});
