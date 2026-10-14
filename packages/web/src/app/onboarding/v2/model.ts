/**
 * Multi-provider first run (productization plan P8, ONBOARDING_V2) — the pure
 * rules: which provider tiles are drawn and what each may honestly say, what
 * an account's sync row states, how the lane totals add up, and which mails
 * the sorting check shows. No React, no fetch. Pinned by
 * packages/api/src/__tests__/web-onboarding-v2-model.test.ts.
 */

import type {
  ConnectableProvider,
  EmailLaneCounts,
  FirewallItem,
  LiveTier,
  ProviderAvailability,
} from "@klorn/contract";
import type { ConnectedAccount } from "../../../lib/connected-accounts";
import { CORE_TIERS, toLiveTier } from "../../../lib/tiers";

export const STEPS = ["connect", "sync", "review", "finish"] as const;
export type Step = (typeof STEPS)[number];

/** How a tile's connection is made. Both are the flows Settings already uses. */
export type ConnectKind = "oauth" | "form";

/**
 * Providers this client has a connect flow for. Generic IMAP is absent on
 * purpose: the server can accept one (GENERIC_IMAP_ENABLED) but the web has no
 * form for it yet, and a tile that cannot connect anything is not drawn.
 */
const CONNECT_KIND: ReadonlyMap<ConnectableProvider, ConnectKind> = new Map([
  ["GOOGLE", "oauth"],
  ["OUTLOOK", "oauth"],
  ["NAVER", "form"],
  ["ICLOUD", "form"],
]);

/** What pressing the tile's button does; `none` draws no button. */
export type TileAction = "connect" | "add" | "reconnect" | "manage" | "none";

export interface ProviderTile {
  provider: ConnectableProvider;
  kind: ConnectKind;
  /** i18n key of the one-line scope: what connecting this tile brings in. */
  scopeKey: string;
  /** i18n keys of the limits stated under the scope, in order. */
  noteKeys: string[];
  /** The accounts of this provider that are already connected. */
  accounts: ConnectedAccount[];
  action: TileAction;
}

const SCOPE_KEY: ReadonlyMap<ConnectableProvider, string> = new Map([
  ["GOOGLE", "onboardingV2.tile.google.scope"],
  ["OUTLOOK", "onboardingV2.tile.outlook.scope"],
  ["NAVER", "onboardingV2.tile.naver.scope"],
  ["ICLOUD", "onboardingV2.tile.icloud.scope"],
]);

function tileAction(
  available: ProviderAvailability,
  accounts: readonly ConnectedAccount[],
  kind: ConnectKind,
): TileAction {
  if (accounts.length === 0) return "connect";
  // The form flows (Settings' own sections) show the connected mailbox and
  // its disconnect; they have no "add a second one" form to open.
  if (kind === "form") return "manage";
  // Linking the same account again is how a revoked grant is renewed (the
  // Reconnect button in Settings runs this same flow).
  if (accounts.some((account) => account.health === "reconnect")) return "reconnect";
  return available.additionalAccounts ? "add" : "none";
}

function tileNotes(available: ProviderAvailability, action: TileAction): string[] {
  const notes: string[] = [];
  if (available.readOnly) notes.push("onboardingV2.tile.readOnly");
  // A second Google account is a linked inbox: its mail, not its calendar.
  if (available.provider === "GOOGLE" && action === "add") {
    notes.push("onboardingV2.tile.google.addNote");
  }
  return notes;
}

/**
 * One tile per provider the server offers AND this client can connect, in the
 * server's order. Scope lines claim only what pressing the tile connects: a
 * provider's calendar is named only for Google, the one calendar the same
 * consent brings in.
 */
export function providerTiles(
  available: readonly ProviderAvailability[],
  accounts: readonly ConnectedAccount[],
): ProviderTile[] {
  const tiles: ProviderTile[] = [];
  for (const entry of available) {
    const kind = CONNECT_KIND.get(entry.provider);
    const scopeKey = SCOPE_KEY.get(entry.provider);
    if (!kind || !scopeKey) continue;
    const own = accounts.filter((account) => account.provider === entry.provider);
    const action = tileAction(entry, own, kind);
    tiles.push({
      provider: entry.provider,
      kind,
      scopeKey,
      noteKeys: tileNotes(entry, action),
      accounts: own,
      action,
    });
  }
  return tiles;
}

/** Whether the primary Google grant is among the accounts (its row has no linked id). */
export function hasPrimaryGoogle(accounts: readonly ConnectedAccount[]): boolean {
  return accounts.some((account) => account.provider === "GOOGLE" && account.linkedId === null);
}

// ─── Live sync ───────────────────────────────────────────────────────────

/**
 * What a sync row can honestly state.
 *   reading    — numbers are still moving, or none has arrived yet
 *   ready      — mail is in and the count held still between reads
 *   background — connected, but this deployment reports no count for it
 *   attention  — the connection needs the user (reconnect, or the sync failed)
 */
export type SyncState = "reading" | "ready" | "background" | "attention";

export interface SyncRow {
  state: SyncState;
  /** Messages read so far; null when no number is available (yet, or at all). */
  messages: number | null;
  /** Calendar events synced; null when this account reports none. */
  events: number | null;
}

export interface SyncSignals {
  /** The primary account's sign-in sync, from the auth context. */
  initSync: { status: string; emails: number; calendar: number };
  /** This account's lane counts; null when unread or unavailable. */
  counts: EmailLaneCounts | null;
  /** The counts request failed or answered sample data: no number will come. */
  countsUnavailable: boolean;
  /** Consecutive reads in which the total did not change. */
  stableReads: number;
}

/** Reads in a row with the same total before a row is called ready. */
export const STABLE_READS_FOR_READY = 2;

export function laneTotal(counts: EmailLaneCounts): number {
  return CORE_TIERS.reduce((sum, lane) => sum + counts[lane].total, 0);
}

function primaryRow(signals: SyncSignals): SyncRow {
  const { initSync, counts } = signals;
  const counted = counts ? laneTotal(counts) : null;
  if (initSync.status === "failed") {
    return { state: "attention", messages: counted, events: null };
  }
  if (initSync.status === "done") {
    // The sync's own answer is the floor; the lane counts may already be higher.
    const messages = Math.max(initSync.emails, counted ?? 0);
    // A finished sync that brought no mail is not "mail is in": the row says
    // the account is connected and shows no number.
    if (messages === 0) return { state: "background", messages: null, events: null };
    return { state: "ready", messages, events: initSync.calendar };
  }
  if (initSync.status === "skipped") {
    return { state: "background", messages: counted, events: null };
  }
  return { state: "reading", messages: counted && counted > 0 ? counted : null, events: null };
}

/**
 * One account's row. A linked account reports no "sync in progress" of its
 * own, so its state is read from its count: nothing yet → still reading; the
 * same total twice running → ready. With no count available at all the row
 * says so instead of showing a number it does not have.
 */
export function syncRow(account: ConnectedAccount, signals: SyncSignals): SyncRow {
  if (account.health === "reconnect") {
    return { state: "attention", messages: null, events: null };
  }
  if (account.linkedId === null) return primaryRow(signals);
  if (signals.counts === null) {
    return {
      state: signals.countsUnavailable ? "background" : "reading",
      messages: null,
      events: null,
    };
  }
  const messages = laneTotal(signals.counts);
  const settled = messages > 0 && signals.stableReads >= STABLE_READS_FOR_READY;
  return {
    state: settled ? "ready" : "reading",
    messages: messages > 0 ? messages : null,
    events: null,
  };
}

/** Which headline the sync screen may use: it says mail is in only when some is. */
export type SyncHeadline = "reading" | "mailIn" | "status";

export function syncHeadline(rows: readonly SyncRow[]): SyncHeadline {
  if (rows.some((row) => row.state === "reading")) return "reading";
  return rows.some((row) => row.state === "ready") ? "mailIn" : "status";
}

/** Nothing is still being read: the user can move on without the timeout. */
export function syncSettled(rows: readonly SyncRow[]): boolean {
  return rows.length > 0 && rows.every((row) => row.state !== "reading");
}

/** Mail per lane across the accounts that reported counts; null when none did. */
export function laneTotals(
  counts: ReadonlyArray<EmailLaneCounts | null>,
): Record<LiveTier, number> | null {
  const known = counts.filter((entry): entry is EmailLaneCounts => entry !== null);
  if (known.length === 0) return null;
  const totals = new Map<LiveTier, number>(CORE_TIERS.map((lane) => [lane, 0]));
  for (const entry of known) {
    for (const lane of CORE_TIERS) {
      totals.set(lane, (totals.get(lane) ?? 0) + entry[lane].total);
    }
  }
  return Object.fromEntries(totals) as Record<LiveTier, number>;
}

// ─── Sorting check ───────────────────────────────────────────────────────

/** How many mails the sorting check shows. */
export const REVIEW_SAMPLE_SIZE = 5;

/**
 * A few mails to check, spread across lanes: one from each lane that has
 * mail (loudest lane first), then the rest in the order given, up to `max`.
 * A sample of five QUEUE mails would never show how the other lanes sort.
 */
export function reviewSample(
  items: readonly FirewallItem[],
  max: number = REVIEW_SAMPLE_SIZE,
): FirewallItem[] {
  const picked: FirewallItem[] = [];
  const taken = new Set<string>();
  const take = (item: FirewallItem | undefined) => {
    if (!item || taken.has(item.id) || picked.length >= max) return;
    taken.add(item.id);
    picked.push(item);
  };
  for (const lane of CORE_TIERS) {
    take(items.find((item) => toLiveTier(item.tier) === lane));
  }
  for (const item of items) take(item);
  return picked;
}

/**
 * The sample as the user keeps looking at it: mails already shown stay, in
 * place and as first read (classification is still trickling in while this
 * step is open, and a row must not swap or change under the cursor); new
 * arrivals only fill the remaining places.
 */
export function growSample(
  shown: readonly FirewallItem[],
  items: readonly FirewallItem[],
  max: number = REVIEW_SAMPLE_SIZE,
): FirewallItem[] {
  if (shown.length >= max) return [...shown];
  const have = new Set(shown.map((item) => item.id));
  const fresh = reviewSample(
    items.filter((item) => !have.has(item.id)),
    max - shown.length,
  );
  return [...shown, ...fresh];
}
