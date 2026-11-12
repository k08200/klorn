/**
 * The app path that opens one mail: a bell row's link and a push's url. Pure,
 * so the bell-row builders (judge/firewall-push.ts, automation-scheduler.ts)
 * depend on nothing else for it. The id is encoded, so it can never add a
 * path segment.
 */
export function mailOpenPath(emailId: string): string {
  return `/email/${encodeURIComponent(emailId)}`;
}
