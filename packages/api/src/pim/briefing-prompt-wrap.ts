/**
 * External text in the briefing PROMPT (step C7, widened to every signal
 * source). An event's title, description and location are external content:
 * anyone who can send an invite writes them; a signal title from mail is the
 * sender's subject.
 * The prompt gets them inside <untrusted_content>, like every other external
 * field the model reads. The rule-based view the user reads (the fallback, and
 * `listLocalBriefingEvents` itself) keeps the clean text, so this is applied to
 * the prompt's copy only, after the signals are computed from the clean data:
 * wrapped text would add tokens ("untrusted", "content") to the cross-link match.
 */

import { wrapUntrusted } from "../untrusted.js";
import type {
  BriefingCrossLink,
  BriefingDeadlineSignal,
  BriefingReference,
  BriefingSignals,
  BriefingTopAction,
  BriefingUrgencySignal,
} from "./briefing-signals.js";

const SUMMARY = "calendar:summary";
/** Where pim/briefing-signals.ts starts a link reason (`linkReason`). */
const SHARED_TERMS_PREFIX = "shared terms:";

type Json = Record<string, unknown>;

function isRecord(value: unknown): value is Json {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function wrapField(record: Json, key: string, source: string): Json {
  const value = record[key];
  return typeof value === "string" ? { ...record, [key]: wrapUntrusted(value, source) } : record;
}

/**
 * The events the prompt carries, with summary, description and location wrapped.
 * The shape is what `listLocalBriefingEvents` answers ({ events: [...] }); anything
 * else is passed through untouched.
 */
export function wrapEventsForPrompt(data: unknown): unknown {
  if (!isRecord(data) || !Array.isArray(data.events)) return data;
  return {
    ...data,
    events: data.events.map((event: unknown) => {
      if (!isRecord(event)) return event;
      return wrapField(
        wrapField(wrapField(event, "summary", SUMMARY), "description", "calendar:description"),
        "location",
        "calendar:location",
      );
    }),
  };
}

/** The wrapper label for a title from each source: all three are external or user-typed text. */
const TITLE_SOURCE: Record<BriefingReference["source"], string> = {
  calendar: SUMMARY,
  email: "email:subject",
  task: "task:title",
};

function wrapTitle<T extends { title: string; source: BriefingReference["source"] }>(item: T): T {
  return { ...item, title: wrapUntrusted(item.title, TITLE_SOURCE[item.source]) };
}

/**
 * "shared terms: a, b, c" lists words the cross-link matcher took from mail, task
 * and calendar text. They are single words, but still external, so the line is data.
 */
function wrapSharedTerms(reason: string): string {
  return reason.startsWith(SHARED_TERMS_PREFIX)
    ? wrapUntrusted(reason, "briefing:shared-terms")
    : reason;
}

function wrapCrossLink(link: BriefingCrossLink): BriefingCrossLink {
  return {
    ...link,
    reason: wrapSharedTerms(link.reason),
    ...(link.email ? { email: wrapTitle(link.email) } : {}),
    ...(link.task ? { task: wrapTitle(link.task) } : {}),
    ...(link.event ? { event: wrapTitle(link.event) } : {}),
  };
}

/**
 * An action that names a source item ("Prepare for: <title>", "Reply to:
 * <subject>") is wrapped as a whole field, labelled by its first reference.
 * The title is never searched for inside other text: a title such as "a" or
 * "Prepare" would otherwise wrap unrelated words.
 */
function wrapTopAction(action: BriefingTopAction): BriefingTopAction {
  const reason = wrapSharedTerms(action.reason);
  const first = action.refs[0];
  if (!first) return { ...action, reason };
  return {
    ...action,
    action: wrapUntrusted(action.action, TITLE_SOURCE[first.source]),
    reason,
    refs: action.refs.map(wrapTitle),
  };
}

/**
 * The signals the prompt carries, with every title wrapped whatever its
 * source: calendar text is written by whoever sends an invite, mail text by
 * the sender, and task text can be created from either.
 */
export function wrapSignalsForPrompt(signals: BriefingSignals): BriefingSignals {
  return {
    deadlines: signals.deadlines.map((d: BriefingDeadlineSignal) => wrapTitle(d)),
    urgentItems: signals.urgentItems.map((u: BriefingUrgencySignal) => wrapTitle(u)),
    crossLinks: signals.crossLinks.map(wrapCrossLink),
    topActions: signals.topActions.map(wrapTopAction),
  };
}
