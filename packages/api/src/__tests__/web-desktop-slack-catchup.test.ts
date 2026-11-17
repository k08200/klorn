/**
 * Windows desktop shell (apps/desktop-win, Tauri) — a Slack PUSH whose live
 * frame came untagged during quiet hours (slack/notify.ts sends the bell's
 * frame when the push will not ring) joins the urgent-mail catch-up
 * (packages/web lib/native/desktop-catchup.ts planLiveAlert holds it,
 * desktop-push-catchup.ts asks the server and toasts it once quiet hours end):
 *   - one held Slack message → its own toast, the live Slack push's own text;
 *   - with other held items → the same ONE summary, titled for messages;
 *   - the same ledger and rules as mail: read or cleared → no toast, at most
 *     once, and the hold survives a restart;
 *   - a Slack row that never came as a held frame (rung, budget-held) is
 *     never caught up.
 */

import type { DesktopCatchUpResponse, DesktopMissedMail } from "@klorn/contract";
import { describe, expect, it, vi } from "vitest";

vi.mock("../db.js", () => ({ prisma: {} }));

import { BODY_MAX } from "../../../web/src/lib/native/desktop-alerts";
import {
  type AlertLedger,
  parseLedger,
  planLiveAlert,
} from "../../../web/src/lib/native/desktop-catchup";
import {
  PUSH_CATCHUP_WINDOW_MS,
  type PushCatchUpInput,
  parseCatchUpResponse,
  planPushCatchUp,
  pushCatchUpCandidates,
} from "../../../web/src/lib/native/desktop-push-catchup";
import { NOTIFICATION_LANGUAGES, notificationCopy } from "../notify/notification-strings.js";

const NOW = Date.parse("2026-11-17T08:00:00.000Z");
const MIN = 60_000;
const HOUR = 60 * MIN;
const en = notificationCopy("en");
const SLACK_TITLE = "Slack · Direct message";
const SLACK_BODY = "prod is down\nNeeds you now";

/** The Slack bell row as GET /api/notifications returns it. */
function slackRow(id: string, ageMs: number, extra: Record<string, unknown> = {}) {
  return {
    id,
    type: "slack",
    title: SLACK_TITLE,
    message: SLACK_BODY,
    link: "https://acme.slack.com/archives/D0DM/p1",
    isRead: false,
    createdAt: new Date(NOW - ageMs).toISOString(),
    ...extra,
  };
}

/** The live frame slack/notify.ts sends; untagged unless the gate allowed a banner. */
function slackFrame(id: string, tagged = false) {
  return {
    id,
    type: "slack",
    title: SLACK_TITLE,
    message: SLACK_BODY,
    createdAt: new Date(NOW - HOUR).toISOString(),
    link: "https://acme.slack.com/archives/D0DM/p1",
    ...(tagged ? { alert: "push" } : {}),
  };
}

function mailRow(id: string, ageMs: number) {
  return {
    id,
    type: "email",
    title: "Urgent email",
    message: `Kim: Q4 budget [gm-${id}]`,
    sourceEmailId: `mail-${id}`,
    isRead: false,
    createdAt: new Date(NOW - ageMs).toISOString(),
  };
}

function mailFrame(id: string) {
  return {
    id,
    type: "email",
    title: "Urgent email",
    message: "Kim: Q4 budget",
    mail: { emailId: `mail-${id}`, title: "Kim", body: "Q4 budget" },
  };
}

function missedMail(id: string, sender: string, ageMs: number): DesktopMissedMail {
  return {
    id,
    emailId: `mail-${id}`,
    title: sender,
    body: "Q4 budget",
    createdAt: new Date(NOW - ageMs).toISOString(),
  };
}

function missedSlack(id: string, ageMs: number) {
  return {
    id,
    title: SLACK_TITLE,
    body: SLACK_BODY,
    createdAt: new Date(NOW - ageMs).toISOString(),
  };
}

function answer(
  parts: { items?: DesktopMissedMail[]; slack?: ReturnType<typeof missedSlack>[] },
  held = false,
): DesktopCatchUpResponse {
  return {
    held,
    summaryTitle: en.missedWhileClosed("{count}"),
    heldSummaryTitle: en.heldDuringQuietHours("{count}"),
    messagesSummaryTitle: en.messagesWhileClosed("{count}"),
    heldMessagesSummaryTitle: en.messagesDuringQuietHours("{count}"),
    items: parts.items ?? [],
    slack: parts.slack ?? [],
  };
}

const established = (notified: string[] = []): AlertLedger => ({
  owner: "user-1",
  baselineEstablished: true,
  notified,
});

/** Live frames as the shell receives them during quiet hours. */
function heldLive(frames: unknown[], ledger = established()): AlertLedger {
  return frames.reduce<AlertLedger>((acc, frame) => planLiveAlert(acc, frame).next, ledger);
}

function planAll(input: Omit<PushCatchUpInput, "sent"> & { sent?: readonly string[] }) {
  const sent = input.sent ?? input.rows.map((r) => (r as { id: string }).id);
  return planPushCatchUp({ ...input, sent });
}

describe("planLiveAlert — a Slack PUSH frame", () => {
  it("untagged (quiet hours): no banner now, held for the catch-up", () => {
    const plan = planLiveAlert(established(), slackFrame("s1"));
    expect(plan.alert).toBeNull();
    expect(plan.next.notified).toEqual([]);
    expect(plan.next.held).toEqual(["s1"]);
  });

  it("tagged: bannered live with the push's own text, and recorded", () => {
    const plan = planLiveAlert(established(), slackFrame("s1", true));
    expect(plan.alert).toEqual({
      id: "s1",
      kind: "push",
      title: SLACK_TITLE,
      body: SLACK_BODY,
      open: null,
    });
    expect(plan.next.notified).toEqual(["s1"]);
  });

  it("an untagged frame for an id already recorded, or a malformed one, changes nothing", () => {
    const ledger = established(["s1"]);
    expect(planLiveAlert(ledger, slackFrame("s1")).next).toBe(ledger);
    expect(planLiveAlert(ledger, { type: "slack", id: 42 }).next).toBe(ledger);
    expect(planLiveAlert(ledger, { type: "slack", id: "bad id!" }).next).toBe(ledger);
  });
});

describe("pushCatchUpCandidates — Slack rows", () => {
  it("asks about a held Slack row, and never about one that was not held", () => {
    const ledger = heldLive([slackFrame("s1")]);
    expect(
      pushCatchUpCandidates(ledger, [slackRow("s1", HOUR), slackRow("s2", HOUR)], NOW),
    ).toEqual({ ask: ["s1"], settled: [] });
  });

  it("settles a held Slack row that was read, cleared or is older than 72 hours", () => {
    const ledger = heldLive([slackFrame("s1"), slackFrame("s2")]);
    const rows = [
      slackRow("s1", HOUR, { isRead: true }),
      slackRow("s2", PUSH_CATCHUP_WINDOW_MS + MIN),
    ];
    expect(pushCatchUpCandidates(ledger, rows, NOW)).toEqual({ ask: [], settled: ["s1", "s2"] });
  });
});

describe("planPushCatchUp — held Slack messages", () => {
  it("during quiet hours nothing shows; after them, one Slack message → its own toast, once", () => {
    const rows = [slackRow("s1", HOUR)];
    const quiet = planAll({
      ledger: heldLive([slackFrame("s1")]),
      rows,
      nowMs: NOW,
      response: answer({}, true),
    });
    expect(quiet.toast).toBeNull();
    expect(quiet.next.held).toEqual(["s1"]);

    const after = planAll({
      ledger: quiet.next,
      rows,
      nowMs: NOW + HOUR,
      response: answer({ slack: [missedSlack("s1", HOUR)] }),
    });
    expect(after.toast).toEqual({
      id: "s1",
      kind: "push",
      title: SLACK_TITLE,
      body: SLACK_BODY,
      open: null,
    });
    expect(after.next.notified).toEqual(["s1"]);
    expect(after.next.held).toEqual([]);
    expect(pushCatchUpCandidates(after.next, rows, NOW + HOUR).ask).toEqual([]);
  });

  it("with held mail → ONE summary titled for messages during quiet hours", () => {
    const after = planAll({
      ledger: heldLive([mailFrame("n1"), slackFrame("s1")]),
      rows: [mailRow("n1", 2 * HOUR), slackRow("s1", HOUR)],
      nowMs: NOW,
      response: answer({
        items: [missedMail("n1", "Kim", 2 * HOUR)],
        slack: [missedSlack("s1", HOUR)],
      }),
    });
    expect(after.toast).toEqual({
      id: "missed:s1",
      kind: "push",
      title: "2 urgent messages during quiet hours",
      body: `${SLACK_TITLE}, Kim`,
      open: "/today",
    });
    expect(after.next.notified).toEqual(["n1", "s1", "mail:mail-n1"]);
    expect(after.next.held).toEqual([]);
  });

  it("with mail missed while closed → the summary titled for messages while closed", () => {
    const after = planAll({
      ledger: heldLive([slackFrame("s1")]),
      rows: [mailRow("n1", 2 * HOUR), slackRow("s1", HOUR)],
      nowMs: NOW,
      response: answer({
        items: [missedMail("n1", "Kim", 2 * HOUR)],
        slack: [missedSlack("s1", HOUR)],
      }),
    });
    expect(after.toast?.title).toBe("2 urgent messages while Klorn was closed");
  });

  it("left out by the server (read, cleared or answered in Slack) → recorded and released, no toast", () => {
    const after = planAll({
      ledger: heldLive([slackFrame("s1")]),
      rows: [slackRow("s1", HOUR)],
      nowMs: NOW,
      response: answer({}),
    });
    expect(after.toast).toBeNull();
    expect(after.next.notified).toEqual(["s1"]);
    expect(after.next.held).toEqual([]);
  });

  it("only what was asked: a Slack item the shell did not ask about is ignored", () => {
    const after = planAll({
      ledger: heldLive([slackFrame("s1")]),
      rows: [slackRow("s1", HOUR)],
      nowMs: NOW,
      response: answer({ slack: [missedSlack("s9", HOUR)] }),
    });
    expect(after.toast).toBeNull();
  });

  it("survives a restart once: the stored ledger keeps the hold, the toast shows once", () => {
    const stored = parseLedger(JSON.stringify(heldLive([slackFrame("s1")])));
    expect(stored?.held).toEqual(["s1"]);
    const rows = [slackRow("s1", HOUR)];
    const first = planAll({
      ledger: stored as AlertLedger,
      rows,
      nowMs: NOW,
      response: answer({ slack: [missedSlack("s1", HOUR)] }),
    });
    expect(first.toast?.id).toBe("s1");
    const relaunched = parseLedger(JSON.stringify(first.next)) as AlertLedger;
    const second = planAll({
      ledger: relaunched,
      rows,
      nowMs: NOW,
      response: answer({ slack: [missedSlack("s1", HOUR)] }),
    });
    expect(second.toast).toBeNull();
  });

  it("first run: a Slack message held before the baseline pass is not swallowed by it", () => {
    const ledger = heldLive([slackFrame("s1")], {
      owner: "user-1",
      baselineEstablished: false,
      notified: [],
    });
    const baseline = planPushCatchUp({
      ledger,
      rows: [slackRow("s1", HOUR)],
      nowMs: NOW,
      response: null,
      sent: [],
    });
    expect(baseline.next.notified).toEqual([]);
    expect(baseline.next.held).toEqual(["s1"]);
  });
});

describe("parseCatchUpResponse — Slack items", () => {
  it("keeps well-formed Slack items, capped like a live toast, and drops malformed ones", () => {
    const parsed = parseCatchUpResponse({
      ...answer({}),
      slack: [
        missedSlack("s1", HOUR),
        { ...missedSlack("s2", HOUR), body: "x".repeat(BODY_MAX + 50) },
        { id: "bad id!", title: "t", body: "b", createdAt: "2026-11-17T07:00:00.000Z" },
        { id: "s3", title: "  ", body: "b", createdAt: "2026-11-17T07:00:00.000Z" },
        { id: "s4", title: "t", body: 3, createdAt: "2026-11-17T07:00:00.000Z" },
        { id: "s5", title: "t", body: "b", createdAt: "not a date" },
      ],
    });
    expect(parsed?.slack?.map((s) => s.id)).toEqual(["s1", "s2"]);
    expect(parsed?.slack?.[1]?.body).toHaveLength(BODY_MAX);
  });

  it("a server without Slack items or titles still parses (mail only)", () => {
    const parsed = parseCatchUpResponse({
      held: false,
      summaryTitle: en.missedWhileClosed("{count}"),
      items: [],
    });
    expect(parsed).not.toBeNull();
    expect(parsed?.slack ?? []).toEqual([]);
  });
});

describe("the messages summary titles exist in every notification language", () => {
  it("names the count in each of the 7 languages", () => {
    for (const language of NOTIFICATION_LANGUAGES) {
      const copy = notificationCopy(language);
      expect(copy.messagesWhileClosed(3)).toContain("3");
      expect(copy.messagesDuringQuietHours(3)).toContain("3");
      expect(copy.messagesDuringQuietHours("{count}")).toContain("{count}");
    }
  });
});
