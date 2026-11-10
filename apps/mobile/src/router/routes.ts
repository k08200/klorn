/**
 * The typed route table — pure, no DOM. Paths are the app's deep links:
 *
 *   /today                     Today (home; "/" lands here)
 *   /mail  /mail?lane=PUSH     Mail, optionally filtered to one lane (or ALL)
 *   /mail/:id                  Mail with that email open in the reader (push taps land here)
 *   /mail/subscriptions        Subscriptions (from Mail's header menu)
 *   /calendar  /calendar/:id   Calendar, optionally with an event open
 *   /files  /files/:id         Files
 *   /assistant[/:section]      Assistant hub: approvals | briefing | activity | chat
 *   /accounts                  Accounts & sources
 *   /settings[/:section]       Settings: notifications | plans | delete-account
 *
 * Every parameter is external input (a deep link, a notification payload),
 * so it is validated here and anything malformed becomes notFound / dropped.
 */
import type { LiveTier } from "@klorn/contract";

export const TABS = ["today", "mail", "calendar", "files", "assistant"] as const;
export type Tab = (typeof TABS)[number];

export const LIVE_LANES = [
  "PUSH",
  "MEETING",
  "QUEUE",
  "INFO",
  "SILENT",
] as const satisfies readonly LiveTier[];
export type LaneParam = LiveTier | "ALL";

/** Mail's secondary pages, shown where the reader would be. */
export const MAIL_VIEWS = ["subscriptions"] as const;
export type MailView = (typeof MAIL_VIEWS)[number];

export const ASSISTANT_SECTIONS = ["approvals", "briefing", "activity", "chat"] as const;
export type AssistantSection = (typeof ASSISTANT_SECTIONS)[number];

export const SETTINGS_SECTIONS = ["notifications", "plans", "delete-account"] as const;
export type SettingsSection = (typeof SETTINGS_SECTIONS)[number];

export type Route =
  | { name: "today" }
  | { name: "mail"; lane?: LaneParam; id?: string; view?: MailView }
  | { name: "calendar"; id?: string }
  | { name: "files"; id?: string }
  | { name: "assistant"; section?: AssistantSection; id?: string }
  | { name: "accounts" }
  | { name: "settings"; section?: SettingsSection }
  | { name: "notFound"; path: string };

const ID = /^[A-Za-z0-9_-]{1,128}$/;

function validId(raw: string | undefined): string | undefined {
  if (raw === undefined) return undefined;
  let decoded: string;
  try {
    decoded = decodeURIComponent(raw);
  } catch {
    return undefined;
  }
  return ID.test(decoded) ? decoded : undefined;
}

export function isLaneParam(value: unknown): value is LaneParam {
  return value === "ALL" || (LIVE_LANES as readonly unknown[]).includes(value);
}

export function parseRoute(pathname: string, search = ""): Route {
  const clean = pathname.replace(/\/+$/, "") || "/";
  const parts = clean.split("/").filter(Boolean);
  const params = new URLSearchParams(search);
  const [head, second, third] = parts;
  const notFound: Route = { name: "notFound", path: clean };

  switch (head) {
    case undefined:
    case "today":
      return parts.length <= 1 ? { name: "today" } : notFound;
    case "mail": {
      if (parts.length > 2) return notFound;
      const laneRaw = params.get("lane")?.toUpperCase();
      const lane = isLaneParam(laneRaw) ? laneRaw : undefined;
      if (second === undefined) return lane ? { name: "mail", lane } : { name: "mail" };
      if ((MAIL_VIEWS as readonly string[]).includes(second)) {
        const view = second as MailView;
        return lane ? { name: "mail", lane, view } : { name: "mail", view };
      }
      const id = validId(second);
      if (!id) return notFound;
      return lane ? { name: "mail", lane, id } : { name: "mail", id };
    }
    case "calendar":
    case "files": {
      if (parts.length > 2) return notFound;
      if (second === undefined) return { name: head };
      const id = validId(second);
      return id ? { name: head, id } : notFound;
    }
    case "assistant": {
      if (second === undefined) return { name: "assistant" };
      if (!(ASSISTANT_SECTIONS as readonly string[]).includes(second)) return notFound;
      const section = second as AssistantSection;
      if (third === undefined)
        return parts.length === 2 ? { name: "assistant", section } : notFound;
      const id = validId(third);
      return id && parts.length === 3 ? { name: "assistant", section, id } : notFound;
    }
    case "accounts":
      return parts.length === 1 ? { name: "accounts" } : notFound;
    case "settings":
      if (second === undefined) return { name: "settings" };
      if (parts.length !== 2 || !(SETTINGS_SECTIONS as readonly string[]).includes(second))
        return notFound;
      return { name: "settings", section: second as SettingsSection };
    default:
      return notFound;
  }
}

export function formatRoute(route: Route): string {
  switch (route.name) {
    case "today":
      return "/today";
    case "mail": {
      const base = route.id
        ? `/mail/${encodeURIComponent(route.id)}`
        : route.view
          ? `/mail/${route.view}`
          : "/mail";
      return route.lane ? `${base}?lane=${route.lane}` : base;
    }
    case "calendar":
    case "files":
      return route.id ? `/${route.name}/${encodeURIComponent(route.id)}` : `/${route.name}`;
    case "assistant": {
      if (!route.section) return "/assistant";
      const base = `/assistant/${route.section}`;
      return route.id ? `${base}/${encodeURIComponent(route.id)}` : base;
    }
    case "accounts":
      return "/accounts";
    case "settings":
      return route.section ? `/settings/${route.section}` : "/settings";
    case "notFound":
      return route.path;
  }
}

/** Which bottom tab / rail item a route belongs to (null: none highlighted). */
export function tabOf(route: Route): Tab | null {
  switch (route.name) {
    case "today":
    case "mail":
    case "calendar":
    case "files":
    case "assistant":
      return route.name;
    default:
      return null;
  }
}

/** The root route of a tab. */
export function tabRoot(tab: Tab): Route {
  return { name: tab };
}

/** True when the route shows a detail (reader, event, file, approval, a Mail page). */
export function hasDetail(route: Route): boolean {
  if (route.name === "mail" && route.view !== undefined) return true;
  return "id" in route && route.id !== undefined;
}

/** The same view with its detail closed (keeps list filters such as the lane). */
export function withoutDetail(route: Route): Route {
  if (!hasDetail(route)) return route;
  const { id: _drop, view: _view, ...rest } = route as Route & { id?: string; view?: MailView };
  return rest as Route;
}

export function sameRoute(a: Route, b: Route): boolean {
  return formatRoute(a) === formatRoute(b);
}
