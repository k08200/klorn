/**
 * Klorn Vault: the columns each export query reads, and how a row becomes
 * what a note shows (vault-notes.ts). No query runs here; vault-export.ts
 * owns them, each scoped to the exporting user.
 */

import type { NotificationReason } from "@klorn/contract";
import { toLiveTier } from "../judge/tiers.js";
import { extractEmailAddress } from "../mail/email-address.js";
import { senderDisplayName } from "../notify/mail-push-content.js";
import { REASON_ITEM_SELECT } from "../notify/notification-reason.js";
import { offsetStringFor } from "../time-zone.js";
import type { VaultBrief, VaultMail, VaultReason, YouAction } from "./vault-notes.js";

export const ITEM_SELECT = { ...REASON_ITEM_SELECT, sourceId: true } as const;

const MAIL_COLUMNS = {
  id: true,
  gmailId: true,
  threadId: true,
  from: true,
  fromAddress: true,
  subject: true,
  snippet: true,
  receivedAt: true,
} as const;

/** The mail columns; the text only when the user asked for it. */
export function mailSelect(includeBodies: boolean) {
  return includeBodies ? { ...MAIL_COLUMNS, body: true } : MAIL_COLUMNS;
}

export const LABEL_SELECT = {
  sourceId: true,
  decidedBy: true,
  outcome: true,
  openedAt: true,
  repliedAt: true,
  archivedAt: true,
  dismissedAt: true,
  snoozedAt: true,
  starredAt: true,
  unsubscribedAt: true,
  providerRepliedAt: true,
  providerArchivedAt: true,
} as const;

export const BRIEF_SELECT = {
  threadId: true,
  whyNow: true,
  asks: true,
  weOwe: true,
  theyOwe: true,
  stance: true,
} as const;

export interface ItemRow {
  sourceId: string;
  tier: string | null;
  status: string;
  isManualOverride: boolean;
  agentTierSetAt: Date | null;
  v3PolicyVersion: string | null;
}

export interface MailRow {
  id: string;
  gmailId: string;
  threadId: string | null;
  from: string;
  fromAddress: string | null;
  subject: string;
  snippet: string | null;
  receivedAt: Date;
  body?: string | null;
}

export interface LabelRow {
  sourceId: string;
  decidedBy: string | null;
  outcome: string | null;
  openedAt: Date | null;
  repliedAt: Date | null;
  archivedAt: Date | null;
  dismissedAt: Date | null;
  snoozedAt: Date | null;
  starredAt: Date | null;
  unsubscribedAt: Date | null;
  providerRepliedAt: Date | null;
  providerArchivedAt: Date | null;
}

export interface BriefRow {
  threadId: string;
  whyNow: string;
  asks: unknown;
  weOwe: string | null;
  theyOwe: string | null;
  stance: string | null;
}

const CLASSIFIER_PATHS: ReadonlySet<string> = new Set([
  "fast-path",
  "sender-prior",
  "llm",
  "keyword-fallback",
]);
const POLICY_VERSION = /^v\d{1,2}(?:\.\d{1,2})?$/;
const MAX_ASKS = 10;

/** ISO 8601 in the user's zone, with its offset: 2026-11-12T10:04:00+09:00. */
export function isoWithOffset(date: Date, timeZone: string): string {
  const offset = offsetStringFor(date, timeZone);
  const sign = offset.startsWith("-") ? -1 : 1;
  const [hours = 0, minutes = 0] = offset.slice(1).split(":").map(Number);
  const local = new Date(date.getTime() + sign * (hours * 60 + minutes) * 60_000);
  return `${local.toISOString().slice(0, 19)}${offset}`;
}

/** YYYY-MM-DD in the user's zone. */
export function localDate(date: Date, timeZone: string): string {
  return isoWithOffset(date, timeZone).slice(0, 10);
}

function earliest(a: Date | null, b: Date | null): Date | null {
  if (!a) return b;
  if (!b) return a;
  return a < b ? a : b;
}

/** The strongest thing the user did with the mail, as the decision label recorded it. */
export function youAction(label: LabelRow | undefined): { action: YouAction; at: Date } | null {
  if (!label) return null;
  const stamps: ReadonlyArray<readonly [YouAction, Date | null]> = [
    ["replied", earliest(label.repliedAt, label.providerRepliedAt)],
    ["archived", earliest(label.archivedAt, label.providerArchivedAt)],
    ["unsubscribed", label.unsubscribedAt],
    ["dismissed", label.dismissedAt],
    ["snoozed", label.snoozedAt],
    ["starred", label.starredAt],
    ["opened", label.openedAt],
  ];
  for (const [action, at] of stamps) if (at) return { action, at };
  return null;
}

/** What set the lane: the user, an agent, or the classifier path Klorn took. */
export function judgedBy(item: ItemRow, label: LabelRow | undefined): string {
  if (item.isManualOverride) return "you";
  if (item.agentTierSetAt) return "agent";
  if (label?.decidedBy && CLASSIFIER_PATHS.has(label.decidedBy)) return label.decidedBy;
  return "klorn";
}

export function laneFeedback(label: LabelRow | undefined): "override" | "confirm" | null {
  if (label?.outcome?.startsWith("OVERRIDE:")) return "override";
  if (label?.outcome?.startsWith("CONFIRM:")) return "confirm";
  return null;
}

export function briefOf(row: BriefRow | undefined): VaultBrief | null {
  if (!row?.whyNow.trim()) return null;
  const asks = Array.isArray(row.asks)
    ? row.asks
        .filter((a): a is string => typeof a === "string" && a.trim() !== "")
        .slice(0, MAX_ASKS)
    : [];
  return { whyNow: row.whyNow, asks, weOwe: row.weOwe, theyOwe: row.theyOwe, stance: row.stance };
}

function reasonOf(reason: NotificationReason | null | undefined): VaultReason | null {
  if (!reason) return null;
  return reason.verified && reason.quote
    ? { text: reason.text, verified: true, quote: reason.quote, quoteIn: reason.quoteIn }
    : { text: reason.text, verified: false };
}

/** Text capped at `max` characters, marked when cut. */
function capBody(body: string | null | undefined, max: number): string | null | undefined {
  if (body === undefined || body === null) return body;
  return body.length > max ? `${body.slice(0, max)}\n…` : body;
}

export interface MailNoteContext {
  path: string;
  senderKey: string;
  senderPath: string;
  timeZone: string;
  includeBodies: boolean;
  maxBodyChars: number;
}

/** One mail row (with its item, label, brief and reason) as a note. */
export function toVaultMail(
  rows: {
    mail: MailRow;
    item: ItemRow;
    label: LabelRow | undefined;
    brief: BriefRow | undefined;
    reason: NotificationReason | null | undefined;
  },
  ctx: MailNoteContext,
): VaultMail {
  const { mail, item, label } = rows;
  const you = youAction(label);
  const policy =
    item.v3PolicyVersion && POLICY_VERSION.test(item.v3PolicyVersion) ? item.v3PolicyVersion : null;
  return {
    id: mail.id,
    path: ctx.path,
    subject: mail.subject,
    senderName: senderDisplayName(mail.from),
    senderAddress: mail.fromAddress ?? extractEmailAddress(mail.from),
    senderKey: ctx.senderKey,
    senderPath: ctx.senderPath,
    received: isoWithOffset(mail.receivedAt, ctx.timeZone),
    dateKey: localDate(mail.receivedAt, ctx.timeZone),
    snippet: mail.snippet,
    lane: toLiveTier(item.tier),
    reason: reasonOf(rows.reason),
    judgedBy: judgedBy(item, label),
    policy,
    status: item.status.toLowerCase(),
    laneFeedback: laneFeedback(label),
    you: you ? { action: you.action, at: isoWithOffset(you.at, ctx.timeZone) } : null,
    brief: briefOf(rows.brief),
    ...(ctx.includeBodies ? { body: capBody(mail.body ?? null, ctx.maxBodyChars) } : {}),
  };
}
