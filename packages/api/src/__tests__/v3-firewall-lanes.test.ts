/**
 * The Mac lanes under policy v3 (judge/v3/firewall-v3.ts): QUEUE in ranked
 * order with ranks 1..n, a v3 block on every item, and the input left as is.
 */

import type { FirewallItem, Tier } from "@klorn/contract";
import { describe, expect, it } from "vitest";
import { type FirewallV3Row, withV3Lanes } from "../judge/v3/firewall-v3.js";

const NOW = new Date("2026-11-07T09:00:00.000Z");
const HOUR = 3_600_000;

const card = (id: string, tier: FirewallItem["tier"], subject = id): FirewallItem => ({
  id,
  source: "EMAIL",
  sourceId: `mail-${id}`,
  type: "REPLY_NEEDED",
  title: subject,
  tier,
  tierReason: null,
  priority: 50,
  surfacedAt: NOW.toISOString(),
  email: { subject } as FirewallItem["email"],
});

const row = (over: Partial<FirewallV3Row>): FirewallV3Row => ({
  tier: "QUEUE",
  heldAt: null,
  isManualOverride: false,
  agentTierSetAt: null,
  v3PolicyVersion: "v3.0",
  v3Decision: { basis: "llm", threadTurn: "none", reasons: [] },
  v3Due: null,
  v3Importance: null,
  ...over,
});

const lanes = (queue: FirewallItem[], push: FirewallItem[] = []): Record<Tier, FirewallItem[]> => ({
  SILENT: [],
  INFO: [],
  QUEUE: queue,
  MEETING: [],
  PUSH: push,
  AUTO: [],
});

describe("withV3Lanes", () => {
  const rows = new Map<string, FirewallV3Row>([
    ["newest-plain", row({})],
    ["due-soon", row({ v3Importance: 0.5, v3Due: new Date(NOW.getTime() + HOUR) })],
    ["held", row({ v3Importance: 0.2, heldAt: new Date(NOW.getTime() - HOUR) })],
    ["vip", row({ v3Importance: 1 })],
    ["urgent", row({ tier: "PUSH", v3Importance: 1 })],
  ]);
  const received = new Map([
    ["newest-plain", NOW],
    ["due-soon", new Date(NOW.getTime() - 3 * HOUR)],
    ["held", new Date(NOW.getTime() - 5 * HOUR)],
    ["vip", new Date(NOW.getTime() - 9 * HOUR)],
    ["urgent", NOW],
  ]);
  const input = {
    rowOf: (id: string) => rows.get(id),
    receivedAtOf: (id: string) => received.get(id) ?? NOW,
    now: NOW,
  };

  it("ranks QUEUE (held first, then importance × deadline) and numbers it 1..n", () => {
    const given = lanes(
      ["newest-plain", "due-soon", "held", "vip"].map((id) => card(id, "QUEUE")),
      [card("urgent", "PUSH")],
    );
    const out = withV3Lanes(given, input);
    expect(out.QUEUE.map((i) => i.id)).toEqual(["held", "vip", "due-soon", "newest-plain"]);
    expect(out.QUEUE.map((i) => i.v3?.rank)).toEqual([1, 2, 3, 4]);
    expect(out.QUEUE[0]?.v3?.held).toBe(true);
    // Other lanes keep their order and carry a block with no rank.
    expect(out.PUSH.map((i) => i.v3?.rank)).toEqual([null]);
    expect(out.PUSH[0]?.v3?.policyVersion).toBe("v3.0");
    // The lanes it was given are left as they were.
    expect(given.QUEUE.map((i) => i.id)).toEqual(["newest-plain", "due-soon", "held", "vip"]);
    expect(given.QUEUE[0]?.v3).toBeUndefined();
  });

  it("an item with no stored row gets an undecided block", () => {
    const out = withV3Lanes(lanes([card("ghost", "QUEUE")]), input);
    expect(out.QUEUE[0]?.v3).toEqual({
      policyVersion: null,
      rank: 1,
      held: false,
      due: null,
      threadTurn: null,
      reasons: [],
    });
  });
});
