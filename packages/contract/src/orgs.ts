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
  };
}

export interface OrgMeWire {
  membershipId: string;
  role: OrgRoleWire;
  seated: boolean;
  sharesFreeBusy: boolean;
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
}

/** `POST /api/orgs/current/checkout` with `{ interval, seats }` (owner only). */
export interface OrgCheckoutResponse {
  url: string;
}
