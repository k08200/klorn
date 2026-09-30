/**
 * Calendar text in the briefing PROMPT (step C7). An event's title, description
 * and location are external content: anyone who can send an invite writes them.
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

function wrapTitle<T extends { title: string }>(item: T): T {
  return { ...item, title: wrapUntrusted(item.title, SUMMARY) };
}

function wrapCalendarRef(ref: BriefingReference): BriefingReference {
  return ref.source === "calendar" ? wrapTitle(ref) : ref;
}

function wrapSignalTitle<T extends BriefingDeadlineSignal | BriefingUrgencySignal>(item: T): T {
  return item.source === "calendar" ? wrapTitle(item) : item;
}

function wrapCrossLink(link: BriefingCrossLink): BriefingCrossLink {
  return link.event ? { ...link, event: wrapTitle(link.event) } : link;
}

/** "Prepare for: <title>" names the event inline: wrap every occurrence of the title. */
function wrapTitleInText(text: string, title: string): string {
  return title.length === 0 ? text : text.split(title).join(wrapUntrusted(title, SUMMARY));
}

function wrapTopAction(action: BriefingTopAction): BriefingTopAction {
  const calendarRefs = action.refs.filter((ref) => ref.source === "calendar");
  if (calendarRefs.length === 0) return action;
  return {
    ...action,
    action: calendarRefs.reduce((text, ref) => wrapTitleInText(text, ref.title), action.action),
    refs: action.refs.map(wrapCalendarRef),
  };
}

/** The signals the prompt carries, with every calendar-sourced title wrapped. */
export function wrapSignalsForPrompt(signals: BriefingSignals): BriefingSignals {
  return {
    deadlines: signals.deadlines.map(wrapSignalTitle),
    urgentItems: signals.urgentItems.map(wrapSignalTitle),
    crossLinks: signals.crossLinks.map(wrapCrossLink),
    topActions: signals.topActions.map(wrapTopAction),
  };
}
