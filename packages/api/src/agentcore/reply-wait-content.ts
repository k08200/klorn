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
const LINE_SEPARATOR = " · ";

export interface WaitingMail {
  id: string;
  from: string | null;
  subject: string | null;
  receivedAt: Date;
  /** The item's short reason, already resolved for the reader; the single reminder shows it. */
  reason?: string | null;
}

export interface ReplyWaitContent {
  kind: "wait" | "digest";
  title: string;
  /** The subject of the one mail; null for a digest. */
  subtitle: string | null;
  body: string;
  /** The bell row's message: subtitle and body on two lines, or the body. */
  message: string;
}

/** The sender as the user would name them; never a whole address. */
export function senderLabel(from: string | null | undefined, language: string): string {
  const unknown = replyWaitCopy(language).unknownSender;
  if (!from) return unknown;
  const header = boundedFromValue(from).trim();
  const name = plainLine(displayNameOf(header), SENDER_MAX * CLEAN_FACTOR);
  if (name && !name.includes("@")) return clampText(name, SENDER_MAX);
  if (!header.includes("@")) {
    const bare = plainLine(header.replace(/[<>]/g, " "), SENDER_MAX * CLEAN_FACTOR);
    return bare ? clampText(bare, SENDER_MAX) : unknown;
  }
  const domain = domainOf(parseAddress(header));
  return domain ? clampText(domain, SENDER_MAX) : unknown;
}

function domainOf(address: string): string {
  const at = address.lastIndexOf("@");
  return at < 0 ? "" : plainLine(address.slice(at + 1), SENDER_MAX * CLEAN_FACTOR);
}

function subjectLabel(subject: string | null, language: string): string {
  const clean = plainLine(subject, SUBJECT_MAX * CLEAN_FACTOR);
  return clean ? clampText(clean, SUBJECT_MAX) : replyWaitCopy(language).noSubject;
}

/** " (Acme, CFO)" for a known contact; the internal auto-added tag is never shown. */
export function contactContextLabel(contact: {
  company: string | null;
  role: string | null;
  tags: string | null;
}): string {
  const tags = (contact.tags ?? "")
    .split(",")
    .map((tag) => tag.trim())
    .filter((tag) => tag !== "" && tag.toLowerCase() !== AUTO_ADDED_TAG);
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
    const reason = mail.reason
      ? clampText(plainLine(mail.reason, REASON_MAX * CLEAN_FACTOR), REASON_MAX)
      : "";
    const subtitle = subjectLabel(mail.subject, language);
    const body = reason ? `${copy.waiting(days)}${LINE_SEPARATOR}${reason}` : copy.waiting(days);
    return {
      kind: "wait",
      title: senderLabel(mail.from, language),
      subtitle,
      body,
      message: `${subtitle}\n${body}`,
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
  };
}

function digestLine(from: string | null, subject: string | null, language: string): string {
  return `${senderLabel(from, language)}${LINE_SEPARATOR}${subjectLabel(subject, language)}`;
}

/** The follow-up suggestion (flag off): localized title, intro and one line per mail. */
export function followUpContent(
  rows: ReadonlyArray<{ from: string | null; subject: string | null; context: string }>,
  language: string,
  days = 3,
): { title: string; message: string } {
  const copy = replyWaitCopy(language);
  const lines = rows.map(
    (r) =>
      `${senderLabel(r.from, language)}${r.context}${LINE_SEPARATOR}${subjectLabel(r.subject, language)}`,
  );
  return {
    title: copy.followUpTitle(rows.length),
    message: [copy.followUpIntro(days), ...lines].join("\n"),
  };
}
