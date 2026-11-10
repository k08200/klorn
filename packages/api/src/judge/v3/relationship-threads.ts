/**
 * Thread math for the relationship snapshot: reply latency, reply rate and
 * who started the conversation. Pure over rows already scoped to one user and
 * one sender. Raw counts only; smoothing and weights belong to the per-user
 * importance model (doc §3(3)), never here.
 */

export interface TimedRow {
  at: Date;
  threadId: string | null;
}

type ThreadEvent = { at: number; kind: "in" | "out" };

/** A reply this long after the mail is not a reply-latency signal. */
export const MAX_REPLY_LATENCY_MS = 30 * 86_400_000;

function median(values: number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

function byThread(inbound: readonly TimedRow[], sent: readonly TimedRow[]) {
  const threads = new Map<string, ThreadEvent[]>();
  const add = (row: TimedRow, kind: ThreadEvent["kind"]) => {
    if (!row.threadId) return;
    threads.set(row.threadId, [
      ...(threads.get(row.threadId) ?? []),
      { at: row.at.getTime(), kind },
    ]);
  };
  for (const r of inbound) add(r, "in");
  for (const s of sent) add(s, "out");
  return [...threads.values()].map((events) => [...events].sort((a, b) => a.at - b.at));
}

/** Per thread, a reply answers the earliest inbound since the previous reply. */
export function medianReplyLatencyMs(
  sent: readonly TimedRow[],
  inbound: readonly TimedRow[],
): number | null {
  const latencies: number[] = [];
  for (const events of byThread(inbound, sent)) {
    let waitingSince: number | null = null;
    for (const ev of events) {
      if (ev.kind === "in") {
        waitingSince ??= ev.at;
        continue;
      }
      if (waitingSince !== null && ev.at - waitingSince <= MAX_REPLY_LATENCY_MS) {
        latencies.push(ev.at - waitingSince);
      }
      waitingSince = null;
    }
  }
  return median(latencies);
}

/** Threads with the sender's mail, and of those, how many the user answered. */
export function replyThreadCounts(
  inbound: readonly TimedRow[],
  userSentInThreads: readonly TimedRow[],
): { inboundThreadCount: number; repliedThreadCount: number } {
  const threads = byThread(inbound, userSentInThreads).filter((evs) =>
    evs.some((e) => e.kind === "in"),
  );
  const replied = threads.filter((evs) => {
    const firstIn = evs.find((e) => e.kind === "in")?.at ?? Number.POSITIVE_INFINITY;
    return evs.some((e) => e.kind === "out" && e.at > firstIn);
  });
  return { inboundThreadCount: threads.length, repliedThreadCount: replied.length };
}

/** Threads the user started: their first mail to the sender precedes any of the sender's. */
export function userInitiatedThreadCount(
  sentToSender: readonly TimedRow[],
  inbound: readonly TimedRow[],
): number {
  return byThread(inbound, sentToSender).filter((evs) => evs[0]?.kind === "out").length;
}
