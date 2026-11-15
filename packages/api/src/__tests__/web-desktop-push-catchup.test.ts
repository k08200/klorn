/**
 * Windows desktop shell (apps/desktop-win, Tauri) — catching up urgent mail
 * missed while it was closed or asleep (decision N6, LOCKED 2026-11-08). The
 * pure rules in packages/web/src/lib/native/desktop-push-catchup.ts:
 *   - exactly one missed mail → that mail's normal N1 toast, opening the mail;
 *   - two or more → ONE summary "N urgent emails while Klorn was closed",
 *     body "Sender1, Sender2, Sender3 +k", opening Today;
 *   - only PUSH mail from the last 72h, still open (the server decides), never
 *     twice (the ledger shared with live frames);
 *   - quiet hours (`held`): nothing shown, nothing recorded — a later pass
 *     shows it.
 */

import type { DesktopCatchUpResponse, DesktopMissedMail } from "@klorn/contract";
import { describe, expect, it, vi } from "vitest";

vi.mock("../db.js", () => ({ prisma: {} }));

import {
  type AlertLedger,
  freshLedger,
  planLiveAlert,
  SETTLE_MS,
} from "../../../web/src/lib/native/desktop-catchup";
import {
  ASK_MAX,
  formatSenders,
  PUSH_CATCHUP_WINDOW_MS,
  type PushCatchUpInput,
  parseCatchUpResponse,
  planPushCatchUp,
  pushCatchUpCandidates,
  summarizeMissed,
} from "../../../web/src/lib/native/desktop-push-catchup";
import { firewallBellRow } from "../judge/firewall-push.js";
import { notificationCopy } from "../notify/notification-strings.js";

const NOW = Date.parse("2026-11-08T12:00:00.000Z");
const MIN = 60_000;
const HOUR = 60 * MIN;
const SUMMARY = notificationCopy("en").missedWhileClosed("{count}");
const HELD_SUMMARY = notificationCopy("en").heldDuringQuietHours("{count}");

/** A PUSH bell row as GET /api/notifications returns it. */
function mailRow(id: string, ageMs: number, extra: Record<string, unknown> = {}) {
  return {
    id,
    type: "email",
    title: "Urgent email",
    message: `Kim: Q4 budget [gm-${id}]`,
    sourceEmailId: `mail-${id}`,
    isRead: false,
    createdAt: new Date(NOW - ageMs).toISOString(),
    ...extra,
  };
}

function missed(id: string, sender: string, ageMs = 10 * MIN): DesktopMissedMail {
  return {
    id,
    emailId: `mail-${id}`,
    title: sender,
    body: "Q4 budget\nYour CFO asked for it today",
    createdAt: new Date(NOW - ageMs).toISOString(),
  };
}

function answer(items: DesktopMissedMail[], held = false): DesktopCatchUpResponse {
  return { held, summaryTitle: SUMMARY, heldSummaryTitle: HELD_SUMMARY, items };
}

/** A live frame for one mail; untagged unless `tagged` (quiet hours untag it). */
function mailFrame(id: string, emailId = `mail-${id}`, tagged = false) {
  return {
    id,
    type: "email",
    title: "Urgent email",
    message: "Kim: Q4 budget",
    ...(tagged ? { alert: "push" } : {}),
    mail: { emailId, title: "Kim", body: "Q4 budget" },
  };
}

/** The pass as the shell runs it: by default the question named every row. */
function planAll(input: Omit<PushCatchUpInput, "sent"> & { sent?: readonly string[] }) {
  const sent = input.sent ?? input.rows.map((r) => (r as { id: string }).id);
  return planPushCatchUp({ ...input, sent });
}

const established = (notified: string[] = []): AlertLedger => ({
  owner: "user-1",
  baselineEstablished: true,
  notified,
});

describe("summarizeMissed — one toast for whatever was missed", () => {
  it("exactly one missed mail → that mail's normal toast, opening it", () => {
    expect(summarizeMissed([missed("n1", "Kim Lee")], SUMMARY)).toEqual({
      id: "n1",
      kind: "push",
      title: "Kim Lee",
      body: "Q4 budget\nYour CFO asked for it today",
      open: "/email/mail-n1",
    });
  });

  it("two or more → one summary in the user's language, opening Today", () => {
    const toast = summarizeMissed(
      [missed("n1", "Kim Lee"), missed("n2", "Park"), missed("n3", "Choi")],
      SUMMARY,
    );
    expect(toast).toEqual({
      id: "missed:n1",
      kind: "push",
      title: "3 urgent emails while Klorn was closed",
      body: "Kim Lee, Park, Choi",
      open: "/today",
    });
    const ko = notificationCopy("ko").missedWhileClosed("{count}");
    expect(summarizeMissed([missed("a", "김"), missed("b", "이")], ko)?.title).toBe(
      "Klorn이 꺼져 있는 동안 긴급 메일 2건",
    );
  });

  it("nothing missed → no toast", () => {
    expect(summarizeMissed([], SUMMARY)).toBeNull();
  });
});

describe("formatSenders — 'Sender1, Sender2, Sender3 +k'", () => {
  it("names three and counts the rest", () => {
    expect(formatSenders(["A", "B", "C", "D", "E"])).toBe("A, B, C +2");
    expect(formatSenders(["A", "B"])).toBe("A, B");
    expect(formatSenders(["A", "B", "C"])).toBe("A, B, C");
  });

  it("names each sender once, in order", () => {
    expect(formatSenders(["A", "A", "B", " A ", "C", "B", "D"])).toBe("A, B, C +1");
  });

  it("skips blank names", () => {
    expect(formatSenders(["", "  ", "A"])).toBe("A");
  });
});

describe("pushCatchUpCandidates — which bell rows to ask the server about", () => {
  it("asks about an unseen, unread mail row from the last 72 hours", () => {
    expect(pushCatchUpCandidates(established(), [mailRow("n1", 2 * HOUR)], NOW)).toEqual({
      ask: ["n1"],
      settled: [],
    });
  });

  it("settles (records) rows that can never toast: older than 72h, read, bad timestamp", () => {
    const rows = [
      mailRow("old", PUSH_CATCHUP_WINDOW_MS + MIN),
      mailRow("read", HOUR, { isRead: true }),
      mailRow("odd", HOUR, { createdAt: "soon" }),
      mailRow("edge", PUSH_CATCHUP_WINDOW_MS - MIN),
    ];
    expect(PUSH_CATCHUP_WINDOW_MS).toBe(72 * HOUR);
    expect(pushCatchUpCandidates(established(), rows, NOW)).toEqual({
      ask: ["edge"],
      settled: ["old", "read", "odd"],
    });
  });

  it("leaves a row younger than the settle window to its live frame", () => {
    const rows = [mailRow("new", SETTLE_MS - 1_000)];
    expect(pushCatchUpCandidates(established(), rows, NOW)).toEqual({ ask: [], settled: [] });
  });

  it("skips ids already announced, rows that name no mail, and malformed rows", () => {
    const rows = [
      mailRow("seen", HOUR),
      mailRow("nomail", HOUR, { sourceEmailId: null }),
      { ...mailRow("meeting", HOUR), type: "meeting" },
      mailRow("bad id!", HOUR),
      null,
      "x",
      [],
    ];
    expect(pushCatchUpCandidates(established(["seen"]), rows, NOW)).toEqual({
      ask: [],
      settled: [],
    });
  });

  it("asks about each id once, never more than the server reads, and keeps the rest", () => {
    const rows = Array.from({ length: ASK_MAX + 5 }, (_, i) => mailRow(`n${i}`, HOUR));
    const { ask, settled } = pushCatchUpCandidates(established(), [...rows, rows[0]], NOW);
    expect(ask).toHaveLength(ASK_MAX);
    expect(new Set(ask).size).toBe(ASK_MAX);
    // Not recorded unasked: a later pass asks about them.
    expect(settled).toEqual([]);
  });

  it("a row the firewall actually writes names its mail (judge/firewall-push.ts)", () => {
    const bell = firewallBellRow(
      {
        id: "email-db-1",
        gmailId: "18c0ffee",
        from: '"Kim Lee" <kim@example.com>',
        subject: "Signed contract due today",
      } as unknown as Parameters<typeof firewallBellRow>[0],
      "en",
    );
    expect(bell.sourceEmailId).toBe("email-db-1");
    const row = { id: "n1", ...bell, isRead: false, createdAt: new Date(NOW - HOUR).toISOString() };
    expect(pushCatchUpCandidates(established(), [row], NOW).ask).toEqual(["n1"]);
  });
});

describe("planPushCatchUp — first run is a silent baseline", () => {
  it("records every mail row and shows nothing, without needing the server", () => {
    const rows = [mailRow("n1", HOUR), mailRow("old", 80 * HOUR)];
    const plan = planAll({
      ledger: freshLedger("user-1"),
      rows,
      nowMs: NOW,
      response: null,
    });
    expect(plan.toast).toBeNull();
    expect(plan.next.notified).toEqual(["n1", "old"]);
    // The meeting pass establishes the baseline, right after.
    expect(plan.next.baselineEstablished).toBe(false);
  });
});

describe("planPushCatchUp — after the baseline", () => {
  it("one missed mail → its own toast; the id is never shown again", () => {
    const rows = [mailRow("n1", HOUR)];
    const plan = planAll({
      ledger: established(),
      rows,
      nowMs: NOW,
      response: answer([missed("n1", "Kim Lee")]),
    });
    expect(plan.toast).toMatchObject({ id: "n1", title: "Kim Lee", open: "/email/mail-n1" });
    // The row, and the mail itself (one mail, one toast: web-desktop-mail-dedupe).
    expect(plan.next.notified).toEqual(["n1", "mail:mail-n1"]);
    const again = planAll({
      ledger: plan.next,
      rows,
      nowMs: NOW,
      response: answer([missed("n1", "Kim Lee")]),
    });
    expect(again.toast).toBeNull();
  });

  it("several missed mails → ONE summary toast, all of them recorded", () => {
    const rows = ["n1", "n2", "n3", "n4", "n5"].map((id) => mailRow(id, HOUR));
    const plan = planAll({
      ledger: established(),
      rows,
      nowMs: NOW,
      response: answer([
        missed("n1", "A"),
        missed("n2", "B"),
        missed("n3", "C"),
        missed("n4", "D"),
        missed("n5", "E"),
      ]),
    });
    expect(plan.toast).toEqual({
      id: "missed:n1",
      kind: "push",
      title: "5 urgent emails while Klorn was closed",
      body: "A, B, C +2",
      open: "/today",
    });
    expect(plan.next.notified).toEqual([
      "n1",
      "n2",
      "n3",
      "n4",
      "n5",
      ...["n1", "n2", "n3", "n4", "n5"].map((id) => `mail:mail-${id}`),
    ]);
  });

  it("a mail handled since (not returned by the server) is recorded, not shown", () => {
    const rows = [mailRow("open", HOUR), mailRow("handled", HOUR)];
    const plan = planAll({
      ledger: established(),
      rows,
      nowMs: NOW,
      response: answer([missed("open", "Kim")]),
    });
    expect(plan.toast?.id).toBe("open");
    expect(plan.next.notified).toEqual(["open", "handled", "mail:mail-open"]);
  });

  it("ignores anything the server returns that the shell did not ask about", () => {
    const plan = planAll({
      ledger: established(["seen"]),
      rows: [mailRow("n1", HOUR), mailRow("seen", HOUR)],
      nowMs: NOW,
      response: answer([missed("n1", "Kim"), missed("seen", "Lee"), missed("other", "Park")]),
    });
    expect(plan.toast).toMatchObject({ id: "n1", title: "Kim" });
  });

  it("quiet hours: nothing shown, the askable rows kept for after they end", () => {
    const rows = [mailRow("n1", HOUR), mailRow("n2", HOUR), mailRow("old", 80 * HOUR)];
    const held = planAll({
      ledger: established(),
      rows,
      nowMs: NOW,
      response: answer([], true),
    });
    expect(held.toast).toBeNull();
    expect(held.next.notified).toEqual(["old"]);
    // Quiet hours over: the same two mails come back as one summary.
    const after = planAll({
      ledger: held.next,
      rows,
      nowMs: NOW + 2 * HOUR,
      response: answer([missed("n1", "Kim"), missed("n2", "Lee")]),
    });
    expect(after.toast?.title).toBe("2 urgent emails while Klorn was closed");
  });

  it("a row that became askable while the request was in flight waits for the next pass", () => {
    // n2 was younger than the settle window when the question went out.
    const rows = [mailRow("n1", HOUR), mailRow("n2", SETTLE_MS + 1_000)];
    const plan = planAll({
      ledger: established(),
      rows,
      nowMs: NOW,
      response: answer([missed("n1", "Kim"), missed("n2", "Lee")]),
      sent: ["n1"],
    });
    expect(plan.toast).toMatchObject({ id: "n1" });
    expect(plan.next.notified).toEqual(["n1", "mail:mail-n1"]);
    expect(pushCatchUpCandidates(plan.next, rows, NOW).ask).toEqual(["n2"]);
  });

  it("no answer (not asked, or the request failed): nothing shown, askable rows kept", () => {
    const plan = planAll({
      ledger: established(),
      rows: [mailRow("n1", HOUR)],
      nowMs: NOW,
      response: null,
    });
    expect(plan.toast).toBeNull();
    expect(plan.next.notified).toEqual([]);
  });

  it("a mail already bannered live is never caught up again", () => {
    const frame = {
      id: "n1",
      type: "email",
      title: "Urgent email",
      message: "Kim: Q4 budget",
      alert: "push",
      mail: { emailId: "mail-n1", title: "Kim", body: "Q4 budget" },
    };
    const live = planLiveAlert(established(), frame);
    expect(live.alert?.open).toBe("/email/mail-n1");
    expect(pushCatchUpCandidates(live.next, [mailRow("n1", HOUR)], NOW).ask).toEqual([]);
  });

  it("an untagged live frame (quiet hours) in any language is held, then asked about", () => {
    const frame = {
      id: "n1",
      type: "email",
      title: "긴급 메일",
      message: "김: 예산",
      mail: { emailId: "mail-n1", title: "김", body: "예산" },
    };
    const live = planLiveAlert(established(), frame);
    expect(live.alert).toBeNull();
    expect(live.next.notified).toEqual([]);
    // Left to its live frame while it settles, then asked like any missed row.
    expect(pushCatchUpCandidates(live.next, [mailRow("n1", SETTLE_MS - 1_000)], NOW).ask).toEqual(
      [],
    );
    expect(pushCatchUpCandidates(live.next, [mailRow("n1", HOUR)], NOW).ask).toEqual(["n1"]);
  });

  it("never mutates its input ledger", () => {
    const ledger = established(["a"]);
    const snapshot = structuredClone(ledger);
    planAll({
      ledger,
      rows: [mailRow("n1", HOUR)],
      nowMs: NOW,
      response: answer([missed("n1", "Kim")]),
    });
    expect(ledger).toEqual(snapshot);
  });
});

describe("mail held during quiet hours while Klorn runs (live frame untagged)", () => {
  /** Live frames for `ids`, as the shell receives them during quiet hours. */
  function heldLive(ids: string[], ledger = established()): AlertLedger {
    return ids.reduce((acc, id) => planLiveAlert(acc, mailFrame(id)).next, ledger);
  }

  it("two or more → ONE summary titled for quiet hours after they end, then never again", () => {
    const rows = [mailRow("n1", HOUR), mailRow("n2", HOUR)];
    const quiet = planAll({
      ledger: heldLive(["n1", "n2"]),
      rows,
      nowMs: NOW,
      response: answer([], true),
    });
    expect(quiet.toast).toBeNull();
    expect(quiet.next.notified).toEqual([]);
    expect(quiet.next.held).toEqual(["n1", "n2"]);

    const after = planAll({
      ledger: quiet.next,
      rows,
      nowMs: NOW + 2 * HOUR,
      response: answer([missed("n1", "Kim"), missed("n2", "Lee")]),
    });
    expect(after.toast).toEqual({
      id: "missed:n1",
      kind: "push",
      title: "2 urgent emails during quiet hours",
      body: "Kim, Lee",
      open: "/today",
    });
    expect(after.next.notified).toEqual(["n1", "n2", "mail:mail-n1", "mail:mail-n2"]);
    expect(after.next.held).toEqual([]);
    // Nothing left to ask, and a re-ring of the same mail never toasts live.
    expect(pushCatchUpCandidates(after.next, rows, NOW + 2 * HOUR).ask).toEqual([]);
    expect(planLiveAlert(after.next, mailFrame("n3", "mail-n1", true)).alert).toBeNull();
  });

  it("one held mail → its own toast, opening it (as the Mac)", () => {
    const after = planAll({
      ledger: heldLive(["n1"]),
      rows: [mailRow("n1", HOUR)],
      nowMs: NOW,
      response: answer([missed("n1", "Kim")]),
    });
    expect(after.toast).toMatchObject({ id: "n1", title: "Kim", open: "/email/mail-n1" });
    expect(after.next.held).toEqual([]);
  });

  it("held mail plus mail missed while closed → the 'while Klorn was closed' title (as the Mac)", () => {
    const after = planAll({
      ledger: heldLive(["n1"]),
      rows: [mailRow("n1", HOUR), mailRow("n2", HOUR)],
      nowMs: NOW,
      response: answer([missed("n1", "Kim"), missed("n2", "Lee")]),
    });
    expect(after.toast?.title).toBe("2 urgent emails while Klorn was closed");
  });

  it("a server without the quiet-hours title → the closed title, never no toast", () => {
    const { heldSummaryTitle: _drop, ...older } = answer([
      missed("n1", "Kim"),
      missed("n2", "Lee"),
    ]);
    const after = planAll({
      ledger: heldLive(["n1", "n2"]),
      rows: [mailRow("n1", HOUR), mailRow("n2", HOUR)],
      nowMs: NOW,
      response: older,
    });
    expect(after.toast?.title).toBe("2 urgent emails while Klorn was closed");
  });

  it("read meanwhile (the server leaves it out) → recorded and released, no toast for it", () => {
    const after = planAll({
      ledger: heldLive(["n1", "n2"]),
      rows: [mailRow("n1", HOUR), mailRow("n2", HOUR)],
      nowMs: NOW,
      response: answer([missed("n2", "Lee")]),
    });
    expect(after.toast).toMatchObject({ id: "n2", title: "Lee" });
    expect(after.next.notified).toEqual(["n1", "n2", "mail:mail-n2"]);
    expect(after.next.held).toEqual([]);
  });

  it("cleared meanwhile → never asked: Clear all marks the row read and the bell drops it", () => {
    const ledger = heldLive(["n1", "n2"]);
    // Clear all sets isRead (and clearedAt, which hides the row from the bell).
    const readRow = pushCatchUpCandidates(ledger, [mailRow("n1", HOUR, { isRead: true })], NOW);
    expect(readRow).toEqual({ ask: [], settled: ["n1"] });
    expect(pushCatchUpCandidates(ledger, [], NOW).ask).toEqual([]);
    const plan = planAll({
      ledger,
      rows: [mailRow("n1", HOUR, { isRead: true })],
      nowMs: NOW,
      response: null,
    });
    expect(plan.toast).toBeNull();
    expect(plan.next.notified).toEqual(["n1"]);
    expect(plan.next.held).toEqual(["n2"]);
  });

  it("first run: a mail held live before the baseline pass is not swallowed by it", () => {
    const ledger = heldLive(["n1"], freshLedger("user-1"));
    const baseline = planPushCatchUp({
      ledger,
      rows: [mailRow("n1", HOUR), mailRow("old", HOUR)],
      nowMs: NOW,
      response: null,
      sent: [],
    });
    expect(baseline.toast).toBeNull();
    expect(baseline.next.notified).toEqual(["old"]);
    const afterBaseline = { ...baseline.next, baselineEstablished: true };
    expect(pushCatchUpCandidates(afterBaseline, [mailRow("n1", HOUR)], NOW).ask).toEqual(["n1"]);
  });

  it("an empty answer (alerts off, or MEETING-lane mail) records and releases, no toast", () => {
    const after = planAll({
      ledger: heldLive(["n1", "n2"]),
      rows: [mailRow("n1", HOUR), mailRow("n2", HOUR)],
      nowMs: NOW,
      response: answer([]),
    });
    expect(after.toast).toBeNull();
    expect(after.next.notified).toEqual(["n1", "n2"]);
    expect(after.next.held).toEqual([]);
  });

  it("a tagged re-ring of a held mail toasts live; the held row then settles silently", () => {
    const rerung = planLiveAlert(heldLive(["n1"]), mailFrame("n3", "mail-n1", true));
    expect(rerung.alert?.open).toBe("/email/mail-n1");
    const after = planAll({
      ledger: rerung.next,
      rows: [mailRow("n3", HOUR), mailRow("n1", HOUR)],
      nowMs: NOW,
      response: answer([missed("n1", "Kim")]),
    });
    expect(after.toast).toBeNull();
    expect(after.next.notified).toContain("n1");
    expect(after.next.held).toEqual([]);
  });
});

describe("parseCatchUpResponse — the server's answer is validated", () => {
  it("keeps the quiet-hours title when well formed, drops only it when not", () => {
    const base = { held: false, summaryTitle: SUMMARY, items: [] };
    expect(parseCatchUpResponse({ ...base, heldSummaryTitle: HELD_SUMMARY })).toEqual({
      ...base,
      heldSummaryTitle: HELD_SUMMARY,
    });
    expect(parseCatchUpResponse(base)).toEqual(base);
    for (const bad of [3, "no count token", null]) {
      expect(parseCatchUpResponse({ ...base, heldSummaryTitle: bad })).toEqual(base);
    }
  });

  it("keeps well-formed items and drops malformed ones", () => {
    const parsed = parseCatchUpResponse({
      held: false,
      summaryTitle: SUMMARY,
      items: [
        missed("n1", "Kim"),
        { ...missed("n2", "Lee"), emailId: "../settings" },
        { ...missed("n3", "Park"), title: " " },
        { ...missed("n4", "Choi"), createdAt: 5 },
        null,
      ],
    });
    expect(parsed?.items.map((i) => i.id)).toEqual(["n1"]);
  });

  it("rejects a malformed envelope", () => {
    for (const bad of [
      null,
      [],
      "x",
      { held: "no", summaryTitle: SUMMARY, items: [] },
      { held: false, summaryTitle: 3, items: [] },
      { held: false, summaryTitle: SUMMARY, items: {} },
      { held: false, summaryTitle: "no count token", items: [] },
    ]) {
      expect(parseCatchUpResponse(bad)).toBeNull();
    }
  });
});

describe("the summary title exists in every notification language", () => {
  it("names the count in each of the 7 languages", () => {
    for (const lang of ["en", "ko", "ja", "zh", "es", "fr", "de"]) {
      const title = notificationCopy(lang).missedWhileClosed(4);
      expect(title, lang).toContain("4");
      expect(title, lang).toContain("Klorn");
      expect(notificationCopy(lang).heldDuringQuietHours("{count}"), lang).toContain("{count}");
    }
  });
});
