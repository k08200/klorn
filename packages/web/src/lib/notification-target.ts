// Where a click on a bell notification goes. A meeting notification's link can
// come from a calendar invite anyone can send, so a stored link is untrusted: a
// same-origin path routes inside the app, a plain https URL opens in a new
// tab, and anything else is ignored. Free of React and Next imports so
// packages/api can test it.

import { safeHttpsUrl, safeRelativePath } from "./safe-path";

export type NotificationLinkTarget =
  | { kind: "internal"; path: string }
  | { kind: "external"; url: string };

export function notificationLinkTarget(
  link: string | null | undefined,
): NotificationLinkTarget | null {
  const path = safeRelativePath(link);
  if (path !== null) return { kind: "internal", path };
  const url = safeHttpsUrl(link);
  if (url !== null) return { kind: "external", url };
  return null;
}

/** The fields of a bell row that decide where a click on it goes. */
export interface ClickableNotification {
  type: string;
  link?: string | null;
  sourceEmailId?: string | null;
  conversationId?: string | null;
  pendingActionId?: string | null;
  pendingActionStatus?: string | null;
}

// A row with no usable link opens its type's own surface.
const TYPE_ROUTES: Record<string, string> = {
  briefing: "/briefing",
  meeting: "/briefing",
  calendar: "/briefing",
  email: "/email",
  task: "/inbox",
  reminder: "/inbox",
  insight: "/inbox",
};
const DEFAULT_ROUTE = "/inbox";

/** Where a click on this bell row goes. */
export function notificationClickTarget(n: ClickableNotification): NotificationLinkTarget {
  const linked = notificationLinkTarget(n.link);
  if (linked) return linked;
  const internal = (path: string): NotificationLinkTarget => ({ kind: "internal", path });
  // A pending action the user still needs to approve/reject — Inbox is the one
  // place that shows every unresolved item with action buttons.
  if (n.pendingActionId && n.pendingActionStatus === "PENDING") return internal("/inbox");
  // A row that names one mail opens that mail (urgent-mail rows written before
  // they carried a link name it only by sourceEmailId).
  if (n.sourceEmailId) return internal(`/email/${encodeURIComponent(n.sourceEmailId)}`);
  if (n.conversationId) return internal("/inbox");
  return internal(TYPE_ROUTES[n.type] ?? DEFAULT_ROUTE);
}
