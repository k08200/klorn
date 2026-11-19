/**
 * What the reply-wait reminders say (NT0 copy spec, 2026-11-17). Pure.
 *
 *   one mail  ("wait"):   title = the person, subtitle = the subject,
 *                         body  = "3일째 답장 대기 · <reason>"
 *   several   ("digest"): title = "답장 대기 4건",
 *                         body  = "<person> · <subject>" lines, at most three,
 *                                 the last one "외 N건" when more wait
 *
 * The bell row has no subtitle column, so its message is the subtitle and the
 * body on two lines — the same two-line shape as a mail push (mail-push-content).
 *
 * A sender is shown by display name only. A From with no name shows the
 * domain, never the whole address: the digest lists several senders at once
 * on a lock screen, and an address there is more than the user needs to
 * recognise the thread.
 */

import type { NotificationPresentation } from "@klorn/contract";
import { boundedFromValue, displayNameOf, parseAddress } from "../mail/email-address.js";
import { clampText } from "../notify/clamp-text.js";
import { plainLine } from "../notify/mail-push-content.js";
import { replyWaitCopy } from "../notify/reply-wait-strings.js";

const SENDER_MAX = 40;
const SUBJECT_MAX = 36;
const REASON_MAX = 80;
/** Lines of a digest body; the last turns into "N more" when more wait. */
const DIGEST_LINES = 3;
/** How much of a field is cleaned at all before it is cut. */
const CLEAN_FACTOR = 4;
const DAY_MS = 24 * 60 * 60 * 1000;
/** Contacts the sign-in import created carry this tag; it is bookkeeping, not context. */
const AUTO_ADDED_TAG = "auto-added";
/** A contact's tags column is the user's own, but still read only this far, and only this many tags. */
const TAGS_SCAN = 400;
const TAGS_SHOWN = 3;
/** Follow-up lines listed before the "N more" line. */
const FOLLOW_UP_LINES = 3;
// A whole address inside free text (a subject, a model-written reason): shown
// as its domain, as a sender is. Bounded quantifiers over already-capped text.
const INLINE_ADDRESS = /[^\s@<>"'(),;:]{1,64}@([A-Za-z0-9-]{1,63}(?:\.[A-Za-z0-9-]{1,63}){0,8})/g;
const LINE_SEPARATOR = " · ";

export interface WaitingMail {
  id: string;
  from: string | null;
  subject: string | null;
  receivedAt: Date;
  /** The item's short reason, already resolved for the reader; the single reminder shows it. */
  reason?: string | null;
  /** The provider thread id; the single reminder carries it (NT0 `threadId`). */
  threadId?: string | null;
}

export interface ReplyWaitContent {
  kind: "wait" | "digest";
  title: string;
  /** The subject of the one mail; null for a digest. */
  subtitle: string | null;
  body: string;
  /** The bell row's message: subtitle and body on two lines, or the body. */
  message: string;
  /** The same as structured fields (contract NotificationPresentation). */
  presentation: NotificationPresentation;
}

/** The sender as the user would name them; never a whole address. */
export function senderLabel(from: string | null | undefined, language: string): string {
  const unknown = replyWaitCopy(language).unknownSender;
  if (!from) return unknown;
  const name = displayNameOnly(from);
  if (name) return name;
  const header = boundedFromValue(from).trim();
  if (!header.includes("@")) {
    const bare = plainLine(header.replace(/[<>]/g, " "), SENDER_MAX * CLEAN_FACTOR);
    return bare ? clampText(bare, SENDER_MAX) : unknown;
  }
  const domain = domainOf(parseAddress(header));
  return domain ? clampText(domain, SENDER_MAX) : unknown;
}

/** The From header's display name, cleaned and cut; "" when it has none or it is an address. */
function displayNameOnly(from: string | null): string {
  if (!from) return "";
  const name = plainLine(displayNameOf(boundedFromValue(from).trim()), SENDER_MAX * CLEAN_FACTOR);
  return name && !name.includes("@") ? clampText(name, SENDER_MAX) : "";
}

function domainOf(address: string): string {
  const at = address.lastIndexOf("@");
  return at < 0 ? "" : plainLine(address.slice(at + 1), SENDER_MAX * CLEAN_FACTOR);
}

/** Every whole address inside free text shown as its domain, as a sender is. */
export function foldInlineAddresses(text: string): string {
  return text.replace(INLINE_ADDRESS, "$1");
}

/** Plain, one line, addresses folded to their domain, cut on a word boundary. */
function freeText(value: string | null | undefined, max: number): string {
  const clean = foldInlineAddresses(plainLine(value, max * CLEAN_FACTOR));
  return clean ? clampText(clean, max) : "";
}

function subjectLabel(subject: string | null, language: string): string {
  return freeText(subject, SUBJECT_MAX) || replyWaitCopy(language).noSubject;
}

/** " (Acme, CFO)" for a known contact; the internal auto-added tag is never shown. */
export function contactContextLabel(contact: {
  company: string | null;
  role: string | null;
  tags: string | null;
}): string {
  const tags = (contact.tags ?? "")
    .slice(0, TAGS_SCAN)
    .split(",")
    .map((tag) => tag.trim())
    .filter((tag) => tag !== "" && tag.toLowerCase() !== AUTO_ADDED_TAG)
    .slice(0, TAGS_SHOWN);
  const parts = [contact.company, contact.role, ...tags]
    .map((part) => plainLine(part, SENDER_MAX))
    .filter((part) => part !== "");
  return parts.length > 0 ? ` (${parts.join(", ")})` : "";
}

export function replyWaitContent(
  mails: readonly WaitingMail[],
  language: string,
  now: Date,
): ReplyWaitContent | null {
  if (mails.length === 0) return null;
  const copy = replyWaitCopy(language);
  if (mails.length === 1) {
    const [mail] = mails;
    const days = Math.max(1, Math.floor((now.getTime() - mail.receivedAt.getTime()) / DAY_MS));
    const reason = freeText(mail.reason, REASON_MAX);
    const subtitle = subjectLabel(mail.subject, language);
    const body = reason ? `${copy.waiting(days)}${LINE_SEPARATOR}${reason}` : copy.waiting(days);
    const name = displayNameOnly(mail.from);
    return {
      kind: "wait",
      title: senderLabel(mail.from, language),
      subtitle,
      body,
      message: `${subtitle}\n${body}`,
      presentation: {
        kind: "wait",
        ...(name ? { senderDisplayName: name } : {}),
        subject: subtitle,
        reasonLine: body,
        ...(mail.threadId ? { threadId: mail.threadId } : {}),
      },
    };
  }
  const listed = mails.length > DIGEST_LINES ? mails.slice(0, DIGEST_LINES - 1) : mails;
  const lines = listed.map((m) => digestLine(m.from, m.subject, language));
  if (listed.length < mails.length) lines.push(copy.more(mails.length - listed.length));
  const body = lines.join("\n");
  return {
    kind: "digest",
    title: copy.digestTitle(mails.length),
    subtitle: null,
    body,
    message: body,
    presentation: { kind: "digest" },
  };
}

function digestLine(from: string | null, subject: string | null, language: string): string {
  return `${senderLabel(from, language)}${LINE_SEPARATOR}${subjectLabel(subject, language)}`;
}

/**
 * The follow-up suggestion (flag off): localized title over every mail, the
 * intro, then one line per mail up to FOLLOW_UP_LINES and "N more".
 */
export function followUpContent(
  rows: ReadonlyArray<{ from: string | null; subject: string | null; context: string }>,
  language: string,
  days = 3,
): { title: string; message: string } {
  const copy = replyWaitCopy(language);
  const lines = rows
    .slice(0, FOLLOW_UP_LINES)
    .map(
      (r) =>
        `${senderLabel(r.from, language)}${r.context}${LINE_SEPARATOR}${subjectLabel(r.subject, language)}`,
    );
  if (rows.length > FOLLOW_UP_LINES) lines.push(copy.more(rows.length - FOLLOW_UP_LINES));
  return {
    title: copy.followUpTitle(rows.length),
    message: [copy.followUpIntro(days), ...lines].join("\n"),
  };
}
