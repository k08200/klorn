/**
 * Slack PUSH bell rows a push that would not ring wrote (slack/notify.ts:
 * quiet hours, or the urgent-mail opt-out), named "slack:<episodeId>". Two
 * readers ring them late, under the rule both apply: the row still deserves it
 * unless the user replied in that Slack conversation since (the episode's
 * answeredAt). The Windows catch-up (desktop-catchup.ts) asks about the rows
 * whose live frame it held; the server's quiet-hours summary
 * (quiet-hours-summary.ts) reads the ones written inside the window.
 */

import { prisma } from "../db.js";
import { SLACK_ROW_KEY_PREFIX } from "../slack/push-strings.js";

/** The episode a will-not-ring Slack row names, or null for any other key. */
export function episodeIdOf(dedupeKey: string | null): string | null {
  return dedupeKey?.startsWith(SLACK_ROW_KEY_PREFIX)
    ? dedupeKey.slice(SLACK_ROW_KEY_PREFIX.length)
    : null;
}

/** Of these rows' episodes, the ones the user replied to in Slack since. */
async function answeredEpisodeIds(
  userId: string,
  rows: ReadonlyArray<{ dedupeKey: string | null }>,
): Promise<Set<string>> {
  const episodeIds = rows.map((row) => episodeIdOf(row.dedupeKey)).filter((id) => id !== null);
  if (episodeIds.length === 0) return new Set();
  const answered = await prisma.slackEpisode.findMany({
    where: { userId, id: { in: episodeIds }, answeredAt: { not: null } },
    select: { id: true },
  });
  return new Set(answered.map((episode) => episode.id));
}

/** These rows without the ones whose episode the user answered in Slack since. */
export async function withoutAnsweredEpisodes<T extends { dedupeKey: string | null }>(
  userId: string,
  rows: readonly T[],
): Promise<T[]> {
  if (rows.length === 0) return [];
  const answered = await answeredEpisodeIds(userId, rows);
  return rows.filter((row) => !answered.has(episodeIdOf(row.dedupeKey) ?? ""));
}
