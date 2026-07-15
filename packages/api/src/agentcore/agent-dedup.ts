/**
 * In-memory TTL dedup for agent-emitted notifications and proposals.
 *
 * Layered ON TOP of the existing DB-backed title/message dedup in
 * `autonomous-agent.ts`. Catches the case where the LLM emits multiple
 * tool calls referring to the same underlying issue within a short window
 * but with slightly different titles (e.g. "스크럼 장소 확인" vs "스크럼
 * 장소 중복 알림") that the fuzzy title hash cannot detect.
 *
 * Storage is intentionally in-process — bursts happen within one agent
 * cycle, so a TTL Map is sufficient. The DB-backed layer is still the
 * cross-restart safety net.
 */

const DEFAULT_TTL_MS = 2 * 60 * 60 * 1000; // 2h, matches NOTIFY_DEDUP_HOURS

interface DedupEntry {
  expiresAt: number;
}

const seenByUser = new Map<string, Map<string, DedupEntry>>();

function getUserMap(userId: string): Map<string, DedupEntry> {
  let m = seenByUser.get(userId);
  if (!m) {
    m = new Map();
    seenByUser.set(userId, m);
  }
  return m;
}

function pruneExpired(userMap: Map<string, DedupEntry>, now: number): void {
  for (const [key, entry] of userMap) {
    if (entry.expiresAt <= now) userMap.delete(key);
  }
}

/**
 * Returns true if `dedupKey` was recorded for `userId` and the recorded TTL
 * has not yet elapsed. Lazy-evicts the entry when expired.
 */
export function wasRecentlyDeduped(
  userId: string,
  dedupKey: string,
  now: number = Date.now(),
): boolean {
  if (!dedupKey) return false;
  const userMap = seenByUser.get(userId);
  if (!userMap) return false;
  const entry = userMap.get(dedupKey);
  if (!entry) return false;
  if (entry.expiresAt <= now) {
    userMap.delete(dedupKey);
    return false;
  }
  return true;
}

/** Record `dedupKey` for `userId` with the given TTL. */
export function recordDedupKey(
  userId: string,
  dedupKey: string,
  ttlMs: number = DEFAULT_TTL_MS,
  now: number = Date.now(),
): void {
  if (!dedupKey) return;
  const userMap = getUserMap(userId);
  pruneExpired(userMap, now);
  userMap.set(dedupKey, { expiresAt: now + ttlMs });
}

/** Test helper — clears all in-memory dedup state. */
export function __resetDedupForTests(): void {
  seenByUser.clear();
}
