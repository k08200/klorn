/**
 * How a calendar source is named and coloured. Colour comes from the same
 * per-account tokens as SourceBadge (one colour per account everywhere in the
 * app); the name is never the only signal — the legend and each row say it.
 */
import type { InboxOption, InboxPurpose } from "@klorn/contract";
import type { MessageKey } from "../../i18n";
import { sourceStyle } from "../../ui/SourceBadge";
import type { CalendarSource } from "./model";

const PROVIDER_NAMES: Record<string, string> = {
  GOOGLE: "Google",
  OUTLOOK: "Outlook",
  ICLOUD: "iCloud",
  NAVER: "Naver",
  DEVICE: "",
  LOCAL: "",
};

/**
 * A linked Google calendar's purpose, from the inbox with the same address
 * (GET /api/auth/google/linked-calendars gives id → email).
 */
export function purposeOfLinked(
  sourceAccountId: string,
  calendars: ReadonlyArray<{ id: string; email: string }> | null | undefined,
  inboxes: readonly InboxOption[],
): InboxPurpose | null {
  const email = calendars?.find((c) => c.id === sourceAccountId)?.email?.toLowerCase();
  if (!email) return null;
  return inboxes.find((i) => i.email?.toLowerCase() === email)?.purpose ?? null;
}

export function sourceColor(source: CalendarSource, purpose: InboxPurpose | null): string {
  return sourceStyle(source.provider, purpose ?? source.purpose).colorVar;
}

type T = (key: MessageKey) => string;

/** The legend's short name: "회사" / "개인" for the primary calendar, else the account's label. */
export function legendName(source: CalendarSource, t: T): string {
  if (source.label) return source.label;
  if (source.key === "primary") {
    if (source.purpose === "work") return t("calendar.source.work");
    if (source.purpose === "personal") return t("calendar.source.personal");
    return t("calendar.source.primaryShort");
  }
  return PROVIDER_NAMES[source.provider] || t("calendar.source.device");
}

/** The row's source name: "회사 캘린더", "Outlook", "개인 캘린더". */
export function sourceName(source: CalendarSource, t: T): string {
  if (source.label) return source.label;
  if (source.key === "primary") {
    if (source.purpose === "work") return t("calendar.source.workCalendar");
    if (source.purpose === "personal") return t("calendar.source.personalCalendar");
    return t("calendar.primary");
  }
  return PROVIDER_NAMES[source.provider] || t("calendar.source.device");
}
