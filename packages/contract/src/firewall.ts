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

import type { InboxProvider } from "./email.js";

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

/**
 * The connected account a mail arrived on — what a row's source badge shows.
 * `accountId` is the linked inbox account id, null for the primary account;
 * `label` is the account's address. Clients treat an unknown `provider` as a
 * generic mail source (see InboxProvider).
 */
export interface FirewallSourceWire {
  provider: InboxProvider;
  accountId: string | null;
  label: string;
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
  /** The reply axis (reply-state.ts): "needsReply" = the analysis judged a
   *  reply is owed and none went out through Klorn; "replied" = the user
   *  answered through Klorn (recorded). Absent / null = no claim. Replies
   *  sent from Gmail directly are not seen. */
  replyState?: "needsReply" | "replied" | null;
  /** A reply draft is already written for this mail (proactive drafts) and
   *  it has not been answered. Absent = none. The draft itself rides on the
   *  detail response. */
  draftReady?: boolean;
  /** Which account the mail is on. Null when the account cannot be named
   *  (its linked row is gone, or the lookup failed); absent on older servers.
   *  Named `source` here, on the preview: the item's own `source` is the
   *  attention source ("EMAIL", "PENDING_ACTION") and stays a string. */
  source?: FirewallSourceWire | null;
  /** The mail's read flag. Null / absent = no claim. */
  unread?: boolean | null;
  /** The mail has at least one attached file. An inline image (an image part
   *  with a Content-ID, e.g. a signature logo) is NOT counted — unlike
   *  `GET /api/email?filter=attachments`, which matches any attachment row;
   *  aligning the two is a follow-up. Null / absent = no claim. */
  hasAttachment?: boolean | null;
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
  /**
   * Present (and always `true`) only when an MCP agent set this item's lane
   * through set_tier, rather than the classifier or the user. Absent otherwise,
   * so a response for an account without agent-set lanes is unchanged. No client
   * renders it yet; the activity-log step (A3) or a later UI step does.
   */
  agentSet?: true;
}

export interface FirewallResponse {
  tiers: Record<Tier, FirewallItem[]>;
  summary: Record<Tier, number> & { total: number };
}

/**
 * A manual lane override that can be undone. Only
 * `POST /api/inbox/firewall/email/:emailId` returns the undo handle (the older
 * `POST /api/inbox/firewall/:id` answers `{ ok, tier }` and is not reversible).
 */
export interface LaneOverrideResponse {
  ok: true;
  tier: Tier;
  undoToken?: string;
  /** ISO time after which the server refuses the undo. */
  undoExpiresAt?: string;
}

/** `POST /api/inbox/firewall/email/:emailId` — the same override, keyed by email id. */
export interface LaneOverrideByEmailResponse extends LaneOverrideResponse {
  /** Attention item id: the `:id` of the undo route. */
  itemId: string;
}

/**
 * `POST /api/inbox/firewall/:id/undo` — `tier` is the lane restored (null when
 * the mail had none). `alreadyUndone` marks a repeat of a completed undo.
 */
export interface LaneOverrideUndoResponse {
  ok: true;
  tier: LiveTier | null;
  alreadyUndone: boolean;
}

/**
 * Refusals of the two routes above. `undo_*` and `override_conflict` are HTTP
 * 409 and change nothing; `override_conflict` means the row kept changing while
 * the move was applied and the client may simply try again. `rate_limited` is
 * HTTP 429 from the per-user lane-write limit.
 */
export interface LaneOverrideErrorResponse {
  ok: false;
  code: "not_found" | "undo_expired" | "undo_conflict" | "override_conflict" | "rate_limited";
  message: string;
}
