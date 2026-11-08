/**
 * Decision N6 (LOCKED 2026-11-08), server side: GET
 * /api/notifications/desktop-catchup tells the Windows desktop shell which of
 * the bell rows it missed still deserve a toast (notify/desktop-catchup.ts):
 * this user's urgent-mail rows naming one mail, unread, from the last 72h,
 * whose mail is still an OPEN PUSH item — shaped like every mail notification
 * (decision N1) in the user's notification language. The live frame's gate
 * applies: a category opt-out returns nothing, quiet hours return `held`.
 *
 * Runs over the strict in-memory database (helpers/fake-db.ts), so the where
 * clauses are evaluated, not just issued.
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

import {
  DESKTOP_CATCHUP_MAX_IDS,
  desktopCatchUp,
  parseCatchUpIds,
} from "../notify/desktop-catchup.js";

const USER = "user-1";
const OTHER = "user-2";
// 12:00 UTC = 21:00 in Seoul.
const NOW = new Date("2026-11-08T12:00:00.000Z");
const HOUR = 60 * 60_000;

function bell(id: string, emailId: string | null, extra: Row = {}): Row {
  return {
    id,
    userId: USER,
    type: "email",
    title: "Urgent email",
    message: `x [gm-${id}]`,
    isRead: false,
    sourceEmailId: emailId,
    createdAt: new Date(NOW.getTime() - HOUR),
    ...extra,
  };
}

function email(id: string, from: string, subject: string, userId = USER): Row {
  return {
    id,
    userId,
    gmailId: `gm-${id}`,
    from,
    to: "me@example.com",
    subject,
    createdAt: new Date(NOW.getTime() - 2 * HOUR),
  };
}

function item(sourceId: string, extra: Row = {}): Row {
  return {
    id: `ai-${sourceId}`,
    userId: USER,
    source: "EMAIL",
    sourceId,
    status: "OPEN",
    tier: "PUSH",
    tierReason: "Signature needed today",
    title: "t",
    ...extra,
  };
}

let db: FakeDb;

function seed(tables: Partial<Record<string, Row[]>>, config: Row | null = null) {
  db = createFakeDb({
    automationConfig: config ? [{ id: "cfg-1", userId: USER, ...config }] : [],
    notification: [],
    emailMessage: [],
    attentionItem: [],
    user: [],
    ...tables,
  } as Record<string, Row[]>);
  dbHolder.current = db;
}

beforeEach(() => {
  seed({});
});

describe("desktopCatchUp — which missed mails still deserve a toast", () => {
  it("returns an open PUSH mail in N1 shape, newest first", async () => {
    seed({
      notification: [
        bell("n-old", "e1", { createdAt: new Date(NOW.getTime() - 5 * HOUR) }),
        bell("n-new", "e2"),
      ],
      emailMessage: [
        email("e1", '"Kim Lee" <kim@example.com>', "Signed contract"),
        email("e2", "Park <park@example.com>", ""),
      ],
      attentionItem: [item("e1"), item("e2", { tierReason: null })],
    });

    const res = await desktopCatchUp(USER, ["n-old", "n-new"], NOW);

    expect(res.held).toBe(false);
    expect(res.summaryTitle).toBe("{count} urgent emails while Klorn was closed");
    expect(res.items).toEqual([
      {
        id: "n-new",
        emailId: "e2",
        title: "Park",
        body: "(no subject)",
        createdAt: new Date(NOW.getTime() - HOUR).toISOString(),
      },
      {
        id: "n-old",
        emailId: "e1",
        title: "Kim Lee",
        body: "Signed contract\nSignature needed today",
        createdAt: new Date(NOW.getTime() - 5 * HOUR).toISOString(),
      },
    ]);
  });

  it("drops mail handled since, moved off PUSH, read, older than 72h, or another user's", async () => {
    seed({
      notification: [
        bell("done", "e1"),
        bell("queue", "e2"),
        bell("read", "e3", { isRead: true }),
        bell("stale", "e4", { createdAt: new Date(NOW.getTime() - 73 * HOUR) }),
        bell("theirs", "e5", { userId: OTHER }),
        bell("nomail", null),
        bell("candidate", "e6", { title: "Candidate materials received" }),
        bell("legacy", "e7", { title: "긴급 이메일" }),
      ],
      emailMessage: ["e1", "e2", "e3", "e4", "e5", "e6", "e7"].map((id) =>
        email(id, "Kim <kim@example.com>", "s", id === "e5" ? OTHER : USER),
      ),
      attentionItem: [
        item("e1", { status: "DONE" }),
        item("e2", { tier: "QUEUE" }),
        item("e3"),
        item("e4"),
        item("e5", { userId: OTHER }),
        item("e6"),
        item("e7", { tier: "CALL" }),
      ],
    });

    const res = await desktopCatchUp(
      USER,
      ["done", "queue", "read", "stale", "theirs", "nomail", "candidate", "legacy"],
      NOW,
    );

    // Only the legacy-titled row survives: an urgent title in an older
    // language, its mail still OPEN on the retired name of the PUSH lane.
    expect(res.items.map((i) => i.id)).toEqual(["legacy"]);
  });

  it("answers only about the ids it was asked about", async () => {
    seed({
      notification: [bell("asked", "e1"), bell("not-asked", "e2")],
      emailMessage: [email("e1", "Kim <k@x.com>", "a"), email("e2", "Lee <l@x.com>", "b")],
      attentionItem: [item("e1"), item("e2")],
    });
    const res = await desktopCatchUp(USER, ["asked"], NOW);
    expect(res.items.map((i) => i.id)).toEqual(["asked"]);
  });

  it("an empty question reads nothing", async () => {
    const res = await desktopCatchUp(USER, [], NOW);
    expect(res).toEqual({
      held: false,
      summaryTitle: "{count} urgent emails while Klorn was closed",
      items: [],
    });
  });

  it("titles the summary in the user's notification language", async () => {
    seed({}, { notificationLanguage: "ko" });
    const res = await desktopCatchUp(USER, [], NOW);
    expect(res.summaryTitle).toBe("Klorn이 꺼져 있는 동안 긴급 메일 {count}건");
  });
});

describe("desktopCatchUp — the live frame's gate applies", () => {
  const tables = {
    notification: [bell("n1", "e1")],
    emailMessage: [email("e1", "Kim <k@x.com>", "a")],
    attentionItem: [item("e1")],
  };

  it("quiet hours: held, nothing returned (the shell asks again after)", async () => {
    // 21:00 in Seoul, inside 20:00–08:00.
    seed(tables, { timezone: "Asia/Seoul", quietHoursStart: "20:00", quietHoursEnd: "08:00" });
    const res = await desktopCatchUp(USER, ["n1"], NOW);
    expect(res.held).toBe(true);
    expect(res.items).toEqual([]);
    // Quiet hours over (09:00 the next morning in Seoul): the mail comes back.
    const later = await desktopCatchUp(USER, ["n1"], new Date("2026-11-09T00:00:00.000Z"));
    expect(later.held).toBe(false);
    expect(later.items.map((i) => i.id)).toEqual(["n1"]);
  });

  it("urgent-mail alerts turned off: nothing, and not held", async () => {
    seed(tables, { notifyEmailUrgent: false });
    const res = await desktopCatchUp(USER, ["n1"], NOW);
    expect(res).toMatchObject({ held: false, items: [] });
  });
});

describe("parseCatchUpIds — the query is untrusted", () => {
  it("reads a comma-separated list of row ids, deduped", () => {
    expect(parseCatchUpIds("a1,b-2,a1")).toEqual(["a1", "b-2"]);
    expect(parseCatchUpIds("")).toEqual([]);
  });

  it("rejects anything else", () => {
    for (const bad of [
      undefined,
      42,
      ["a"],
      "a,,b",
      "a b",
      "a;b",
      "x".repeat(65),
      Array.from({ length: DESKTOP_CATCHUP_MAX_IDS + 1 }, (_, i) => `n${i}`).join(","),
    ]) {
      expect(parseCatchUpIds(bad)).toBeNull();
    }
  });
});
