/**
 * Meeting prep lines for the briefing card: each item of the server's block
 * (@klorn/contract MeetingPrep) as one line of text in the app language, with
 * a link to the item's source — the mail, or the commitment ledger. Pure, so
 * the api suite can test it (the web package has no unit-test runner).
 */

import type { MeetingPrepItem, MeetingPrepSource } from "@klorn/contract";

type Translate = (key: string, vars?: Record<string, string>) => string;

/** Commitments live in the ledger on the Approvals page. */
const COMMITMENTS_HREF = "/assistant/approvals#hub-commitments";

const K = {
  title: "assistantHub.briefing.prep.title",
  promised: "assistantHub.briefing.prep.promised",
  theyOwe: "assistantHub.briefing.prep.theyOwe",
  they: "assistantHub.briefing.prep.they",
  due: "assistantHub.briefing.prep.due",
  suggestion: "assistantHub.briefing.prep.suggestion",
  unanswered: "assistantHub.briefing.prep.unanswered",
  recent: "assistantHub.briefing.prep.recent",
  noSubject: "assistantHub.briefing.prep.noSubject",
  openMail: "assistantHub.briefing.prep.openMail",
  openCommitment: "assistantHub.briefing.prep.openCommitment",
} as const;

export const PREP_KEYS = K;
/** Every string the prep block uses; all seven locales must have each. */
export const PREP_LOCALE_KEYS: readonly string[] = Object.values(K);

export interface PrepLineView {
  readonly text: string;
  readonly href: string;
  readonly linkLabelKey: string;
}

export function prepSourceHref(source: MeetingPrepSource): string {
  return source.kind === "email"
    ? `/email/${encodeURIComponent(source.emailId)}`
    : COMMITMENTS_HREF;
}

function itemText(item: MeetingPrepItem, t: Translate, formatDay: (iso: string) => string): string {
  if (item.kind === "commitment") {
    const base =
      item.owner === "USER"
        ? t(K.promised, { title: item.title })
        : t(K.theyOwe, { who: item.counterpartyName || t(K.they), title: item.title });
    const line = item.dueAt ? `${base} ${t(K.due, { date: formatDay(item.dueAt) })}` : base;
    return item.confirmed ? line : t(K.suggestion, { line });
  }
  const vars = { from: item.from, subject: item.subject || t(K.noSubject) };
  return item.kind === "unanswered" ? t(K.unanswered, vars) : t(K.recent, vars);
}

export function prepItemLine(
  item: MeetingPrepItem,
  t: Translate,
  formatDay: (iso: string) => string,
): PrepLineView {
  return {
    text: itemText(item, t, formatDay),
    href: prepSourceHref(item.source),
    linkLabelKey: item.source.kind === "email" ? K.openMail : K.openCommitment,
  };
}
