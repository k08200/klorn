/**
 * Attention engine v3 on `GET /api/inbox/firewall` (the Mac's lanes), for a
 * user under the policy (docs/design/attention-engine-v3.md §3(5) "Reasons
 * and API contract"): the QUEUE lane in ranked order (ranking.ts rankQueue,
 * the same order as the lane page SQL) and a `v3` block on every item. Pure;
 * returns new lanes, never edits the ones it is given.
 */

import type { FirewallItem, Tier } from "@klorn/contract";
import { IMPORTANCE_PRIOR } from "./importance.js";
import { isShownHeld, type V3ItemRow, v3ItemWire } from "./item-wire.js";
import { rankQueue } from "./ranking.js";

/** The stored columns per item the ranking and the block read. */
export interface FirewallV3Row extends V3ItemRow {
  v3Importance: number | null;
}

export interface FirewallV3Input {
  /** The item's stored row, by item id. */
  rowOf: (itemId: string) => FirewallV3Row | undefined;
  /** The mail's received time, else the item's createdAt (no mail behind it). */
  receivedAtOf: (itemId: string) => Date;
  now: Date;
}

export function withV3Lanes(
  tiers: Readonly<Record<Tier, FirewallItem[]>>,
  input: FirewallV3Input,
): Record<Tier, FirewallItem[]> {
  const queue = rankQueue(
    tiers.QUEUE.map((item) => {
      const row = input.rowOf(item.id);
      return {
        id: item.id,
        item,
        receivedAt: input.receivedAtOf(item.id),
        importance: row?.v3Importance ?? IMPORTANCE_PRIOR.unknown,
        due: row?.v3Due ? row.v3Due.toISOString() : null,
        heldAt: row && isShownHeld(row) ? row.heldAt : null,
      };
    }),
    input.now,
  ).map((ranked) => ranked.item);
  const block = (item: FirewallItem, rank: number | null): FirewallItem => ({
    ...item,
    v3: v3ItemWire(input.rowOf(item.id) ?? undecided(item.tier), {
      rank,
      subject: item.email?.subject ?? null,
    }),
  });
  const lanes = Object.fromEntries(
    (Object.keys(tiers) as Tier[]).map((tier) => [
      tier,
      tier === "QUEUE"
        ? queue.map((item, index) => block(item, index + 1))
        : tiers[tier].map((item) => block(item, null)),
    ]),
  );
  return lanes as Record<Tier, FirewallItem[]>;
}

function undecided(tier: string): V3ItemRow {
  return {
    tier,
    heldAt: null,
    isManualOverride: false,
    agentTierSetAt: null,
    v3PolicyVersion: null,
    v3Decision: null,
    v3Due: null,
  };
}
