/**
 * Mail v2 reader model (productization plan P5b, MAIL_V2) — the pure half.
 * No React and no DOM, so the api vitest suite pins it
 * (packages/api/src/__tests__/web-mail-v2-model.test.ts).
 */

/**
 * Where the reader goes next: another mail (opened without marking it read,
 * like every list link) or, with no target, back to the list. `carry` holds
 * what travels along — the undo offer after an archive or delete.
 */
export function readerLeaveHref(targetId: string | null, carry?: URLSearchParams): string {
  const params = new URLSearchParams(carry);
  if (targetId) params.set("markRead", "false");
  const query = params.toString();
  const path = targetId ? `/email/${encodeURIComponent(targetId)}` : "/email";
  return query ? `${path}?${query}` : path;
}
