/**
 * Daily digest — the safety net for everything Klorn filed away.
 *
 * The weekly signal report already exists and answers "how did triage go";
 * it goes out as a push. This answers a different and more anxious question —
 * "did Klorn hide something I needed?" — and goes out as EMAIL, because that
 * is the one channel that reaches a user with no app open and no push
 * permission granted.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const labelGroupBy = vi.hoisted(() => vi.fn());
const labelCount = vi.hoisted(() => vi.fn());
const userFindMany = vi.hoisted(() => vi.fn());
const noteCreate = vi.hoisted(() => vi.fn());
const sendDigestEmail = vi.hoisted(() => vi.fn());
const evaluateNotificationGate = vi.hoisted(() => vi.fn());
const getUserNotificationLanguage = vi.hoisted(() => vi.fn());
const listPendingScreener = vi.hoisted(() => vi.fn());
const isScreenerEnabled = vi.hoisted(() => vi.fn(() => false));

vi.mock("../db.js", () => ({
  prisma: {
    decisionLabel: { groupBy: labelGroupBy, count: labelCount },
    user: { findMany: userFindMany },
    note: { create: noteCreate },
  },
  db: {},
}));
vi.mock("../mail/email.js", () => ({ sendDigestEmail }));
vi.mock("../notify/notification-prefs.js", () => ({ evaluateNotificationGate }));
vi.mock("../notify/notification-strings.js", () => ({ getUserNotificationLanguage }));
vi.mock("../judge/screener.js", () => ({ listPendingScreener, isScreenerEnabled }));
vi.mock("../sentry.js", () => ({ captureError: vi.fn() }));

import {
  collectDigest,
  dayKeyUtc,
  formatDigest,
  isDailyDigestEnabled,
  sendDailyDigests,
} from "../pim/daily-digest.js";

const NOW = new Date("2026-08-23T09:00:00Z");

beforeEach(() => {
  vi.clearAllMocks();
  process.env.DAILY_DIGEST_ENABLED = "true";
  userFindMany.mockResolvedValue([{ id: "u1", email: "a@example.com" }]);
  labelGroupBy.mockResolvedValue([
    { sender: "noise@example.com", _count: { _all: 7 } },
    { sender: "news@example.com", _count: { _all: 3 } },
  ]);
  labelCount.mockResolvedValue(10);
  noteCreate.mockResolvedValue({ id: "note-1" });
  sendDigestEmail.mockResolvedValue(true);
  evaluateNotificationGate.mockResolvedValue({ allowed: true });
  getUserNotificationLanguage.mockResolvedValue("en");
  isScreenerEnabled.mockReturnValue(false);
  listPendingScreener.mockResolvedValue([]);
});

describe("dayKeyUtc", () => {
  it("is a stable UTC calendar date, not a local one", () => {
    expect(dayKeyUtc(new Date("2026-08-23T23:59:59Z"))).toBe("2026-08-23");
    expect(dayKeyUtc(new Date("2026-08-24T00:00:00Z"))).toBe("2026-08-24");
  });
});

describe("isDailyDigestEnabled", () => {
  it("is off unless the flag is exactly 'true'", () => {
    delete process.env.DAILY_DIGEST_ENABLED;
    expect(isDailyDigestEnabled()).toBe(false);
    process.env.DAILY_DIGEST_ENABLED = "TRUE";
    expect(isDailyDigestEnabled()).toBe(false);
    process.env.DAILY_DIGEST_ENABLED = "true";
    expect(isDailyDigestEnabled()).toBe(true);
  });
});

describe("collectDigest", () => {
  it("counts only what was filed out of the way", async () => {
    await collectDigest("u1", NOW);
    expect(labelGroupBy).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          userId: "u1",
          shownTier: { in: ["SILENT", "INFO"] },
        }),
      }),
    );
  });

  it("orders senders by volume, loudest first", async () => {
    labelGroupBy.mockResolvedValue([
      { sender: "quiet@example.com", _count: { _all: 1 } },
      { sender: "loud@example.com", _count: { _all: 9 } },
    ]);
    const stats = await collectDigest("u1", NOW);
    expect(stats.senders.map((s) => s.sender)).toEqual(["loud@example.com", "quiet@example.com"]);
  });

  it("drops rows with no sender rather than printing a blank line", async () => {
    labelGroupBy.mockResolvedValue([
      { sender: null, _count: { _all: 4 } },
      { sender: "real@example.com", _count: { _all: 1 } },
    ]);
    const stats = await collectDigest("u1", NOW);
    expect(stats.senders.map((s) => s.sender)).toEqual(["real@example.com"]);
  });

  it("reports the true filed total even when the sender list is capped", async () => {
    labelCount.mockResolvedValue(120);
    const stats = await collectDigest("u1", NOW);
    expect(stats.filed).toBe(120);
  });
});

describe("formatDigest", () => {
  it("names every sender it counted, so nothing is hidden twice", () => {
    const body = formatDigest(
      { filed: 10, senders: [{ sender: "noise@example.com", count: 7 }] },
      "en",
    );
    expect(body).toContain("noise@example.com");
    expect(body).toContain("7");
  });

  it("speaks the user's notification language", () => {
    const ko = formatDigest({ filed: 3, senders: [] }, "ko");
    const en = formatDigest({ filed: 3, senders: [] }, "en");
    expect(ko).not.toBe(en);
  });

  it("makes no claim it has not measured — no 'time saved'", () => {
    // "the last 24 hours" is the measurement WINDOW and is fine; what the
    // weekly report bans, and this inherits, is claiming a benefit we never
    // measured. Assert on the claim, not on the word.
    const body = formatDigest({ filed: 10, senders: [] }, "en").toLowerCase();
    expect(body).not.toContain("saved");
    expect(body).not.toContain("productiv");
    expect(body).toContain("24 hours");
  });
});

describe("sendDailyDigests", () => {
  it("does nothing at all when the flag is off", async () => {
    delete process.env.DAILY_DIGEST_ENABLED;
    await expect(sendDailyDigests(NOW)).resolves.toBe(0);
    expect(userFindMany).not.toHaveBeenCalled();
  });

  it("sends one email per eligible user", async () => {
    await expect(sendDailyDigests(NOW)).resolves.toBe(1);
    expect(sendDigestEmail).toHaveBeenCalledWith(
      "a@example.com",
      expect.any(String),
      expect.stringContaining("noise@example.com"),
      expect.objectContaining({ language: expect.any(String), webUrl: expect.any(String) }),
    );
  });

  it("passes the notification language through, so the opt-out footer is not always English", async () => {
    getUserNotificationLanguage.mockResolvedValue("ko");
    await sendDailyDigests(NOW);
    expect(sendDigestEmail).toHaveBeenCalledWith(
      "a@example.com",
      expect.any(String),
      expect.any(String),
      expect.objectContaining({ language: "ko" }),
    );
  });

  it("is idempotent per day — a second run the same day sends nothing", async () => {
    noteCreate.mockRejectedValue({ code: "P2002" });
    await expect(sendDailyDigests(NOW)).resolves.toBe(0);
    expect(sendDigestEmail).not.toHaveBeenCalled();
  });

  it("claims the day BEFORE sending, so a send failure cannot double-mail tomorrow's retry", async () => {
    const order: string[] = [];
    noteCreate.mockImplementation(async () => {
      order.push("note");
      return { id: "n" };
    });
    sendDigestEmail.mockImplementation(async () => {
      order.push("email");
      return true;
    });
    await sendDailyDigests(NOW);
    expect(order).toEqual(["note", "email"]);
  });

  it("skips a user who filed nothing — an empty digest is noise, not a safety net", async () => {
    labelCount.mockResolvedValue(0);
    labelGroupBy.mockResolvedValue([]);
    await expect(sendDailyDigests(NOW)).resolves.toBe(0);
    expect(sendDigestEmail).not.toHaveBeenCalled();
  });

  it("respects the digest notification preference", async () => {
    evaluateNotificationGate.mockResolvedValue({ allowed: false, reason: "user_preferences" });
    await expect(sendDailyDigests(NOW)).resolves.toBe(0);
    expect(sendDigestEmail).not.toHaveBeenCalled();
  });

  it("skips a user with no address rather than throwing", async () => {
    userFindMany.mockResolvedValue([{ id: "u1", email: null }]);
    await expect(sendDailyDigests(NOW)).resolves.toBe(0);
    expect(sendDigestEmail).not.toHaveBeenCalled();
  });

  it("one user's failure does not stop the rest of the sweep", async () => {
    userFindMany.mockResolvedValue([
      { id: "u1", email: "a@example.com" },
      { id: "u2", email: "b@example.com" },
    ]);
    sendDigestEmail.mockRejectedValueOnce(new Error("resend down"));
    await expect(sendDailyDigests(NOW)).resolves.toBe(1);
    expect(sendDigestEmail).toHaveBeenCalledTimes(2);
  });
});

describe("pending screener senders in the digest", () => {
  it("says nothing about the screener when the screener is off", async () => {
    isScreenerEnabled.mockReturnValue(false);
    await sendDailyDigests(NOW);
    expect(listPendingScreener).not.toHaveBeenCalled();
    const body = sendDigestEmail.mock.calls[0][2];
    expect(body.toLowerCase()).not.toContain("first time");
  });

  it("says nothing when the screener is on but nobody is waiting", async () => {
    isScreenerEnabled.mockReturnValue(true);
    listPendingScreener.mockResolvedValue([]);
    await sendDailyDigests(NOW);
    const body = sendDigestEmail.mock.calls[0][2];
    expect(body.toLowerCase()).not.toContain("first time");
  });

  it("names the count and links the queue when senders are waiting", async () => {
    isScreenerEnabled.mockReturnValue(true);
    listPendingScreener.mockResolvedValue([{ sender: "new@example.com" }, { sender: "b@x.com" }]);
    await sendDailyDigests(NOW);
    const body = sendDigestEmail.mock.calls[0][2];
    expect(body).toContain("2");
    expect(body).toContain("/inbox");
  });

  it("still sends the digest when the screener lookup fails", async () => {
    isScreenerEnabled.mockReturnValue(true);
    listPendingScreener.mockRejectedValue(new Error("db down"));
    await expect(sendDailyDigests(NOW)).resolves.toBe(1);
    expect(sendDigestEmail).toHaveBeenCalled();
  });

  it("does not send a digest for the screener alone — filed mail is the trigger", async () => {
    labelCount.mockResolvedValue(0);
    labelGroupBy.mockResolvedValue([]);
    isScreenerEnabled.mockReturnValue(true);
    listPendingScreener.mockResolvedValue([{ sender: "new@example.com" }]);
    await expect(sendDailyDigests(NOW)).resolves.toBe(0);
    expect(sendDigestEmail).not.toHaveBeenCalled();
  });
});
