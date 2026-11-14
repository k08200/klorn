/**
 * Meeting prep linker (Context Engine slice 1): the pure part. Given the user's
 * meetings in the next 24 hours with their attendees, and the user's recent
 * mail and open commitments, say what to prep for each meeting.
 *
 * Who the meeting is with (externalCounterparts):
 *  - only a meeting the user organised or accepted (tentatively or not): an
 *    invite is untrusted input — anyone can put anyone on a guest list — so an
 *    unanswered invite links nothing;
 *  - an external attendee is a person (not a room), not the user (any of the
 *    user's addresses), outside the user's own organisation domain, not a
 *    no-reply or other automated address, and not declining;
 *  - a hidden or oversized guest list (a webinar) is skipped.
 *
 * What is tied to them (linkMeeting):
 *  - mail from an attendee's address, or from their organisation domain (never
 *    a public mail domain such as gmail.com), one item per thread. A mail tied
 *    only by domain shows only when it waits on a reply: "a colleague of the
 *    attendee wrote recently" is noise, and a forged From domain should not
 *    gain a place in prep by merely existing. Automated and bulk
 *    (List-Unsubscribe) mail is not a conversation;
 *  - open commitments with them as counterparty, or recorded in a thread of
 *    their linked mail (the user's own promises carry no counterparty address:
 *    pim/commitment-ingestion.ts sets it only for the other side's).
 *
 * Ranking: confirmed commitments by deadline, then unanswered mail by recency,
 * then unconfirmed commitments (shown as suggestions), then recent threads by
 * recency; inside each, a match on the attendee's own address before one on
 * their domain. MAX_ITEMS_PER_MEETING per meeting. Every item carries its
 * source. No model call: every line is a verified row of the user's own data.
 */

import type {
  MeetingPrep,
  MeetingPrepBlock,
  MeetingPrepItem,
  MeetingPrepMatch,
} from "@klorn/contract";
import { isAutomatedSender } from "../judge/keyword-policy.js";
import { extractEmailAddress } from "../mail/email-address.js";
import { orgDomainOf } from "../mail/public-mail-domains.js";
import { senderName } from "../notify/notification-format.js";
import type { MeetingAttendee } from "../pim/calendar-providers/types.js";
import { normalizeAttendeeEmail } from "../pim/coattendance/coattendance-rules.js";
import { stripUntrusted } from "../untrusted.js";

export const MAX_ITEMS_PER_MEETING = 3;
/** Meetings named in one block. */
export const MAX_MEETINGS_PER_BLOCK = 5;
/** How far ahead a meeting can start and still be prepped. */
export const PREP_HORIZON_MS = 24 * 60 * 60 * 1000;
/** More external people than this is a broadcast (webinar, all-hands), not a meeting to prep. */
export const MAX_EXTERNAL_ATTENDEES = 15;
/** A timed block longer than this (travel, out of office) is not a meeting. */
const MAX_MEETING_MS = 8 * 60 * 60 * 1000;
/** Attendee addresses echoed back with a meeting. */
const MAX_LISTED_ATTENDEES = 5;
const TEXT_MAX = 120;
/**
 * Characters that can hide or reorder what a line appears to say: control
 * characters, the Arabic letter mark, zero-width and bidirectional controls,
 * the word joiner and invisible operators, the BOM, and Unicode tag characters.
 */
const INVISIBLE = /[\p{Cc}؜​-‏‪-‮⁠-⁩﻿\u{e0000}-\u{e007f}]/gu;
/** What a nested marker ("<untrusted_</untrusted_content>content>") leaves after one strip pass. */
const MARKER_WORD = /untrusted_content/gi;
/** A domain fit for an `endsWith` filter: no SQL LIKE wildcard can ride along. */
const PLAIN_DOMAIN = /^[a-z0-9.-]+$/;
const ACCEPTED = new Set(["accepted", "tentative"]);

export interface OwnIdentity {
  readonly addresses: ReadonlySet<string>;
  /** Organisation domains of the user's addresses (public mail domains are never one). */
  readonly orgDomains: ReadonlySet<string>;
}

export interface PrepMeetingInput {
  /** CalendarEvent id. */
  readonly eventId: string;
  readonly title: string;
  readonly startTime: Date;
  readonly endTime: Date;
  readonly cancelled: boolean;
  readonly attendeesOmitted: boolean;
  readonly organizedBySelf: boolean;
  readonly attendees: readonly MeetingAttendee[];
}

export interface Counterparts {
  readonly addresses: readonly string[];
  readonly domains: readonly string[];
}

export interface PrepMail {
  readonly id: string;
  readonly threadId: string | null;
  readonly from: string;
  readonly fromAddress: string | null;
  readonly subject: string;
  readonly receivedAt: Date;
  /** Wants a reply the user has not sent, and was not archived, dismissed or closed. */
  readonly open: boolean;
  /** Carries List-Unsubscribe: a mailing, not a conversation. */
  readonly bulk: boolean;
}

export interface PrepCommitment {
  readonly id: string;
  readonly title: string;
  readonly owner: "USER" | "COUNTERPARTY";
  readonly counterpartyEmail: string | null;
  readonly counterpartyName: string | null;
  readonly dueAt: Date | null;
  readonly createdAt: Date;
  /** pim/commitment-confirmation.ts: confirmed by the user, or a confident extraction. */
  readonly confirmed: boolean;
  readonly threadId: string | null;
}

export interface PrepCandidates {
  /** Newest first. */
  readonly mail: readonly PrepMail[];
  readonly commitments: readonly PrepCommitment[];
}

/**
 * Plain, single-line display text: no untrusted-content marker (nested ones
 * included), no invisible or reordering characters, no newlines.
 */
export function cleanText(value: string | null | undefined): string {
  const flat = stripUntrusted(value)
    .replace(MARKER_WORD, "untrusted content")
    .replace(/\s+/g, " ")
    .replace(INVISIBLE, "")
    .trim();
  return flat.length > TEXT_MAX ? `${flat.slice(0, TEXT_MAX - 1)}…` : flat;
}

/** An item that asks something of the user: a confirmed commitment, or mail awaiting a reply. */
export function isActionablePrepItem(item: MeetingPrepItem): boolean {
  return item.kind === "unanswered" || (item.kind === "commitment" && item.confirmed);
}

const domainOf = (address: string): string => address.slice(address.lastIndexOf("@") + 1);

export function ownIdentityOf(addresses: Iterable<string>): OwnIdentity {
  const own = new Set<string>();
  const orgDomains = new Set<string>();
  for (const raw of addresses) {
    const address = normalizeAttendeeEmail(raw);
    if (!address) continue;
    own.add(address);
    const org = orgDomainOf(address);
    if (org) orgDomains.add(org);
  }
  return { addresses: own, orgDomains };
}

function isPrepWindow(meeting: PrepMeetingInput, now: Date): boolean {
  const start = meeting.startTime.getTime();
  const span = meeting.endTime.getTime() - start;
  return (
    start >= now.getTime() &&
    start < now.getTime() + PREP_HORIZON_MS &&
    span > 0 &&
    span <= MAX_MEETING_MS
  );
}

/** The user organised the meeting or accepted it (tentatively or not) under any of their addresses. */
function userTakesPart(meeting: PrepMeetingInput, own: OwnIdentity): boolean {
  if (meeting.organizedBySelf) return true;
  return meeting.attendees.some((a) => {
    const address = normalizeAttendeeEmail(a.email);
    const mine = a.self || (address !== null && own.addresses.has(address));
    return mine && (a.organizer || ACCEPTED.has(a.responseStatus ?? ""));
  });
}

function externalAddress(attendee: MeetingAttendee, own: OwnIdentity): string | null {
  if (attendee.self || attendee.resource || attendee.responseStatus === "declined") return null;
  const address = normalizeAttendeeEmail(attendee.email);
  if (!address || own.addresses.has(address)) return null;
  if (own.orgDomains.has(domainOf(address)) || isAutomatedSender(address)) return null;
  return address;
}

/**
 * The meeting's external people and their organisation domains, or null when
 * the meeting is not one to prep (see the module header).
 */
export function externalCounterparts(
  meeting: PrepMeetingInput,
  own: OwnIdentity,
  now: Date,
): Counterparts | null {
  if (meeting.cancelled || meeting.attendeesOmitted || !isPrepWindow(meeting, now)) return null;
  if (!userTakesPart(meeting, own)) return null;
  const addresses = new Set<string>();
  for (const attendee of meeting.attendees) {
    const address = externalAddress(attendee, own);
    if (address) addresses.add(address);
  }
  if (addresses.size === 0 || addresses.size > MAX_EXTERNAL_ATTENDEES) return null;
  const domains = new Set<string>();
  for (const address of addresses) {
    const org = orgDomainOf(address);
    if (org && PLAIN_DOMAIN.test(org)) domains.add(org);
  }
  return { addresses: [...addresses], domains: [...domains] };
}

function matchOf(address: string | null, counterparts: Counterparts): MeetingPrepMatch | null {
  if (!address) return null;
  if (counterparts.addresses.includes(address)) return "address";
  return counterparts.domains.includes(domainOf(address)) ? "domain" : null;
}

function senderAddressOf(mail: PrepMail): string | null {
  const address = (mail.fromAddress ?? extractEmailAddress(mail.from)).trim().toLowerCase();
  return address.includes("@") ? address : null;
}

interface Ranked {
  readonly item: MeetingPrepItem;
  /** 0 confirmed commitment, 1 unanswered, 2 suggestion, 3 recent thread. */
  readonly tier: number;
  /** Within the tier, smaller first: a deadline, or minus the arrival time. */
  readonly order: number;
  readonly threadId: string | null;
}

/** The mail of these people, one per thread (the newest), with how each thread is tied. */
function linkedMail(
  mail: readonly PrepMail[],
  counterparts: Counterparts,
  own: OwnIdentity,
): Array<{ row: PrepMail; match: MeetingPrepMatch; address: string }> {
  const seenThreads = new Set<string>();
  const linked: Array<{ row: PrepMail; match: MeetingPrepMatch; address: string }> = [];
  for (const row of mail) {
    const thread = row.threadId ?? row.id;
    if (seenThreads.has(thread)) continue;
    const address = senderAddressOf(row);
    const match = matchOf(address, counterparts);
    if (!match || !address || own.addresses.has(address)) continue;
    if (row.bulk || isAutomatedSender(row.from) || isAutomatedSender(address)) continue;
    seenThreads.add(thread);
    linked.push({ row, match, address });
  }
  return linked;
}

function mailItems(linked: ReturnType<typeof linkedMail>): Ranked[] {
  return linked.flatMap(({ row, match, address }) => {
    const kind = row.open ? "unanswered" : "thread";
    // Tied by domain only: shown only while it waits on the user.
    if (kind === "thread" && match === "domain") return [];
    const item: MeetingPrepItem = {
      kind,
      from: cleanText(senderName(row.from)) || address,
      subject: cleanText(row.subject),
      receivedAt: row.receivedAt.toISOString(),
      match,
      source: { kind: "email", emailId: row.id },
    };
    return [
      {
        item,
        tier: kind === "unanswered" ? 1 : 3,
        order: -row.receivedAt.getTime(),
        threadId: row.threadId,
      },
    ];
  });
}

function commitmentItems(
  rows: readonly PrepCommitment[],
  counterparts: Counterparts,
  threadMatch: ReadonlyMap<string, MeetingPrepMatch>,
): Ranked[] {
  const ranked: Ranked[] = [];
  for (const row of rows) {
    const match =
      matchOf(row.counterpartyEmail?.trim().toLowerCase() ?? null, counterparts) ??
      (row.threadId ? threadMatch.get(row.threadId) : undefined);
    if (!match) continue;
    ranked.push({
      item: {
        kind: "commitment",
        owner: row.owner,
        title: cleanText(row.title),
        dueAt: row.dueAt ? row.dueAt.toISOString() : null,
        confirmed: row.confirmed,
        counterpartyName: row.counterpartyName ? cleanText(row.counterpartyName) : null,
        match,
        source: { kind: "commitment", commitmentId: row.id },
      },
      tier: row.confirmed ? 0 : 2,
      // A deadline first (soonest first); undated after every dated one, newest first.
      order: row.dueAt ? row.dueAt.getTime() : Number.MAX_SAFE_INTEGER - row.createdAt.getTime(),
      threadId: row.threadId,
    });
  }
  return ranked;
}

const matchRank = (r: Ranked) => (r.item.match === "address" ? 0 : 1);
const byRank = (a: Ranked, b: Ranked) =>
  a.tier - b.tier || matchRank(a) - matchRank(b) || a.order - b.order;

/** The meeting's items, most pressing first, at most MAX_ITEMS_PER_MEETING. */
export function linkMeeting(
  counterparts: Counterparts,
  candidates: PrepCandidates,
  own: OwnIdentity,
): MeetingPrepItem[] {
  const linked = linkedMail(candidates.mail, counterparts, own);
  const threadMatch = new Map<string, MeetingPrepMatch>();
  for (const { row, match } of linked) if (row.threadId) threadMatch.set(row.threadId, match);
  const commitments = commitmentItems(candidates.commitments, counterparts, threadMatch);
  const covered = new Set(commitments.flatMap((c) => (c.threadId ? [c.threadId] : [])));
  // A recent-thread item says less than the commitment from the same thread.
  const mail = mailItems(linked).filter(
    (m) => m.item.kind !== "thread" || !m.threadId || !covered.has(m.threadId),
  );
  return [...commitments, ...mail]
    .sort(byRank)
    .slice(0, MAX_ITEMS_PER_MEETING)
    .map((r) => r.item);
}

/** The prep block: meetings with at least one item, earliest first. */
export function buildPrepBlock(
  meetings: readonly PrepMeetingInput[],
  candidates: PrepCandidates,
  own: OwnIdentity,
  now: Date,
): MeetingPrepBlock {
  const prepped: MeetingPrep[] = [];
  const ordered = [...meetings].sort((a, b) => a.startTime.getTime() - b.startTime.getTime());
  for (const meeting of ordered) {
    if (prepped.length >= MAX_MEETINGS_PER_BLOCK) break;
    const counterparts = externalCounterparts(meeting, own, now);
    if (!counterparts) continue;
    const items = linkMeeting(counterparts, candidates, own);
    if (items.length === 0) continue;
    prepped.push({
      eventId: meeting.eventId,
      title: cleanText(meeting.title),
      startTime: meeting.startTime.toISOString(),
      endTime: meeting.endTime.toISOString(),
      attendees: counterparts.addresses.slice(0, MAX_LISTED_ATTENDEES),
      items,
    });
  }
  return { generatedAt: now.toISOString(), meetings: prepped };
}
