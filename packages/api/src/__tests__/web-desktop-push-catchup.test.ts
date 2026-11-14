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
  return { held, summaryTitle: SUMMARY, items };
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

  it("an untagged live frame (gate said no) in any language is recorded, never caught up", () => {
    const frame = {
      id: "n1",
      type: "email",
      title: "긴급 메일",
      message: "김: 예산",
      mail: { emailId: "mail-n1", title: "김", body: "예산" },
    };
    const live = planLiveAlert(established(), frame);
    expect(live.alert).toBeNull();
    expect(live.next.notified).toEqual(["n1"]);
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

describe("parseCatchUpResponse — the server's answer is validated", () => {
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
    }
  });
});
