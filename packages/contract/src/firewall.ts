/**
 * Wire contract for the firewall queue — `GET /api/inbox/firewall`.
 * Built by packages/api/src/routes/firewall.ts; rendered by the web firewall
 * board (and mirrored natively by the macOS app's Models.swift, which cannot
 * consume TS types — keep it in mind when changing shapes here).
 *
 * Drift this contract caught on day one: the web board's hand-mirrored
 * FirewallItem was missing `hashStale`, so the stale-classification signal
 * the server had been sending since PR #468 was invisible to the client.
 */

/**
 * The canonical attention vocabulary, as serialized on the wire.
 *
 * Ontology v2 (2026-08-15): MEETING (scheduling lane) and INFO (transactional
 * records) join the vocabulary. AUTO stays in the STORAGE vocabulary for
 * legacy rows and the v1 classifier; TIER_V2_ENABLED has been default-ON since
 * 2026-08-18, so v2 never emits it. See docs/design/tier-ontology-v2.md.
 */
export type Tier = "SILENT" | "INFO" | "QUEUE" | "MEETING" | "PUSH" | "AUTO";

/**
 * A lane the current classifier can actually emit — the vocabulary to offer a
 * user, group by, or draw a legend from. AUTO is excluded by design: a client
 * must still be able to DISPLAY a legacy AUTO row, but must never present it
 * as a lane that mail arrives in.
 *
 * This package ships no runtime code, so the iterable list lives once per
 * runtime (`packages/api/src/judge/tiers.ts`, `packages/web/src/lib/tiers.ts`).
 * Each is pinned to this type by a compile-time completeness assertion, so a
 * lane added here fails both builds until both lists name it. That matters:
 * every surface that wrote its own list drifted — the playground offered four
 * lanes and crashed on MEETING, onboarding grouped by four and silently
 * dropped MEETING and INFO mail.
 */
export type LiveTier = Exclude<Tier, "AUTO">;

export type TrustBadge = "reliable" | "mostly_reliable" | "unreliable" | "unknown";

/** Sender trust signal (null when no ContactTrustScore row exists yet). */
export interface TrustWire {
  badge: TrustBadge;
  label: string;
  onTimeRate: number;
  totalCount: number;
}

/** Email preview attached to EMAIL / email-referencing PENDING_ACTION items. */
export interface FirewallEmailContext {
  /** EmailMessage.id (DB id) — used by /email/[id]. */
  emailDbId: string;
  subject: string | null;
  from: string | null;
  snippet: string | null;
  /** ISO arrival time — the row's right-aligned timestamp. Null for rows
   *  synced before the column existed; clients fall back to surfacedAt. */
  receivedAt: string | null;
  /** The row's one non-lane chip (mail-first shell): a Gmail category, the
   *  user's reply history with this sender, or first contact. Null when no
   *  recorded fact supports a claim — clients render no chip, never a guess. */
  signal: RowSignalWire;
  trust: TrustWire | null;
}

export type RowSignalWire =
  | {
      kind: "category";
      category:
        | "promotions"
        | "social"
        | "updates"
        | "forums"
        // The judge's verdicts — who the sender IS (email-classifier.ts).
        | "internal"
        | "customer"
        | "investor"
        | "system"
        | "billing";
      /** True when the category is the USER's own correction (sender label)
       *  — clients offer "clear" instead of a fresh pick. Absent = derived. */
      byUser?: boolean;
    }
  | { kind: "replied"; count: number }
  | { kind: "first" }
  | null;

export interface FirewallItem {
  id: string;
  source: string;
  sourceId: string;
  type: string;
  title: string;
  tier: Tier;
  tierReason: string | null;
  priority: number;
  surfacedAt: string;
  // Source-specific enrichment, populated best-effort.
  toolName?: string;
  toolArgs?: Record<string, unknown>;
  email?: FirewallEmailContext;
  /** Where the card should link on click. */
  href?: string;
  /**
   * True iff the stored classification input hash no longer matches the
   * email's current bytes — the cached tier may be stale (PR #468 read path).
   */
  hashStale?: boolean;
}

export interface FirewallResponse {
  tiers: Record<Tier, FirewallItem[]>;
  summary: Record<Tier, number> & { total: number };
}
