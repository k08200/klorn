/**
 * What an organization can and cannot see of a member — the static truth the
 * member transparency endpoint states (GET /api/orgs/current/transparency).
 * The privacy invariants of docs/design/team-mode-v3.md and the "Not doing"
 * list of docs/design/pricing-tiers.md: no shared inbox, no delegated sending,
 * no cross-member mail search, no organization dossiers and no admin access to
 * a member's mail. org-privacy-guard.test.ts holds the org code to this list;
 * org-privacy-invariants-pg.test.ts proves it against the real routes.
 */

export interface VisibleToOrg {
  /** Stable key the client localizes. */
  key: "roles" | "seats" | "cost" | "freeBusy" | "auditLog";
  /** True when this item depends on the member's own grant. */
  needsGrant: boolean;
}

export const VISIBLE_TO_ORG: readonly VisibleToOrg[] = [
  // Your name, address and role in the organization.
  { key: "roles", needsGrant: false },
  // Whether you hold a paid seat.
  { key: "seats", needsGrant: false },
  // The per-seat price and the subscription's state. Never your usage.
  { key: "cost", needsGrant: false },
  // Busy start and end times only, and only while you share them.
  { key: "freeBusy", needsGrant: true },
  // Admin actions and each read of your free/busy (who, which window).
  { key: "auditLog", needsGrant: false },
];

export const NEVER_VISIBLE_TO_ORG = [
  "mail",
  "attentionItems",
  "commitments",
  "drafts",
  "dossiers",
  "eventDetails",
  "chat",
  "contacts",
  "usage",
] as const;

export type NeverVisibleToOrg = (typeof NEVER_VISIBLE_TO_ORG)[number];
