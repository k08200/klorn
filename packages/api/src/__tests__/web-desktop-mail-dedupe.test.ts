/**
 * Windows desktop shell (apps/desktop-win, Tauri): one mail gets one toast,
 * whatever number of bell rows the server writes for it.
 *
 * The shell's ledger (packages/web/src/lib/native/desktop-catchup.ts) used to
 * key only on the bell row id. The server can write a second row for a mail
 * already announced — "Clear all" deletes the urgent rows the sweep's dedupe
 * reads, so the next sweep tick rings the same unread mail again — and the
 * shell toasted it again. The Mac keys its PushLedger on the mail's attention
 * item, so it announces a mail once. The ledger now also records the mail
 * (`mail:<emailId>`) of every mail toast, live or caught up.
 */

import type { DesktopCatchUpResponse, DesktopMissedMail } from "@klorn/contract";
import { describe, expect, it, vi } from "vitest";

vi.mock("../db.js", () => ({ prisma: {} }));

import { planDesktopAlert } from "../../../web/src/lib/native/desktop-alerts";
import {
  type AlertLedger,
  freshLedger,
  planLiveAlert,
} from "../../../web/src/lib/native/desktop-catchup";
import {
  planPushCatchUp,
  pushCatchUpCandidates,
} from "../../../web/src/lib/native/desktop-push-catchup";

const NOW = Date.parse("2026-11-14T12:00:00.000Z");
const HOUR = 60 * 60_000;
const SUMMARY_TITLE = "{count} urgent emails while Klorn was closed";

/** A tagged live frame for one mail (decision N1). */
function pushFrame(rowId: string, emailId: string) {
  return {
    id: rowId,
    alert: "push",
    type: "email",
    title: "Urgent email",
    message: "Kim: contract",
    mail: { emailId, title: "Kim", body: "Signed contract" },
  };
}

function meetingFrame(rowId: string) {
  return { id: rowId, alert: "meeting", type: "meeting", title: "Meeting in 5 min", message: "x" };
}

/** A bell row (GET /api/notifications) naming one mail. */
function bellRow(rowId: string, emailId: string, ageMs = HOUR) {
  return {
    id: rowId,
    type: "email",
    title: "Urgent email",
    message: "Kim: contract [gm-1]",
    isRead: false,
    sourceEmailId: emailId,
    createdAt: new Date(NOW - ageMs).toISOString(),
  };
}

function missed(rowId: string, emailId: string, title = "Kim"): DesktopMissedMail {
  return {
    id: rowId,
    emailId,
    title,
    body: "Signed contract",
    createdAt: new Date(NOW - HOUR).toISOString(),
  };
}

function answer(items: DesktopMissedMail[]): DesktopCatchUpResponse {
  return { held: false, summaryTitle: SUMMARY_TITLE, items };
}

function established(notified: string[] = []): AlertLedger {
  return { ...freshLedger("user-1"), baselineEstablished: true, notified };
}

describe("live frames: one mail, one toast", () => {
  it("a second row for a mail already toasted does not toast again, and is recorded", () => {
    const first = planDesktopAlert([], pushFrame("row-1", "e1"));
    expect(first.alert?.id).toBe("row-1");

    const second = planDesktopAlert(first.seen, pushFrame("row-2", "e1"));
    expect(second.alert).toBeNull();
    expect(second.seen).toContain("row-2");
  });

  it("different mails still toast", () => {
    const first = planDesktopAlert([], pushFrame("row-1", "e1"));
    const second = planDesktopAlert(first.seen, pushFrame("row-2", "e2"));
    expect(second.alert?.id).toBe("row-2");
  });

  it("meeting reminders are unaffected", () => {
    const first = planDesktopAlert([], meetingFrame("m-1"));
    const second = planDesktopAlert(first.seen, meetingFrame("m-2"));
    expect(first.alert?.id).toBe("m-1");
    expect(second.alert?.id).toBe("m-2");
  });

  it("holds through the ledger the shell persists", () => {
    const first = planLiveAlert(established(), pushFrame("row-1", "e1"));
    const stored: AlertLedger = JSON.parse(JSON.stringify(first.next));
    expect(planLiveAlert(stored, pushFrame("row-2", "e1")).alert).toBeNull();
  });
});

describe("catch-up: a mail toasted once is not caught up again", () => {
  it("does not ask about a row whose mail was already toasted live", () => {
    const live = planLiveAlert(established(), pushFrame("row-1", "e1"));
    const { ask, settled } = pushCatchUpCandidates(live.next, [bellRow("row-2", "e1")], NOW);
    expect(ask).toEqual([]);
    expect(settled).toEqual(["row-2"]);
  });

  it("a live re-ring of a mail the catch-up toasted is suppressed", () => {
    const plan = planPushCatchUp({
      ledger: established(),
      rows: [bellRow("row-1", "e1")],
      nowMs: NOW,
      response: answer([missed("row-1", "e1")]),
      sent: ["row-1"],
    });
    expect(plan.toast?.open).toBe("/email/e1");
    expect(planLiveAlert(plan.next, pushFrame("row-2", "e1")).alert).toBeNull();
  });

  it("two rows for one mail in one pass are one mail's toast, not a summary of two", () => {
    const plan = planPushCatchUp({
      ledger: established(),
      rows: [bellRow("row-2", "e1"), bellRow("row-1", "e1", 2 * HOUR)],
      nowMs: NOW,
      response: answer([missed("row-2", "e1"), missed("row-1", "e1")]),
      sent: ["row-2", "row-1"],
    });
    expect(plan.toast).toMatchObject({ id: "row-2", open: "/email/e1" });
  });

  it("the summary records every mail it covers", () => {
    const plan = planPushCatchUp({
      ledger: established(),
      rows: [bellRow("row-1", "e1"), bellRow("row-3", "e2")],
      nowMs: NOW,
      response: answer([missed("row-1", "e1", "Kim"), missed("row-3", "e2", "Lee")]),
      sent: ["row-1", "row-3"],
    });
    expect(plan.toast?.open).toBe("/today");
    expect(planLiveAlert(plan.next, pushFrame("row-4", "e2")).alert).toBeNull();
    expect(planLiveAlert(plan.next, pushFrame("row-5", "e1")).alert).toBeNull();
  });
});
