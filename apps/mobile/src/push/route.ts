/**
 * Where a notification tap lands. The payload is external input (FCM data /
 * APNs custom keys), so every field is validated and anything unknown lands
 * on Today. Every push carries `url` (a WEB path such as `/email/<id>` or
 * `/inbox/firewall`) and `category` (the server's NotifCategory); a mail push
 * also carries `emailId`, `route` (`/mail/<emailId>`, an app path) and, when
 * they exist, `attentionItemId` / `pendingActionId` (contract/src/push.ts
 * NativePushMailFields) — see README "Push payload".
 */
import { parseRoute, type Route } from "../router/routes";

export type PushData = Record<string, unknown>;

const ID = /^[A-Za-z0-9_-]{1,128}$/;

function idOf(value: unknown): string | null {
  return typeof value === "string" && ID.test(value) ? value : null;
}

function pathOf(value: unknown): { pathname: string; search: string } | null {
  if (typeof value !== "string" || !value.startsWith("/") || value.startsWith("//")) return null;
  try {
    const url = new URL(value, "https://app.invalid");
    if (url.origin !== "https://app.invalid") return null;
    return { pathname: url.pathname, search: url.search };
  } catch {
    return null;
  }
}

/** The web app's paths (what the server's `url` carries) → the app's routes. */
export function routeFromWebPath(path: string, search = ""): Route {
  const email = path.match(/^\/email\/([^/]+)$/)?.[1];
  if (email && idOf(decodeURIComponent(email)))
    return { name: "mail", id: decodeURIComponent(email) };
  if (path === "/inbox/firewall" || path === "/email") return { name: "mail", lane: "PUSH" };
  if (path === "/briefing" || path === "/assistant/briefing")
    return { name: "assistant", section: "briefing" };
  if (path === "/chat" || path === "/assistant/chat") return { name: "assistant", section: "chat" };
  if (path === "/inbox" || path === "/assistant/approvals")
    return { name: "assistant", section: "approvals" };
  if (path === "/inbox/receipt" || path === "/assistant/activity")
    return { name: "assistant", section: "activity" };
  const app = parseRoute(path, search);
  return app.name === "notFound" ? { name: "today" } : app;
}

export function routeFromPush(data: PushData | null | undefined): Route {
  if (!data) return { name: "today" };
  const appPath = pathOf(data.route);
  if (appPath) {
    const route = parseRoute(appPath.pathname, appPath.search);
    if (route.name !== "notFound") return route;
  }
  const pendingActionId = idOf(data.pendingActionId);
  if (pendingActionId) return { name: "assistant", section: "approvals", id: pendingActionId };
  const emailId = idOf(data.emailId);
  if (emailId) return { name: "mail", id: emailId };
  const web = pathOf(data.url);
  if (web) return routeFromWebPath(web.pathname, web.search);
  return { name: "today" };
}

/**
 * The notification action buttons: iOS UNNotificationCategory actions
 * (AppDelegate.swift) and the Android local-notification action types
 * (push/android.ts) share these ids. Decision N1 (2026-11-08): Reply (or Send
 * draft) · Later · Not urgent · Done. There is no Silent action.
 */
export const PUSH_ACTIONS = {
  /** iOS "Send draft" — opens the approval card; it never sends. */
  send: "KLORN_SEND",
  /** iOS "Reply" — opens the mail in the app. Sending stays manual. */
  reply: "KLORN_REPLY",
  /**
   * Android "Review" (before N1) — opens the approval card / the mail. No
   * longer offered; still honoured for a notification already in the tray.
   */
  review: "KLORN_REVIEW",
  later: "KLORN_LATER",
  /** Moves the mail to QUEUE (a judge learning signal, like any lane move). */
  notUrgent: "KLORN_NOT_URGENT",
  done: "KLORN_DONE",
} as const;

/** "Later" = later today, the web reader's reminder offset (web _v2/reminders.ts). */
export const LATER_MS = 4 * 3_600_000;

/**
 * The button behind a tap. A notification the app's native Android service
 * posted (android/.../push/KlornMessagingService.java) comes back through the
 * push plugin as a plain "tap" whose data names the button in `klornAction`;
 * only Later / Done / Review are honoured from it (there is no Send on Android).
 * Every other action id passes through unchanged.
 */
export function actionFromTap(actionId: string, data: PushData | null | undefined): string {
  if (actionId !== "tap") return actionId;
  const named = data?.klornAction;
  return named === PUSH_ACTIONS.later ||
    named === PUSH_ACTIONS.done ||
    named === PUSH_ACTIONS.notUrgent ||
    named === PUSH_ACTIONS.review
    ? named
    : actionId;
}

/**
 * What Later / Done act on: the mail (by email id — POST
 * /api/inbox/firewall/email/:emailId/{snooze,dismiss}, which works for any of
 * the user's mail), else the attention item when only its id came.
 */
export type TriageTarget = { emailId: string } | { attentionItemId: string };

export type PushIntent =
  | { kind: "open"; route: Route }
  /** "Send draft" / "Review" never send: they open the approval card, where the user taps Send. */
  | { kind: "review"; route: Route }
  | { kind: "snooze"; target: TriageTarget; fallback: Route }
  | { kind: "done"; target: TriageTarget; fallback: Route }
  /** "Not urgent": move the mail to QUEUE. */
  | { kind: "notUrgent"; target: TriageTarget; fallback: Route };

export function triageTargetOf(data: PushData | null | undefined): TriageTarget | null {
  const emailId = idOf(data?.emailId);
  if (emailId) return { emailId };
  const attentionItemId = idOf(data?.attentionItemId);
  return attentionItemId ? { attentionItemId } : null;
}

/**
 * What Not urgent moves: the attention item first (routes/firewall.ts POST
 * /:id, always on), else the mail by its email id (POST /email/:emailId, live
 * only while KEYBOARD_TRIAGE is on).
 */
function laneTargetOf(data: PushData | null | undefined): TriageTarget | null {
  const attentionItemId = idOf(data?.attentionItemId);
  if (attentionItemId) return { attentionItemId };
  const emailId = idOf(data?.emailId);
  return emailId ? { emailId } : null;
}

export function intentOf(actionId: string, data: PushData | null | undefined): PushIntent {
  const route = routeFromPush(data);
  const target = triageTargetOf(data);
  switch (actionId) {
    case PUSH_ACTIONS.send:
    case PUSH_ACTIONS.review: {
      // The approval card, even though a mail push's `route` is the reader.
      const pendingActionId = idOf(data?.pendingActionId);
      return {
        kind: "review",
        route: pendingActionId
          ? { name: "assistant", section: "approvals", id: pendingActionId }
          : route,
      };
    }
    case PUSH_ACTIONS.reply:
      // The mail in the reader, where Reply is one tap. Nothing is sent.
      return { kind: "open", route };
    case PUSH_ACTIONS.later:
      return target ? { kind: "snooze", target, fallback: route } : { kind: "open", route };
    case PUSH_ACTIONS.notUrgent: {
      const laneTarget = laneTargetOf(data);
      return laneTarget
        ? { kind: "notUrgent", target: laneTarget, fallback: route }
        : { kind: "open", route };
    }
    case PUSH_ACTIONS.done:
      return target ? { kind: "done", target, fallback: route } : { kind: "open", route };
    default:
      return { kind: "open", route };
  }
}
