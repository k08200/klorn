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

/** The canonical 4-tier attention vocabulary, as serialized on the wire. */
export type Tier = "SILENT" | "QUEUE" | "PUSH" | "AUTO";

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
  trust: TrustWire | null;
}

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
  summary: {
    SILENT: number;
    QUEUE: number;
    PUSH: number;
    AUTO: number;
    total: number;
  };
}
