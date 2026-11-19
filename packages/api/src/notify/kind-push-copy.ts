/**
 * The NT0 copy of the meet, brief, agent and acct kinds (canonical copy:
 * decide-board gen_nt.py, decided 2026-11-17). Pure: each producer reads what
 * it needs and calls these only while NOTIFY_PUSH_PRESENTATION is open to the
 * user, so the device push of every kind changes together with the APNs
 * presentation; flag off, every producer sends exactly what it did.
 *
 *   meet  — title = the event,               body = "10분 후 · Google Meet · 3명"
 *   brief — title = "오늘 브리핑",            body = "급한 메일 2 · 회의 3 · 빈 시간 5시간"
 *   agent — title = "답장 초안 준비됨 · <person>", body = the draft's first line in
 *           quotes (only while NOTIFY_PUSH_QUOTE is open: it is message text
 *           through Apple's and Google's push services), else a fixed line
 *   acct  — title = "<address> 연결 끊김",     body = "다시 연결하면 이 계정 메일도 분류합니다"
 *
 * Event titles and drafts are untrusted text: folded onto one plain line
 * (mail-push-content plainLine) and cut with clampText. A person is a display
 * name, else a domain, never a whole address (reply-wait-content senderLabel).
 * The acct address is the owner's own connected account, shown only to them.
 */

import { foldInlineAddresses, senderLabel } from "../agentcore/reply-wait-content.js";
import { clampText } from "./clamp-text.js";
import { type BriefCounts, kindPushCopy } from "./kind-push-strings.js";
import { MAIL_PUSH_REASON_MAX, plainLine, stripEdgeQuotes } from "./mail-push-content.js";
import { joinProviderName } from "./push-presentation.js";

export interface PushCopy {
  title: string;
  body: string;
}

const MEET_TITLE_MAX = 100;
const ACCOUNT_MAX = 80;
const PUSH_TITLE_MAX = 120;
/** How much of a field is cleaned before it is cut: the cut needs a little more than it keeps. */
const CLEAN_FACTOR = 4;
const SEPARATOR = " · ";

/** One plain line of untrusted text, cut on a grapheme / word boundary. */
function cleanLine(value: string | null | undefined, max: number): string {
  return clampText(plainLine(value, max * CLEAN_FACTOR), max);
}

export interface MeetCopyInput {
  eventTitle: string | null | undefined;
  /** Whole minutes until the start (rounded up, as the alert's own math). */
  startsInMinutes: number;
  /** The meeting's join link; its service is named only when it passes the join-link checks. */
  joinUrl?: string | null;
  attendeeCount?: number | null;
  language: string;
}

export function meetPushCopy(input: MeetCopyInput): PushCopy {
  const copy = kindPushCopy(input.language);
  const provider = joinProviderName(input.joinUrl);
  const count = input.attendeeCount;
  const parts = [
    copy.startsIn(Math.max(0, Math.ceil(input.startsInMinutes))),
    ...(provider ? [provider] : []),
    ...(typeof count === "number" && count > 0 ? [copy.attendees(count)] : []),
  ];
  return {
    title: cleanLine(input.eventTitle, MEET_TITLE_MAX) || copy.meetingFallbackTitle,
    body: parts.join(SEPARATOR),
  };
}

export function briefPushCopy(counts: BriefCounts, language: string): PushCopy {
  const copy = kindPushCopy(language);
  return { title: copy.briefTitle, body: copy.briefLine(counts) };
}

export interface AgentDraftCopyInput {
  /** The From header of the mail the draft answers. */
  from: string | null | undefined;
  /** The draft's text (the proposal's send_email body). */
  draft: string | null | undefined;
  /** NOTIFY_PUSH_QUOTE is open to the user. */
  allowQuote: boolean;
  language: string;
}

/**
 * The draft's first non-blank line, cleaned, without its own quotation marks,
 * any whole address in it shown as its domain ("Hi bob@acme.com," → "Hi acme.com,").
 */
function firstDraftLine(draft: string | null | undefined): string {
  const line = (draft ?? "")
    .slice(0, MAIL_PUSH_REASON_MAX * CLEAN_FACTOR)
    .split(/\r?\n/)
    .map((part) =>
      stripEdgeQuotes(foldInlineAddresses(plainLine(part, MAIL_PUSH_REASON_MAX * CLEAN_FACTOR))),
    )
    .find((part) => part !== "");
  return line ?? "";
}

export function agentDraftPushCopy(input: AgentDraftCopyInput): PushCopy {
  const copy = kindPushCopy(input.language);
  const line = input.allowQuote ? firstDraftLine(input.draft) : "";
  return {
    title: clampText(copy.draftReadyTitle(senderLabel(input.from, input.language)), PUSH_TITLE_MAX),
    body: line ? clampText(`“${line}”`, MAIL_PUSH_REASON_MAX) : copy.draftReadyLine,
  };
}

export interface AcctCopyInput {
  /** The disconnected account's address, when known (the owner's own). */
  account: string | null | undefined;
  /** The provider's product name ("Gmail", "iCloud Mail"): shown when the address is unknown. */
  label: string;
  language: string;
}

export function acctPushCopy(input: AcctCopyInput): PushCopy {
  const copy = kindPushCopy(input.language);
  const account = cleanLine(input.account, ACCOUNT_MAX) || input.label;
  return { title: copy.disconnectedTitle(account), body: copy.reconnectLine };
}
