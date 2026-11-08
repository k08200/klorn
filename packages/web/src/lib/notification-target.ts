// Where a click on a notification's stored link may go. A meeting
// notification's link can come from a calendar invite anyone can send, so it
// is untrusted: a same-origin path routes inside the app, a plain https URL
// opens in a new tab, and anything else is ignored. Free of React and Next
// imports so packages/api can test it.

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
