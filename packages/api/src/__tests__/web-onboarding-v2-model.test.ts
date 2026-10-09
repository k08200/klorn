/**
 * Multi-provider first run (productization plan P8, ONBOARDING_V2) — the pure
 * rules in packages/web/src/app/onboarding/v2/model.ts and
 * packages/web/src/lib/onboarding-return.ts: which tiles are drawn and what
 * they may say, what a sync row states, how lanes add up, which mails the
 * sorting check shows, and how an OAuth callback turns into a fixed result.
 */

import type { EmailLaneCounts, FirewallItem, ProviderAvailability } from "@klorn/contract";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  growSample,
  hasPrimaryGoogle,
  laneTotal,
  laneTotals,
  providerTiles,
  reviewSample,
  STABLE_READS_FOR_READY,
  type SyncSignals,
  syncHeadline,
  syncRow,
  syncSettled,
} from "../../../web/src/app/onboarding/v2/model";
import type { ConnectedAccount } from "../../../web/src/lib/connected-accounts";
import {
  forgetConnect,
  markConnectStarted,
  outcomeFromCallback,
  PENDING_TTL_MS,
  parseConnectResult,
  parsePending,
  pendingConnect,
  storeConnectResult,
  takeConnectResult,
} from "../../../web/src/lib/onboarding-return";

const available = (over: Partial<ProviderAvailability>): ProviderAvailability => ({
  provider: "GOOGLE",
  calendar: false,
  readOnly: false,
  additionalAccounts: true,
  ...over,
});

const account = (over: Partial<ConnectedAccount>): ConnectedAccount => ({
  scope: "primary",
  linkedId: null,
  provider: "GOOGLE",
  email: "me@gmail.com",
  nickname: null,
  needsReconnect: false,
  health: "synced",
  ...over,
});

const counts = (totals: Partial<Record<keyof EmailLaneCounts, number>>): EmailLaneCounts => ({
  PUSH: { total: totals.PUSH ?? 0, unread: 0 },
  MEETING: { total: totals.MEETING ?? 0, unread: 0 },
  QUEUE: { total: totals.QUEUE ?? 0, unread: 0 },
  INFO: { total: totals.INFO ?? 0, unread: 0 },
  SILENT: { total: totals.SILENT ?? 0, unread: 0 },
});

const signals = (over: Partial<SyncSignals>): SyncSignals => ({
  initSync: { status: "idle", emails: 0, calendar: 0 },
  counts: null,
  countsUnavailable: false,
  stableReads: 0,
  ...over,
});

const ALL = [
  available({ provider: "GOOGLE", calendar: true }),
  available({ provider: "OUTLOOK", calendar: true }),
  available({ provider: "NAVER", readOnly: true }),
  available({ provider: "ICLOUD", readOnly: true, calendar: true }),
  available({ provider: "IMAP", readOnly: true }),
];

describe("providerTiles", () => {
  it("draws one tile per offered provider, in the server's order", () => {
    expect(providerTiles([ALL[0], ALL[2]], []).map((tile) => tile.provider)).toEqual([
      "GOOGLE",
      "NAVER",
    ]);
  });

  it("draws no tile for a provider the web cannot connect (generic IMAP)", () => {
    expect(providerTiles(ALL, []).map((tile) => tile.provider)).toEqual([
      "GOOGLE",
      "OUTLOOK",
      "NAVER",
      "ICLOUD",
    ]);
  });

  it("draws nothing the server did not offer", () => {
    expect(providerTiles([], [account({})])).toEqual([]);
  });

  it("offers Connect on an empty tile, through the provider's own kind of flow", () => {
    const tiles = providerTiles(ALL, []);
    expect(tiles.map((tile) => tile.action)).toEqual(["connect", "connect", "connect", "connect"]);
    expect(tiles.map((tile) => tile.kind)).toEqual(["oauth", "oauth", "form", "form"]);
  });

  it("states read-only only where the server says no action reaches the provider", () => {
    const [google, outlook, naver, icloud] = providerTiles(ALL, []);
    expect(google.noteKeys).toEqual([]);
    expect(outlook.noteKeys).toEqual([]);
    expect(naver.noteKeys).toEqual(["onboardingV2.tile.readOnly"]);
    expect(icloud.noteKeys).toEqual(["onboardingV2.tile.readOnly"]);
    const writable = providerTiles([available({ provider: "NAVER", readOnly: false })], []);
    expect(writable[0].noteKeys).toEqual([]);
  });

  it("claims a calendar only in Google's scope line, whatever the server reports", () => {
    const keys = providerTiles(ALL, []).map((tile) => tile.scopeKey);
    expect(keys).toEqual([
      "onboardingV2.tile.google.scope",
      "onboardingV2.tile.outlook.scope",
      "onboardingV2.tile.naver.scope",
      "onboardingV2.tile.icloud.scope",
    ]);
  });

  it("groups connected accounts under their provider's tile", () => {
    const naver = account({
      scope: "n1",
      linkedId: "n1",
      provider: "NAVER",
      email: "me@naver.com",
    });
    const tiles = providerTiles(ALL, [account({}), naver]);
    expect(tiles[0].accounts).toEqual([account({})]);
    expect(tiles[2].accounts).toEqual([naver]);
    expect(tiles[1].accounts).toEqual([]);
  });

  it("offers a second Google account only when the server syncs one, and says it is mail only", () => {
    const one = providerTiles([available({ additionalAccounts: true })], [account({})])[0];
    expect(one.action).toBe("add");
    expect(one.noteKeys).toEqual(["onboardingV2.tile.google.addNote"]);
    const none = providerTiles([available({ additionalAccounts: false })], [account({})])[0];
    expect(none.action).toBe("none");
    expect(none.noteKeys).toEqual([]);
  });

  it("offers Reconnect on an OAuth provider whose account lost its grant", () => {
    const revoked = account({
      scope: "o1",
      linkedId: "o1",
      provider: "OUTLOOK",
      health: "reconnect",
    });
    expect(providerTiles([ALL[1]], [revoked])[0].action).toBe("reconnect");
  });

  it("offers Manage, not a second form, on a connected form provider", () => {
    const naver = account({ scope: "n1", linkedId: "n1", provider: "NAVER" });
    expect(providerTiles([ALL[2]], [naver])[0].action).toBe("manage");
  });
});

describe("hasPrimaryGoogle", () => {
  it("is true only for the Google row without a linked id", () => {
    expect(hasPrimaryGoogle([account({})])).toBe(true);
    expect(hasPrimaryGoogle([account({ scope: "g2", linkedId: "g2" })])).toBe(false);
    expect(hasPrimaryGoogle([account({ provider: "NAVER", scope: "n", linkedId: "n" })])).toBe(
      false,
    );
    expect(hasPrimaryGoogle([])).toBe(false);
  });
});

describe("syncRow", () => {
  const linked = account({ scope: "n1", linkedId: "n1", provider: "NAVER" });

  it("asks for attention when the account needs reconnecting, whatever else is known", () => {
    const row = syncRow(
      account({ health: "reconnect" }),
      signals({ initSync: { status: "done", emails: 9, calendar: 1 } }),
    );
    expect(row).toEqual({ state: "attention", messages: null, events: null });
  });

  it("shows no number for the primary account while its sync runs and nothing has landed", () => {
    const row = syncRow(
      account({}),
      signals({ initSync: { status: "syncing", emails: 0, calendar: 0 } }),
    );
    expect(row).toEqual({ state: "reading", messages: null, events: null });
  });

  it("shows the primary account's live count while its sync runs", () => {
    const row = syncRow(
      account({}),
      signals({
        initSync: { status: "syncing", emails: 0, calendar: 0 },
        counts: counts({ QUEUE: 12 }),
      }),
    );
    expect(row).toEqual({ state: "reading", messages: 12, events: null });
  });

  it("reports the primary sync's own numbers when it is done", () => {
    const row = syncRow(
      account({}),
      signals({ initSync: { status: "done", emails: 40, calendar: 7 } }),
    );
    expect(row).toEqual({ state: "ready", messages: 40, events: 7 });
  });

  it("never shows fewer messages than the lane counts already hold", () => {
    const row = syncRow(
      account({}),
      signals({
        initSync: { status: "done", emails: 40, calendar: 0 },
        counts: counts({ QUEUE: 55 }),
      }),
    );
    expect(row.messages).toBe(55);
  });

  it("does not say mail is in when the finished sync brought none", () => {
    const row = syncRow(
      account({}),
      signals({ initSync: { status: "done", emails: 0, calendar: 3 }, counts: counts({}) }),
    );
    expect(row).toEqual({ state: "background", messages: null, events: null });
    expect(syncHeadline([row])).toBe("status");
  });

  it("asks for attention when the primary sync failed", () => {
    const row = syncRow(
      account({}),
      signals({ initSync: { status: "failed", emails: 0, calendar: 0 } }),
    );
    expect(row.state).toBe("attention");
  });

  it("keeps a linked account reading until its count holds still", () => {
    const moving = signals({
      counts: counts({ QUEUE: 5 }),
      stableReads: STABLE_READS_FOR_READY - 1,
    });
    expect(syncRow(linked, moving)).toEqual({ state: "reading", messages: 5, events: null });
    const held = signals({ counts: counts({ QUEUE: 5 }), stableReads: STABLE_READS_FOR_READY });
    expect(syncRow(linked, held)).toEqual({ state: "ready", messages: 5, events: null });
  });

  it("does not call an empty linked account ready, however long zero has held", () => {
    const row = syncRow(linked, signals({ counts: counts({}), stableReads: 9 }));
    expect(row).toEqual({ state: "reading", messages: null, events: null });
  });

  it("says there is no count rather than inventing one", () => {
    expect(syncRow(linked, signals({ countsUnavailable: true }))).toEqual({
      state: "background",
      messages: null,
      events: null,
    });
    expect(syncRow(linked, signals({})).state).toBe("reading");
  });
});

describe("syncHeadline", () => {
  const row = (state: "reading" | "ready" | "background" | "attention") => ({
    state,
    messages: null,
    events: null,
  });

  it("says mail is in only when some account has mail in", () => {
    expect(syncHeadline([row("ready"), row("background")])).toBe("mailIn");
    expect(syncHeadline([row("background")])).toBe("status");
    expect(syncHeadline([row("attention"), row("background")])).toBe("status");
  });

  it("keeps reading while any account still is", () => {
    expect(syncHeadline([row("ready"), row("reading")])).toBe("reading");
  });
});

describe("syncSettled", () => {
  it("is true only when no row is still reading", () => {
    const row = (state: "reading" | "ready" | "background" | "attention") => ({
      state,
      messages: null,
      events: null,
    });
    expect(syncSettled([row("ready"), row("attention"), row("background")])).toBe(true);
    expect(syncSettled([row("ready"), row("reading")])).toBe(false);
    expect(syncSettled([])).toBe(false);
  });
});

describe("lane totals", () => {
  it("adds a mailbox's lanes", () => {
    expect(laneTotal(counts({ PUSH: 1, MEETING: 2, QUEUE: 3, INFO: 4, SILENT: 5 }))).toBe(15);
  });

  it("adds the accounts that reported counts and skips the ones that did not", () => {
    expect(
      laneTotals([counts({ PUSH: 1, QUEUE: 2 }), null, counts({ PUSH: 3, SILENT: 4 })]),
    ).toEqual({ PUSH: 4, MEETING: 0, QUEUE: 2, INFO: 0, SILENT: 4 });
  });

  it("is null when no account reported counts", () => {
    expect(laneTotals([null, null])).toBeNull();
    expect(laneTotals([])).toBeNull();
  });
});

describe("reviewSample", () => {
  const mail = (id: string, tier: string): FirewallItem =>
    ({ id, tier, source: "EMAIL", sourceId: `e-${id}`, title: id }) as FirewallItem;

  it("takes one mail from each lane before a second from any", () => {
    const items = [
      mail("q1", "QUEUE"),
      mail("q2", "QUEUE"),
      mail("q3", "QUEUE"),
      mail("p1", "PUSH"),
      mail("s1", "SILENT"),
      mail("i1", "INFO"),
      mail("m1", "MEETING"),
    ];
    expect(reviewSample(items).map((item) => item.id)).toEqual(["p1", "m1", "q1", "i1", "s1"]);
  });

  it("fills up from the rest when few lanes have mail, without repeating one", () => {
    const items = [mail("q1", "QUEUE"), mail("q2", "QUEUE"), mail("p1", "PUSH")];
    expect(reviewSample(items).map((item) => item.id)).toEqual(["p1", "q1", "q2"]);
  });

  it("never returns more than asked", () => {
    const items = Array.from({ length: 12 }, (_, index) => mail(`q${index}`, "QUEUE"));
    expect(reviewSample(items)).toHaveLength(5);
    expect(reviewSample(items, 2)).toHaveLength(2);
    expect(reviewSample([])).toEqual([]);
  });

  it("folds a retired lane instead of dropping the mail", () => {
    expect(reviewSample([mail("a1", "AUTO")]).map((item) => item.id)).toEqual(["a1"]);
  });
});

describe("growSample", () => {
  const mail = (id: string, tier: string): FirewallItem =>
    ({ id, tier, source: "EMAIL", sourceId: `e-${id}`, title: id }) as FirewallItem;

  it("keeps the rows already shown, in place and as first read", () => {
    const first = [mail("q1", "QUEUE")];
    const later = [mail("p1", "PUSH"), mail("q1", "INFO"), mail("q2", "QUEUE")];
    const grown = growSample(first, later);
    expect(grown.map((item) => item.id)).toEqual(["q1", "p1", "q2"]);
    expect(grown[0]).toBe(first[0]);
  });

  it("stops at the sample size and never repeats a mail", () => {
    const full = Array.from({ length: 5 }, (_, index) => mail(`a${index}`, "QUEUE"));
    expect(growSample(full, [...full, mail("z", "PUSH")])).toEqual(full);
    expect(growSample([], [])).toEqual([]);
  });
});

describe("parsePending", () => {
  const now = 1_760_000_000_000;

  it("accepts a fresh marker of a known provider", () => {
    expect(parsePending(`GOOGLE|${now - 1000}`, now)).toBe("GOOGLE");
    expect(parsePending(`OUTLOOK|${now - PENDING_TTL_MS}`, now)).toBe("OUTLOOK");
  });

  it("ignores an old marker, so an abandoned connect cannot claim a later one", () => {
    expect(parsePending(`GOOGLE|${now - PENDING_TTL_MS - 1}`, now)).toBeNull();
  });

  it("ignores anything it did not write", () => {
    expect(parsePending("GOOGLE", now)).toBeNull();
    expect(parsePending(`NAVER|${now}`, now)).toBeNull();
    expect(parsePending(`GOOGLE|${now + 60_000}`, now)).toBeNull();
    expect(parsePending(`GOOGLE|${now}|/settings`, now)).toBeNull();
    expect(parsePending("GOOGLE|1e3", now)).toBeNull();
    expect(parsePending("https://evil.example", now)).toBeNull();
    expect(parsePending(null, now)).toBeNull();
  });
});

describe("outcomeFromCallback", () => {
  it("reads the primary Google callback", () => {
    expect(outcomeFromCallback("connected", null)).toBe("connected");
    expect(outcomeFromCallback("offline_access_denied", null)).toBe("offline");
  });

  it("reads the linked-inbox callbacks", () => {
    expect(outcomeFromCallback(null, "success")).toBe("connected");
    expect(outcomeFromCallback(null, "outlook_denied")).toBe("denied");
    expect(outcomeFromCallback(null, "unverified")).toBe("unverified");
    expect(outcomeFromCallback(null, "self")).toBe("self");
    expect(outcomeFromCallback(null, "limit")).toBe("limit");
    expect(outcomeFromCallback(null, "failed")).toBe("failed");
  });

  it("treats an unknown status as a failure, never as a success", () => {
    expect(outcomeFromCallback("yes", null)).toBe("failed");
    expect(outcomeFromCallback(null, "__proto__")).toBe("failed");
    expect(outcomeFromCallback("constructor", null)).toBe("failed");
    expect(outcomeFromCallback("", null)).toBe("failed");
  });

  it("is null on an ordinary visit to Settings", () => {
    expect(outcomeFromCallback(null, null)).toBeNull();
  });
});

describe("parseConnectResult", () => {
  it("accepts only a known provider and a known outcome", () => {
    expect(parseConnectResult("GOOGLE:connected")).toEqual({
      provider: "GOOGLE",
      outcome: "connected",
    });
    expect(parseConnectResult("OUTLOOK:denied")).toEqual({
      provider: "OUTLOOK",
      outcome: "denied",
    });
    expect(parseConnectResult("NAVER:connected")).toBeNull();
    expect(parseConnectResult("GOOGLE:toString")).toBeNull();
    expect(parseConnectResult("GOOGLE:connected:https://evil.example")).toBeNull();
    expect(parseConnectResult("https://evil.example")).toBeNull();
    expect(parseConnectResult("")).toBeNull();
    expect(parseConnectResult(null)).toBeNull();
  });
});

describe("connect markers", () => {
  let store: Map<string, string>;

  beforeEach(() => {
    store = new Map();
    const session = {
      getItem: (key: string) => store.get(key) ?? null,
      setItem: (key: string, value: string) => void store.set(key, value),
      removeItem: (key: string) => void store.delete(key),
    };
    vi.stubGlobal("window", { sessionStorage: session });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("carries a result from the callback to the first run, once", () => {
    markConnectStarted("GOOGLE");
    expect(pendingConnect()).toBe("GOOGLE");
    storeConnectResult("GOOGLE", "connected");
    // The marker stays while Settings is still mounted, so its own handlers stand down.
    expect(pendingConnect()).toBe("GOOGLE");
    expect(takeConnectResult()).toEqual({ provider: "GOOGLE", outcome: "connected" });
    expect(pendingConnect()).toBeNull();
    expect(takeConnectResult()).toBeNull();
    expect(store.size).toBe(0);
  });

  it("clears an abandoned connect when the first run opens again", () => {
    markConnectStarted("OUTLOOK");
    expect(takeConnectResult()).toBeNull();
    expect(pendingConnect()).toBeNull();
  });

  it("drops an earlier result when a new connect starts", () => {
    storeConnectResult("GOOGLE", "failed");
    markConnectStarted("OUTLOOK");
    expect(takeConnectResult()).toBeNull();
  });

  it("forgets a connect whose start request failed", () => {
    markConnectStarted("GOOGLE");
    forgetConnect();
    expect(pendingConnect()).toBeNull();
  });

  it("ignores values it did not write", () => {
    store.set("klorn.onboardingV2.connect", "https://evil.example");
    store.set("klorn.onboardingV2.result", "GOOGLE:connected:/settings");
    expect(pendingConnect()).toBeNull();
    expect(takeConnectResult()).toBeNull();
  });

  it("does nothing, and throws nothing, when storage is blocked", () => {
    const broken = {
      getItem: () => {
        throw new Error("blocked");
      },
      setItem: () => {
        throw new Error("blocked");
      },
      removeItem: () => {
        throw new Error("blocked");
      },
    };
    vi.stubGlobal("window", { sessionStorage: broken });
    expect(() => markConnectStarted("GOOGLE")).not.toThrow();
    expect(pendingConnect()).toBeNull();
    expect(() => storeConnectResult("GOOGLE", "connected")).not.toThrow();
    expect(takeConnectResult()).toBeNull();
    expect(() => forgetConnect()).not.toThrow();
  });
});
