/**
 * Wire contract for `/api/orgs` — Klorn Teams v1 (docs/design/pricing-tiers.md
 * "Team (company) plan", docs/design/team-mode-v3.md). Every route answers
 * Fastify's default 404 while the server's TEAMS_ENABLED is off (or the user
 * is outside its cohort); clients read `user.teams` on GET /api/auth/me to
 * show the organization pages at all. Refusals answer `{ error, code }`.
 *
 * No route here carries a member's mail, attention items or commitments.
 */

export type OrgRoleWire = "OWNER" | "MEMBER";
export type AgentModeCapWire = "OFF" | "SHADOW" | "SUGGEST";
export type TeamIntervalWire = "month" | "year";

export interface OrgWire {
  id: string;
  name: string;
  slug: string;
  companyDomains: string[];
  autoReplyDisabled: boolean;
  agentModeCap: AgentModeCapWire | null;
  seats: {
    purchased: number;
    used: number;
    status: string | null;
    interval: string | null;
    active: boolean;
    /** Intervals a team checkout can be opened for now; empty while billing is off. */
    checkoutIntervals: TeamIntervalWire[];
    /** When a scheduled period-end cancel ends the subscription (ISO), or null. */
    cancelAt: string | null;
  };
}

/**
 * What the viewing owner may do with the team subscription, so the page can
 * explain it before a click (src/org/billing-access.ts). Only the viewer's own
 * standing: never who pays, never an email. null means Paddle could not be
 * asked; the routes check again either way.
 */
export interface OrgBillingAccessWire {
  /** The recorded payer, or the owner whose verified email Paddle bills. */
  isPayer: boolean | null;
  /** The billing portal opens for this owner (their verified email is Paddle's). */
  portal: boolean | null;
  /** The most seats this owner can set without the paying email; null when no such cap applies. */
  seatCap: number | null;
  /** This owner can take back a scheduled cancel (the payer, or the owner who scheduled it in Klorn). */
  canResume: boolean | null;
}

export interface OrgMeWire {
  membershipId: string;
  role: OrgRoleWire;
  seated: boolean;
  sharesFreeBusy: boolean;
  /** On `GET /api/orgs/current` only, for an owner, while the team subscription bills. */
  billing?: OrgBillingAccessWire;
}

/** `GET /api/orgs/current`, and the answer of every change that returns the view. */
export type OrgViewResponse = { org: null } | { org: OrgWire; me: OrgMeWire };

export interface OrgMemberWire {
  membershipId: string;
  name: string | null;
  email: string;
  role: OrgRoleWire;
  joinedAt: string;
  seated: boolean;
  sharesFreeBusy: boolean;
  isYou: boolean;
}

/** `GET /api/orgs/current/members`. */
export interface OrgMembersResponse {
  members: OrgMemberWire[];
}

export interface OrgInviteWire {
  id: string;
  email: string;
  expiresAt: string;
  createdAt: string;
}

/** `GET /api/orgs/current/invites` (owner only): pending invites. */
export interface OrgInvitesResponse {
  invites: OrgInviteWire[];
}

/** `POST /api/orgs/invites/preview` with `{ token }`. */
export interface OrgInvitePreviewResponse {
  orgName: string;
  expiresAt: string;
  emailMatches: boolean;
  emailVerified: boolean;
}

export interface OrgAuditEventWire {
  id: string;
  action: string;
  /** The actor's name while they are a member; null otherwise. */
  actor: string | null;
  target: string | null;
  detail: unknown;
  createdAt: string;
}

/** `GET /api/orgs/current/audit` (owner only). `?kind=admin`, `?before=<id>`. */
export interface OrgAuditResponse {
  events: OrgAuditEventWire[];
  nextBefore: string | null;
}

export type OrgVisibleKey = "roles" | "seats" | "cost" | "freeBusy" | "auditLog";
export type OrgNeverVisibleKey =
  | "mail"
  | "attentionItems"
  | "commitments"
  | "drafts"
  | "dossiers"
  | "eventDetails"
  | "chat"
  | "contacts"
  | "usage";

/** `GET /api/orgs/current/transparency`: what the organization can and cannot see. */
export interface OrgTransparencyResponse {
  visibleToOrg: Array<{ key: OrgVisibleKey; needsGrant: boolean; active: boolean }>;
  neverVisible: OrgNeverVisibleKey[];
  you: { role: OrgRoleWire; seated: boolean; sharesFreeBusy: boolean };
  ceilings: {
    autoReplyDisabled: boolean;
    agentModeCap: AgentModeCapWire | null;
    appliesToEveryone: boolean;
  };
  freeBusyReads: Array<{ by: string | null; window: unknown; at: string }>;
  seatPrice: { currency: "USD"; monthlyCents: number; annualPerMonthCents: number };
  /**
   * The organization's company domains while they shape this member's triage
   * reasons (verified mail from them is named "a colleague at your company");
   * empty when the judge does not show those reasons for this member.
   */
  companyDomains: string[];
}

/** `POST /api/orgs/current/checkout` with `{ interval, seats }` (owner only). */
export interface OrgCheckoutResponse {
  url: string;
}

/**
 * `POST /api/orgs/current/seats` with `{ seats }` (owner only). "pending": Paddle
 * took the change (202) and the stored seats move when its webhook arrives;
 * "unchanged": the organization already has that many seats (200).
 */
export interface OrgSeatChangeResponse {
  status: "pending" | "unchanged";
  seats: number;
}

/** `POST /api/orgs/current/subscription/cancel` (owner only): when the seats end (ISO), if Paddle said. */
export interface OrgCancelResponse {
  cancelAt: string | null;
}

/** `POST /api/orgs/current/subscription/resume` (owner only). */
export interface OrgResumeResponse {
  resumed: true;
}

/** `POST /api/orgs/current/billing-portal` (the owner who set up billing only). */
export interface OrgBillingPortalResponse {
  url: string;
}
