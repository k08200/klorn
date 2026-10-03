/**
 * C6: storing one device calendar snapshot. The first snapshot of a calendar
 * creates its DEVICE source (the opt-in, decision P4); every snapshot is the whole
 * truth for its window and its source only: rows of that source the snapshot lacks
 * are removed, through C3's deletion valve, with their open attention items
 * resolved, in one transaction. Another source's, provider's or user's rows are
 * never touched.
 *
 * The fake table applies the `where` keys the module uses, so a mutation that
 * drops a scope key shows up as a wrong row removed or updated.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

interface Account {
  id: string;
  userId: string;
  provider: string;
  email: string;
  displayName: string | null;
  deviceSnapshotAt?: Date | null;
  updatedAt: Date;
}
interface Row {
  id: string;
  userId: string;
  provider: string;
  externalId: string | null;
  sourceAccountId: string | null;
  sourceKey: string;
  title: string;
  description: string | null;
  startTime: Date;
  endTime: Date;
  location: string | null;
  meetingLink: string | null;
  allDay: boolean;
}
interface Attention {
  id: string;
  userId: string;
  source: string;
  sourceId: string;
  status: string;
}

const db = vi.hoisted(() => ({
  accounts: [] as unknown[],
  rows: [] as unknown[],
  attention: [] as unknown[],
  nextId: 0,
  captureError: vi.fn(),
  calls: { update: 0, createMany: 0 },
}));

type Where = Record<string, unknown>;

function matchValue(actual: unknown, expected: unknown): boolean {
  if (expected !== null && typeof expected === "object" && !(expected instanceof Date)) {
    const ops = expected as Record<string, unknown>;
    if ("in" in ops) return (ops.in as unknown[]).includes(actual);
    if ("notIn" in ops) return !(ops.notIn as unknown[]).includes(actual);
    if ("lt" in ops) return (actual as Date).getTime() < (ops.lt as Date).getTime();
    if ("gte" in ops) return (actual as Date).getTime() >= (ops.gte as Date).getTime();
    if ("gt" in ops) return (actual as Date).getTime() > (ops.gt as Date).getTime();
    throw new Error(`fake: unsupported operator ${Object.keys(ops).join(",")}`);
  }
  return actual === expected;
}

function matches(item: Record<string, unknown>, where: Where): boolean {
  return Object.entries(where).every(([key, value]) => {
    if (key === "OR") return (value as Where[]).some((w) => matches(item, w));
    if (key === "AND") return (value as Where[]).every((w) => matches(item, w));
    return matchValue(item[key], value);
  });
}

function accountKey(where: Where) {
  return where.userId_provider_email as { userId: string; provider: string; email: string };
}

vi.mock("../db.js", () => {
  const accounts = () => db.accounts as Account[];
  const rows = () => db.rows as Row[];
  const client = {
    linkedCalendarAccount: {
      findUnique: vi.fn(async ({ where }: { where: Where }) => {
        const k = accountKey(where);
        return (
          accounts().find(
            (a) => a.userId === k.userId && a.provider === k.provider && a.email === k.email,
          ) ?? null
        );
      }),
      count: vi.fn(
        async ({ where }: { where: Where }) =>
          accounts().filter((a) => matches(a as unknown as Record<string, unknown>, where)).length,
      ),
      upsert: vi.fn(
        async (args: { where: Where; create: Partial<Account>; update: Partial<Account> }) => {
          const k = accountKey(args.where);
          const found = accounts().find(
            (a) => a.userId === k.userId && a.provider === k.provider && a.email === k.email,
          );
          if (found) {
            Object.assign(found, args.update, { updatedAt: new Date() });
            return found;
          }
          const created = {
            id: `acct-${++db.nextId}`,
            displayName: null,
            deviceSnapshotAt: null,
            updatedAt: new Date(),
            ...args.create,
          } as Account;
          accounts().push(created);
          return created;
        },
      ),
      updateMany: vi.fn(async ({ where, data }: { where: Where; data: Partial<Account> }) => {
        const hit = accounts().filter((a) =>
          matches(a as unknown as Record<string, unknown>, where),
        );
        for (const a of hit) Object.assign(a, data, { updatedAt: new Date() });
        return { count: hit.length };
      }),
    },
    calendarEvent: {
      findMany: vi.fn(async ({ where }: { where: Where }) =>
        rows().filter((r) => matches(r as unknown as Record<string, unknown>, where)),
      ),
      count: vi.fn(
        async ({ where }: { where: Where }) =>
          rows().filter((r) => matches(r as unknown as Record<string, unknown>, where)).length,
      ),
      createMany: vi.fn(async ({ data }: { data: Partial<Row>[] }) => {
        db.calls.createMany += 1;
        for (const d of data) rows().push({ id: `row-${++db.nextId}`, ...d } as Row);
        return { count: data.length };
      }),
      updateMany: vi.fn(async ({ where, data }: { where: Where; data: Partial<Row> }) => {
        db.calls.update += 1;
        const hit = rows().filter((r) => matches(r as unknown as Record<string, unknown>, where));
        for (const r of hit) Object.assign(r, data);
        return { count: hit.length };
      }),
      deleteMany: vi.fn(async ({ where }: { where: Where }) => {
        const keep = rows().filter((r) => !matches(r as unknown as Record<string, unknown>, where));
        const count = rows().length - keep.length;
        db.rows = keep;
        return { count };
      }),
    },
    attentionItem: {
      updateMany: vi.fn(async ({ where, data }: { where: Where; data: Partial<Attention> }) => {
        const hit = (db.attention as Attention[]).filter((a) =>
          matches(a as unknown as Record<string, unknown>, where),
        );
        for (const a of hit) Object.assign(a, data);
        return { count: hit.length };
      }),
    },
  };
  const prisma = {
    ...client,
    // A thrown error rolls the fake back, as Postgres rolls the transaction back.
    $transaction: vi.fn(async (fn: (tx: typeof client) => Promise<unknown>) => {
      const before = structuredClone({ a: db.accounts, r: db.rows, t: db.attention });
      try {
        return await fn(client);
      } catch (err) {
        db.accounts = before.a;
        db.rows = before.r;
        db.attention = before.t;
        throw err;
      }
    }),
  };
  return { prisma, db: prisma, INTERACTIVE_TX_OPTIONS: {} };
});
vi.mock("../sentry.js", () => ({ captureError: db.captureError }));

import {
  _resetDeviceValveReportsForTests,
  DEVICE_ROW_RETENTION_DAYS,
  ingestDeviceSnapshot,
} from "../pim/device-calendar/device-ingest.js";
import {
  type DeviceSnapshot,
  type DeviceSnapshotBody,
  normaliseDeviceSnapshot,
} from "../pim/device-calendar/device-snapshot.js";
import {
  DEVICE_MAX_ROWS_PER_SOURCE,
  DEVICE_MAX_ROWS_PER_USER,
  DEVICE_MAX_SOURCES_PER_USER,
  deviceSourceEmail,
} from "../pim/device-calendar/device-sources.js";

const NOW = new Date("2026-10-02T03:00:00.000Z");
const KEY = "a".repeat(64);
const OTHER_KEY = "b".repeat(64);
const WINDOW = {
  start: new Date("2026-10-01T15:00:00.000Z"),
  end: new Date("2026-10-31T15:00:00.000Z"),
};

function fields(title: string, day: number) {
  const start = new Date(Date.UTC(2026, 9, day, 1, 0));
  return {
    title,
    description: null,
    startTime: start,
    endTime: new Date(start.getTime() + 3_600_000),
    location: null,
    meetingLink: null,
    allDay: false,
  };
}

function snapshot(
  events: Array<[string, number]>,
  title = "Work",
  snapshotAt: Date = NOW,
): DeviceSnapshot {
  return {
    window: WINDOW,
    snapshotAt,
    calendarTitle: title,
    events: events.map(([externalId, day]) => ({
      externalId,
      fields: fields(`T ${externalId}`, day),
    })),
    skipped: 0,
  };
}

const rows = () => db.rows as Row[];
const accounts = () => db.accounts as Account[];
const externalIds = (filter: (r: Row) => boolean = () => true) =>
  rows()
    .filter(filter)
    .map((r) => r.externalId)
    .sort();

function foreignRow(init: Partial<Row>): Row {
  return {
    id: `foreign-${++db.nextId}`,
    userId: "u1",
    provider: "DEVICE",
    externalId: "x1",
    sourceAccountId: "acct-other",
    sourceKey: "acct-other",
    ...fields("Other", 5),
    ...init,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  db.accounts = [];
  db.rows = [];
  db.attention = [];
  db.nextId = 0;
  db.calls = { update: 0, createMany: 0 };
  _resetDeviceValveReportsForTests();
});

describe("the first snapshot of a calendar is its opt-in", () => {
  it("creates the DEVICE source, keyed by the device's key, titled, and its rows", async () => {
    const out = await ingestDeviceSnapshot(
      "u1",
      KEY,
      snapshot([
        ["e1", 5],
        ["e2", 6],
      ]),
      NOW,
    );

    expect(out).toMatchObject({ kind: "stored", created: 2, updated: 0, removed: 0 });
    expect(accounts()).toEqual([
      expect.objectContaining({
        userId: "u1",
        provider: "DEVICE",
        email: deviceSourceEmail(KEY),
        displayName: "Work",
      }),
    ]);
    const acct = accounts()[0]?.id;
    expect(rows()).toHaveLength(2);
    for (const row of rows()) {
      expect(row).toMatchObject({
        userId: "u1",
        provider: "DEVICE",
        sourceAccountId: acct,
        sourceKey: acct, // C2's CHECK: sourceKey = COALESCE(sourceAccountId, 'primary')
      });
    }
  });

  it("the source email is the key with a prefix no real address can have", () => {
    expect(deviceSourceEmail(KEY)).toBe(`device:${KEY}`);
  });

  it(`refuses a NEW source past ${DEVICE_MAX_SOURCES_PER_USER} per user, but always takes a known one`, async () => {
    for (let i = 0; i < DEVICE_MAX_SOURCES_PER_USER; i++) {
      accounts().push({
        id: `cap-${i}`,
        userId: "u1",
        provider: "DEVICE",
        email: deviceSourceEmail(i.toString(16).padStart(64, "0")),
        displayName: null,
        updatedAt: NOW,
      });
    }
    expect(await ingestDeviceSnapshot("u1", KEY, snapshot([["e1", 5]]), NOW)).toEqual({
      kind: "over-cap",
    });
    expect(rows()).toHaveLength(0);

    const known = deviceSourceEmail("0".repeat(64));
    expect(accounts().some((a) => a.email === known)).toBe(true);
    const out = await ingestDeviceSnapshot("u1", "0".repeat(64), snapshot([["e1", 5]]), NOW);
    expect(out.kind).toBe("stored");
  });

  it("another user's sources do not count toward the cap", async () => {
    for (let i = 0; i < DEVICE_MAX_SOURCES_PER_USER; i++) {
      accounts().push({
        id: `cap-${i}`,
        userId: "u2",
        provider: "DEVICE",
        email: deviceSourceEmail(i.toString(16).padStart(64, "0")),
        displayName: null,
        updatedAt: NOW,
      });
    }
    expect((await ingestDeviceSnapshot("u1", KEY, snapshot([["e1", 5]]), NOW)).kind).toBe("stored");
  });
});

describe("a later snapshot is the whole truth for its window and source", () => {
  it("updates a changed event, leaves an unchanged one alone, adds a new one", async () => {
    await ingestDeviceSnapshot(
      "u1",
      KEY,
      snapshot([
        ["e1", 5],
        ["e2", 6],
      ]),
      NOW,
    );
    const next = snapshot([
      ["e1", 5],
      ["e2", 7],
      ["e3", 8],
    ]);

    const out = await ingestDeviceSnapshot("u1", KEY, next, NOW);

    expect(out).toMatchObject({ kind: "stored", created: 1, updated: 1, removed: 0 });
    expect(
      rows()
        .find((r) => r.externalId === "e2")
        ?.startTime.toISOString(),
    ).toBe("2026-10-07T01:00:00.000Z");
    expect(externalIds()).toEqual(["e1", "e2", "e3"]);
  });

  it("an event moved into the window from outside it updates its row, never a second one", async () => {
    await ingestDeviceSnapshot("u1", KEY, snapshot([["e1", 5]]), NOW);
    const row = rows()[0] as Row;
    row.startTime = new Date("2026-12-01T00:00:00Z");
    row.endTime = new Date("2026-12-01T01:00:00Z");

    await ingestDeviceSnapshot("u1", KEY, snapshot([["e1", 9]]), NOW);

    expect(rows()).toHaveLength(1);
    expect(rows()[0]?.startTime.toISOString()).toBe("2026-10-09T01:00:00.000Z");
  });

  it("removes a row the snapshot lacks and resolves its open attention items", async () => {
    await ingestDeviceSnapshot(
      "u1",
      KEY,
      snapshot([
        ["e1", 5],
        ["e2", 6],
        ["e3", 7],
      ]),
      NOW,
    );
    const gone = rows().find((r) => r.externalId === "e2") as Row;
    db.attention = [
      { id: "att-1", userId: "u1", source: "CALENDAR_EVENT", sourceId: gone.id, status: "OPEN" },
      { id: "att-2", userId: "u1", source: "CALENDAR_EVENT", sourceId: gone.id, status: "DONE" },
    ];

    const out = await ingestDeviceSnapshot(
      "u1",
      KEY,
      snapshot([
        ["e1", 5],
        ["e3", 7],
      ]),
      NOW,
    );

    expect(out).toMatchObject({ kind: "stored", removed: 1, resolved: 1, valveRefused: false });
    expect(externalIds()).toEqual(["e1", "e3"]);
    expect((db.attention as Attention[]).map((a) => a.status)).toEqual(["RESOLVED", "DONE"]);
  });

  it("never removes a row of the source that lies outside the window", async () => {
    await ingestDeviceSnapshot(
      "u1",
      KEY,
      snapshot([
        ["e1", 5],
        ["e2", 6],
      ]),
      NOW,
    );
    const past = rows().find((r) => r.externalId === "e2") as Row;
    // Before the window, but within the retention period.
    past.startTime = new Date("2026-09-28T00:00:00Z");
    past.endTime = new Date("2026-09-28T01:00:00Z");

    await ingestDeviceSnapshot("u1", KEY, snapshot([["e1", 5]]), NOW);

    expect(externalIds()).toEqual(["e1", "e2"]);
  });
});

describe("snapshot authority is scoped to its own source", () => {
  it("never removes or rewrites another source's, provider's or user's rows", async () => {
    await ingestDeviceSnapshot("u1", KEY, snapshot([["e1", 5]]), NOW);
    rows().push(
      // Same user, another device calendar, same external id and inside the window.
      foreignRow({ externalId: "e1" }),
      foreignRow({ externalId: "z1" }),
      // Same user, another provider.
      foreignRow({
        provider: "ICLOUD",
        externalId: "z2",
        sourceAccountId: "acct-ic",
        sourceKey: "acct-ic",
      }),
      // The primary calendar.
      foreignRow({
        provider: "GOOGLE",
        externalId: "z3",
        sourceAccountId: null,
        sourceKey: "primary",
      }),
      // Another user's row on the same account id (cannot happen; the scope still holds).
      foreignRow({ userId: "u2", externalId: "z4", sourceAccountId: accounts()[0]?.id ?? "" }),
    );

    // An empty snapshot of a 1-row source: 1 removal is under the valve's minimum.
    await ingestDeviceSnapshot("u1", KEY, snapshot([]), NOW);

    expect(externalIds()).toEqual(["e1", "z1", "z2", "z3", "z4"]);
    expect(rows().find((r) => r.externalId === "e1")?.sourceAccountId).toBe("acct-other");
    expect(rows().find((r) => r.externalId === "z4")?.title).toBe("Other");
  });

  it("a second calendar's first snapshot neither sees nor moves the first one's rows", async () => {
    await ingestDeviceSnapshot(
      "u1",
      KEY,
      snapshot([
        ["e1", 5],
        ["e2", 6],
      ]),
      NOW,
    );
    await ingestDeviceSnapshot("u1", OTHER_KEY, snapshot([["e1", 9]], "Family"), NOW);

    expect(accounts().map((a) => a.displayName)).toEqual(["Work", "Family"]);
    const [work, family] = accounts();
    expect(externalIds((r) => r.sourceAccountId === work?.id)).toEqual(["e1", "e2"]);
    expect(externalIds((r) => r.sourceAccountId === family?.id)).toEqual(["e1"]);
    expect(
      rows()
        .find((r) => r.sourceAccountId === work?.id && r.externalId === "e1")
        ?.startTime.getUTCDate(),
    ).toBe(5);
  });

  it("another user's row is never taken for this source's row, even under the same account and external id", async () => {
    await ingestDeviceSnapshot("u1", KEY, snapshot([["e0", 4]]), NOW);
    const acct = accounts()[0]?.id ?? "";
    rows().push(
      foreignRow({ userId: "u2", externalId: "e1", sourceAccountId: acct, sourceKey: acct }),
    );

    await ingestDeviceSnapshot(
      "u1",
      KEY,
      snapshot([
        ["e0", 4],
        ["e1", 5],
      ]),
      NOW,
    );

    expect(externalIds((r) => r.userId === "u1")).toEqual(["e0", "e1"]);
    expect(rows().find((r) => r.userId === "u2")?.title).toBe("Other");
  });

  it("the same key under another user is another source", async () => {
    await ingestDeviceSnapshot("u1", KEY, snapshot([["e1", 5]]), NOW);
    await ingestDeviceSnapshot("u2", KEY, snapshot([]), NOW);

    expect(accounts().map((a) => a.userId)).toEqual(["u1", "u2"]);
    expect(externalIds((r) => r.userId === "u1")).toEqual(["e1"]);
  });
});

describe("the deletion valve (C3's rule)", () => {
  async function seed(count: number) {
    const ids: Array<[string, number]> = Array.from({ length: count }, (_, i) => [`e${i}`, 3 + i]);
    await ingestDeviceSnapshot("u1", KEY, snapshot(ids), NOW);
    return ids;
  }

  it("refuses removing more than half of the window's rows when that is over 5, keeps the upserts", async () => {
    const ids = await seed(8);
    // A transient empty answer would remove all 8: refused; the new event still lands.
    const out = await ingestDeviceSnapshot("u1", KEY, snapshot([["new", 20]]), NOW);

    expect(out).toMatchObject({ kind: "stored", created: 1, removed: 0, valveRefused: true });
    expect(rows()).toHaveLength(ids.length + 1);
    expect(db.captureError).toHaveBeenCalledTimes(1);
    expect(db.captureError.mock.calls[0]?.[1]).toMatchObject({
      tags: { scope: "calendar.device.deletion_valve" },
    });
  });

  it("reports a refusal once per source per process", async () => {
    await seed(8);
    await ingestDeviceSnapshot("u1", KEY, snapshot([]), NOW);
    await ingestDeviceSnapshot("u1", KEY, snapshot([]), NOW);
    expect(db.captureError).toHaveBeenCalledTimes(1);
  });

  it("allows a removal of at most 5 rows whatever its share", async () => {
    await seed(5);
    const out = await ingestDeviceSnapshot("u1", KEY, snapshot([]), NOW);
    expect(out).toMatchObject({ removed: 5, valveRefused: false });
    expect(rows()).toHaveLength(0);
  });

  it("allows removing exactly half of the rows in the window", async () => {
    const ids = await seed(12);
    const out = await ingestDeviceSnapshot("u1", KEY, snapshot(ids.slice(0, 6)), NOW);
    expect(out).toMatchObject({ removed: 6, valveRefused: false });
  });

  it("refuses one more than half", async () => {
    const ids = await seed(12);
    const out = await ingestDeviceSnapshot("u1", KEY, snapshot(ids.slice(0, 5)), NOW);
    expect(out).toMatchObject({ removed: 0, valveRefused: true });
    expect(rows()).toHaveLength(12);
  });
});

describe("retention: rows no window can reach any more are removed (P4)", () => {
  it(`removes the source's rows that ended over ${DEVICE_ROW_RETENTION_DAYS} days ago, and nothing else`, async () => {
    await ingestDeviceSnapshot("u1", KEY, snapshot([["e1", 5]]), NOW);
    const acct = accounts()[0]?.id ?? "";
    const daysAgo = (days: number) => new Date(NOW.getTime() - days * 86_400_000);
    const old = (externalId: string, days: number, init: Partial<Row> = {}) =>
      foreignRow({
        externalId,
        sourceAccountId: acct,
        sourceKey: acct,
        startTime: daysAgo(days + 1),
        endTime: daysAgo(days),
        ...init,
      });
    rows().push(
      old("expired", DEVICE_ROW_RETENTION_DAYS + 1),
      old("recent", DEVICE_ROW_RETENTION_DAYS - 1),
      old("other-source", 60, { sourceAccountId: "acct-other", sourceKey: "acct-other" }),
      old("other-user", 60, { userId: "u2" }),
    );
    const expiredId = rows().find((r) => r.externalId === "expired")?.id ?? "";
    db.attention = [
      { id: "att-x", userId: "u1", source: "CALENDAR_EVENT", sourceId: expiredId, status: "OPEN" },
    ];

    const out = await ingestDeviceSnapshot("u1", KEY, snapshot([["e1", 5]]), NOW);

    expect(out).toMatchObject({ kind: "stored", expired: 1, removed: 0, valveRefused: false });
    expect(externalIds()).toEqual(["e1", "other-source", "other-user", "recent"]);
    expect((db.attention as Attention[])[0]?.status).toBe("RESOLVED");
  });
});

describe("a snapshot older than the last one applied is ignored (stale overwrite)", () => {
  const EARLY = new Date("2026-10-02T02:00:00.000Z");
  const LATE = new Date("2026-10-02T02:30:00.000Z");

  it("changes nothing: rows, title and the stored snapshot time stay the newer one's", async () => {
    await ingestDeviceSnapshot(
      "u1",
      KEY,
      snapshot(
        [
          ["e1", 5],
          ["e2", 6],
        ],
        "Work",
        LATE,
      ),
      NOW,
    );
    const before = structuredClone({ rows: db.rows, accounts: db.accounts });

    const out = await ingestDeviceSnapshot(
      "u1",
      KEY,
      snapshot([["e9", 9]], "Old title", EARLY),
      NOW,
    );

    expect(out).toEqual({ kind: "stale" });
    expect(db.rows).toEqual(before.rows);
    expect(db.accounts).toEqual(before.accounts);
    expect(accounts()[0]?.deviceSnapshotAt?.toISOString()).toBe(LATE.toISOString());
  });

  it("records the time of each applied snapshot, and takes a retry of the same one", async () => {
    await ingestDeviceSnapshot("u1", KEY, snapshot([["e1", 5]], "Work", EARLY), NOW);
    expect(accounts()[0]?.deviceSnapshotAt?.toISOString()).toBe(EARLY.toISOString());
    const retry = await ingestDeviceSnapshot("u1", KEY, snapshot([["e1", 5]], "Work", EARLY), NOW);
    expect(retry.kind).toBe("stored");
    await ingestDeviceSnapshot("u1", KEY, snapshot([["e2", 6]], "Work", LATE), NOW);
    expect(accounts()[0]?.deviceSnapshotAt?.toISOString()).toBe(LATE.toISOString());
    expect(externalIds()).toEqual(["e2"]);
  });

  it("is per source: another calendar's newer snapshot does not block this one", async () => {
    await ingestDeviceSnapshot("u1", OTHER_KEY, snapshot([["x", 5]], "Family", LATE), NOW);
    const out = await ingestDeviceSnapshot("u1", KEY, snapshot([["e1", 5]], "Work", EARLY), NOW);
    expect(out.kind).toBe("stored");
  });
});

describe("row caps: a source and a user hold a bounded number of rows", () => {
  it(`refuses a snapshot that would leave a source over ${DEVICE_MAX_ROWS_PER_SOURCE} rows, changing nothing`, async () => {
    // Rows of the source outside this window (so the snapshot cannot remove them).
    await ingestDeviceSnapshot("u1", KEY, snapshot([["seed", 5]]), NOW);
    const acct = accounts()[0]?.id ?? "";
    for (let i = 0; i < DEVICE_MAX_ROWS_PER_SOURCE - 1; i++) {
      rows().push(
        foreignRow({
          externalId: `old${i}`,
          sourceAccountId: acct,
          sourceKey: acct,
          startTime: new Date("2026-11-20T00:00:00Z"),
          endTime: new Date("2026-11-20T01:00:00Z"),
        }),
      );
    }
    const before = structuredClone({ rows: db.rows, accounts: db.accounts });

    const out = await ingestDeviceSnapshot(
      "u1",
      KEY,
      snapshot(
        [
          ["seed", 5],
          ["new", 6],
        ],
        "Renamed",
      ),
      NOW,
    );

    expect(out).toEqual({ kind: "over-row-cap" });
    expect(db.rows).toEqual(before.rows);
    expect(db.accounts).toEqual(before.accounts);
  });

  it("a flood of 1 ms windows stops at the source cap", async () => {
    let stored = 0;
    let refused = 0;
    for (let i = 0; i < 6; i++) {
      // Each 1 ms window an hour apart, so no snapshot can remove another's rows.
      const instant = new Date(Date.UTC(2026, 9, 10, i, 0, 0, 0));
      const body: DeviceSnapshotBody = {
        windowStart: instant.toISOString(),
        windowEnd: new Date(instant.getTime() + 1).toISOString(),
        snapshotAt: new Date(NOW.getTime() + i).toISOString(),
        calendarTitle: "Flood",
        events: Array.from({ length: 500 }, (_, n) => ({
          externalId: `w${i}-${n}`,
          title: "x",
          start: new Date(instant.getTime() - 60_000).toISOString(),
          end: new Date(instant.getTime() + 60_000).toISOString(),
          allDay: false,
        })),
      };
      const checked = normaliseDeviceSnapshot(body, NOW);
      if (!checked.ok) throw new Error(checked.reason);
      const out = await ingestDeviceSnapshot("u1", KEY, checked.snapshot, NOW);
      if (out.kind === "stored") stored += 1;
      if (out.kind === "over-row-cap") refused += 1;
    }
    expect(stored).toBeGreaterThan(0);
    expect(refused).toBeGreaterThan(0);
    expect(rows().length).toBeLessThanOrEqual(DEVICE_MAX_ROWS_PER_SOURCE);
  });

  it(`refuses a snapshot that would leave the user over ${DEVICE_MAX_ROWS_PER_USER} device rows`, async () => {
    for (let i = 0; i < DEVICE_MAX_ROWS_PER_USER; i++) {
      rows().push(foreignRow({ externalId: `u${i}` }));
    }
    // Another user's rows never count.
    rows().push(foreignRow({ userId: "u2", externalId: "theirs" }));
    const before = structuredClone({ rows: db.rows, accounts: db.accounts });

    const out = await ingestDeviceSnapshot("u1", KEY, snapshot([["e1", 5]]), NOW);

    expect(out).toEqual({ kind: "over-row-cap" });
    expect(db.rows).toEqual(before.rows);
    expect(db.accounts).toEqual(before.accounts);
    expect((await ingestDeviceSnapshot("u2", KEY, snapshot([["e1", 5]]), NOW)).kind).toBe("stored");
  });
});
