/**
 * Mail's reader route, /email/:id — not /email/candidates or
 * /email/subscriptions, which are lists of their own. Below 600px the reader
 * is full screen (mobile redesign PR3, MB1, LOCKED 2026-11-14): the shell
 * drops the phone header, the tab bar and the floating assistant button
 * there, and the reader's own top bar and action bar take their place — the
 * Mail v2 reader only (`user.mailV2`); the legacy reader keeps the shell.
 * Pure, so the api vitest suite can pin it.
 */

const READER_PATH = /^\/email\/([^/]+)\/?$/;
const MAIL_SUBPAGES = new Set(["candidates", "subscriptions"]);

/** The id of the mail open at `pathname`, or null when it is not the reader. */
export function mailReaderId(pathname: string | null | undefined): string | null {
  const match = READER_PATH.exec(pathname ?? "");
  if (!match || MAIL_SUBPAGES.has(match[1])) return null;
  return decodeURIComponent(match[1]);
}

export function isMailReaderPath(pathname: string | null | undefined): boolean {
  return mailReaderId(pathname) !== null;
}

/** The Mail v2 reader is open: the shell stands down below 600px. */
export function isFullScreenReader(
  pathname: string | null | undefined,
  user: { mailV2?: boolean } | null | undefined,
): boolean {
  return user?.mailV2 === true && isMailReaderPath(pathname);
}
