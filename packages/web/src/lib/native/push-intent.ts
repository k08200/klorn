// What a native push tap or action button does in the web app (Capacitor
// shell, Structure A). Ported from apps/mobile/src/push/route.ts, but routed to
// the web's own paths. Pure and import-free so packages/api can test it (the
// web package has no unit-test runner).
//
// The payload is external input (FCM data / APNs custom keys): every field is
// validated and anything unknown lands home. A push carries `url` (a web path
// such as `/email/<id>`) and, for mail, `emailId`, `route` (the old app's
// `/mail/<id>`, ignored here) and, when they exist, `attentionItemId` /
// `pendingActionId` (contract/src/push.ts NativePushMailFields).

export type PushData = Record<string, unknown>;

const ID = /^[A-Za-z0-9_-]{1,128}$/;
/** Characters a web path from the server may carry (no backslash, no scheme). */
const SAFE_PATH = /^\/(?!\/)[A-Za-z0-9/_\-.~%]*$/;
const SAFE_SEARCH = /^(\?[A-Za-z0-9_\-.~%=&+]*)?$/;
const HOME = "/";
const APPROVALS = "/assistant/approvals";

function idOf(value: unknown): string | null {
  return typeof value === "string" && ID.test(value) ? value : null;
}

/** A same-origin path from the payload, or null. */
function safeWebPath(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const q = value.indexOf("?");
  const path = q === -1 ? value : value.slice(0, q);
  const search = q === -1 ? "" : value.slice(q);
  if (!SAFE_PATH.test(path) || !SAFE_SEARCH.test(search)) return null;
  // Decoded, no segment may step out of its place (`..`, `%2e%2e`) or smuggle
  // a separator (`%2F`, `%5C`) — the router would resolve either elsewhere.
  for (const segment of path.split("/").slice(1)) {
    let decoded: string;
    try {
      decoded = decodeURIComponent(segment);
    } catch {
      return null;
    }
    if (decoded === ".." || decoded === "." || /[/\\]/.test(decoded)) return null;
  }
  return path + search;
}

function mailPath(emailId: string): string {
  return `/email/${encodeURIComponent(emailId)}`;
}

/** Where a plain tap lands: the mail, else the draft queue, else the server's url, else home. */
export function webPathFromPush(data: PushData | null | undefined): string {
  if (!data) return HOME;
  const emailId = idOf(data.emailId);
  if (emailId) return mailPath(emailId);
  if (idOf(data.pendingActionId)) return APPROVALS;
  return safeWebPath(data.url) ?? HOME;
}

/**
 * The action buttons: iOS UNNotificationCategory actions (AppDelegate.swift)
 * and the Android local-notification action types (android-push.ts) share
 * these ids. Decision N1 (2026-11-08): Reply (or Send draft) · Later ·
 * Not urgent · Done. There is no Silent action.
 */
export const PUSH_ACTIONS = {
  /** iOS "Send draft" — opens the draft for confirmation; it never sends. */
  send: "KLORN_SEND",
  /** iOS "Reply" — opens the mail's reply entry. Sending stays manual. */
  reply: "KLORN_REPLY",
  /** Android "Review" (before N1) — still honoured for a notification already in the tray. */
  review: "KLORN_REVIEW",
  later: "KLORN_LATER",
  /** Moves the mail to QUEUE (a judge learning signal, like any lane move). */
  notUrgent: "KLORN_NOT_URGENT",
  done: "KLORN_DONE",
} as const;

/** The old app's Later on an attention item alone: four hours (web reminders' "later today"). */
export const LATER_MS = 4 * 3_600_000;

/**
 * The button behind a tap. A notification the native Android service posted
 * (KlornMessagingService.java) comes back as a plain "tap" whose data names
 * the button in `klornAction`; only Later / Done / Not urgent / Review are
 * honoured from it (there is no Send on Android).
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

export type TriageTarget = { emailId: string } | { attentionItemId: string };

export type TriageIntent = {
  kind: "later" | "done" | "notUrgent";
  target: TriageTarget;
  /** Where to go when the request fails, so the user can act by hand. */
  fallback: string;
};

export type PushIntent =
  | { kind: "open"; path: string }
  /** "Send draft" / "Review": the draft, shown in full, where the user taps Send. */
  | { kind: "review"; path: string }
  | TriageIntent;

/** What Later / Done act on: the mail by email id, else the attention item. */
function triageTargetOf(data: PushData | null | undefined): TriageTarget | null {
  const emailId = idOf(data?.emailId);
  if (emailId) return { emailId };
  const attentionItemId = idOf(data?.attentionItemId);
  return attentionItemId ? { attentionItemId } : null;
}

/** What Not urgent moves: the attention item first (always on), else the mail. */
function laneTargetOf(data: PushData | null | undefined): TriageTarget | null {
  const attentionItemId = idOf(data?.attentionItemId);
  if (attentionItemId) return { attentionItemId };
  const emailId = idOf(data?.emailId);
  return emailId ? { emailId } : null;
}

function replyPath(data: PushData | null | undefined, fallback: string): string {
  const emailId = idOf(data?.emailId);
  return emailId ? `${mailPath(emailId)}?focus=reply` : fallback;
}

export function intentOf(actionId: string, data: PushData | null | undefined): PushIntent {
  const path = webPathFromPush(data);
  switch (actionId) {
    case PUSH_ACTIONS.send:
    case PUSH_ACTIONS.review:
      // Never sends: the draft's approval card, else the mail's reply entry.
      return {
        kind: "review",
        path: idOf(data?.pendingActionId) ? APPROVALS : replyPath(data, path),
      };
    case PUSH_ACTIONS.reply:
      return { kind: "open", path: replyPath(data, path) };
    case PUSH_ACTIONS.later:
    case PUSH_ACTIONS.done: {
      const target = triageTargetOf(data);
      const kind = actionId === PUSH_ACTIONS.later ? "later" : "done";
      return target ? { kind, target, fallback: path } : { kind: "open", path };
    }
    case PUSH_ACTIONS.notUrgent: {
      const target = laneTargetOf(data);
      return target ? { kind: "notUrgent", target, fallback: path } : { kind: "open", path };
    }
    default:
      return { kind: "open", path };
  }
}

export interface TriageRequest {
  path: string;
  body: Record<string, string> | undefined;
}

/** The one POST behind Later / Done / Not urgent — the endpoints the app already uses. */
export function triageRequest(intent: TriageIntent, now: Date): TriageRequest {
  const { target } = intent;
  const enc = encodeURIComponent;
  if ("emailId" in target) {
    const id = enc(target.emailId);
    switch (intent.kind) {
      case "later":
        // The web's Later: a "later today" reminder (routes/email-later.ts).
        return {
          path: `/api/email/${id}/later`,
          body: { remindAt: new Date(now.getTime() + LATER_MS).toISOString() },
        };
      case "done":
        return { path: `/api/inbox/firewall/email/${id}/dismiss`, body: undefined };
      case "notUrgent":
        return { path: `/api/inbox/firewall/email/${id}`, body: { tier: "QUEUE" } };
    }
  }
  const id = enc(target.attentionItemId);
  switch (intent.kind) {
    case "later":
      return {
        path: `/api/inbox/firewall/${id}/snooze`,
        body: { snoozeUntil: new Date(now.getTime() + LATER_MS).toISOString() },
      };
    case "done":
      return { path: `/api/inbox/firewall/${id}/dismiss`, body: undefined };
    case "notUrgent":
      return { path: `/api/inbox/firewall/${id}`, body: { tier: "QUEUE" } };
  }
}
