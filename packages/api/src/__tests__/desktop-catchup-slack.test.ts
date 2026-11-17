/**
 * GET /api/notifications/desktop-catchup for held Slack PUSH rows
 * (notify/desktop-catchup.ts): a Slack push that would not ring during quiet
 * hours sent an untagged live frame, the Windows shell held it, and asks here
 * once they may be over. A Slack row still deserves a toast when it is this
 * user's, asked about, unread (so neither read nor cleared), from the last
 * 72 hours, and its episode was not answered in Slack since. The toast text
 * is the row's own title and message — the live Slack push's text, nothing
 * more. The live frame's gate applies, as for mail.
 *
 * Runs over the strict in-memory database (helpers/fake-db.ts).
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import { createFakeDb, type FakeDb, type Row } from "./helpers/fake-db.js";

const dbHolder = vi.hoisted(() => ({ current: null as unknown }));

vi.mock("../db.js", async () => {
  const { fakePrismaClient } = await import("./helpers/fake-db.js");
  const prisma = fakePrismaClient(() => dbHolder.current as FakeDb);
  return { prisma, db: prisma };
});
vi.mock("../sentry.js", () => ({ captureError: vi.fn() }));

import { desktopCatchUp } from "../notify/desktop-catchup.js";

const USER = "user-1";
// 12:00 UTC = 21:00 in Seoul.
const NOW = new Date("2026-11-08T12:00:00.000Z");
const HOUR = 60 * 60_000;

function slackRow(id: string, extra: Row = {}): Row {
  return {
    id,
    userId: USER,
    type: "slack",
    title: "Slack · Direct message",
    message: "prod is down\nNeeds you now",
    link: "https://acme.slack.com/archives/D0DM/p1",
    isRead: false,
    dedupeKey: `slack:ep-${id}`,
    createdAt: new Date(NOW.getTime() - HOUR),
    ...extra,
  };
}

function episode(id: string, answeredAt: Date | null = null): Row {
  return { id, userId: USER, answeredAt };
}

let db: FakeDb;

function seed(tables: Partial<Record<string, Row[]>>, config: Row | null = null) {
  db = createFakeDb({
    automationConfig: config ? [{ id: "cfg-1", userId: USER, ...config }] : [],
    notification: [],
    emailMessage: [],
    attentionItem: [],
    slackEpisode: [],
    user: [],
    ...tables,
  } as Record<string, Row[]>);
  dbHolder.current = db;
}

beforeEach(() => {
  seed({});
});

describe("desktopCatchUp — held Slack rows", () => {
  it("returns an asked, unread Slack row from the last 72 hours with the row's own text", async () => {
    seed({ notification: [slackRow("s1")], slackEpisode: [episode("ep-s1")] });
    const res = await desktopCatchUp(USER, ["s1"], NOW);
    expect(res.held).toBe(false);
    expect(res.items).toEqual([]);
    expect(res.slack).toEqual([
      {
        id: "s1",
        title: "Slack · Direct message",
        body: "prod is down\nNeeds you now",
        createdAt: new Date(NOW.getTime() - HOUR).toISOString(),
      },
    ]);
    expect(res.messagesSummaryTitle).toBe("{count} urgent messages while Klorn was closed");
    expect(res.heldMessagesSummaryTitle).toBe("{count} urgent messages during quiet hours");
  });

  it("leaves out read or cleared rows, old rows, other users' rows and rows not asked about", async () => {
    seed({
      notification: [
        slackRow("read", { isRead: true }),
        slackRow("cleared", { isRead: true, clearedAt: new Date(NOW.getTime() - 30_000) }),
        slackRow("old", { createdAt: new Date(NOW.getTime() - 73 * HOUR) }),
        slackRow("theirs", { userId: "user-2" }),
        slackRow("unasked"),
        slackRow("legacy", { dedupeKey: null }),
      ],
    });
    const res = await desktopCatchUp(USER, ["read", "cleared", "old", "theirs", "legacy"], NOW);
    expect(res.slack?.map((s) => s.id)).toEqual(["legacy"]);
  });

  it("leaves out one the user answered in Slack since", async () => {
    seed({
      notification: [slackRow("s1"), slackRow("s2")],
      slackEpisode: [episode("ep-s1", new Date(NOW.getTime() - 10 * 60_000)), episode("ep-s2")],
    });
    const res = await desktopCatchUp(USER, ["s1", "s2"], NOW);
    expect(res.slack?.map((s) => s.id)).toEqual(["s2"]);
  });

  it("quiet hours: held and nothing returned; after them the row comes back", async () => {
    const tables = { notification: [slackRow("s1")], slackEpisode: [episode("ep-s1")] };
    seed(tables, { timezone: "Asia/Seoul", quietHoursStart: "20:00", quietHoursEnd: "08:00" });
    const quiet = await desktopCatchUp(USER, ["s1"], NOW);
    expect(quiet.held).toBe(true);
    expect(quiet.slack).toEqual([]);
    const later = await desktopCatchUp(USER, ["s1"], new Date("2026-11-09T00:00:00.000Z"));
    expect(later.slack?.map((s) => s.id)).toEqual(["s1"]);
  });

  it("urgent alerts turned off: nothing, and not held", async () => {
    seed({ notification: [slackRow("s1")] }, { notifyEmailUrgent: false });
    const res = await desktopCatchUp(USER, ["s1"], NOW);
    expect(res).toMatchObject({ held: false, items: [], slack: [] });
  });

  it("titles the messages summary in the user's notification language", async () => {
    seed({}, { notificationLanguage: "ko" });
    const res = await desktopCatchUp(USER, [], NOW);
    expect(res.heldMessagesSummaryTitle).toContain("{count}");
    expect(res.heldMessagesSummaryTitle).not.toBe(res.heldSummaryTitle);
  });
});
