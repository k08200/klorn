/**
 * Wire contract for `/api/teams` — saved teams for team-mode availability
 * (team mode P1, docs/design/team-mode-v3.md). Every route answers
 * 403 `{ code: "TEAM_REQUIRED" }` while the server's TEAM_MODE_ENABLED is off;
 * clients read that (or `user.teamMode` on GET /api/auth/me) to hide every
 * team surface.
 */

/** One saved team: a name plus bare member emails. Owner-scoped. */
export interface TeamWire {
  id: string;
  name: string;
  members: string[];
  updatedAt?: string;
}

/** `GET /api/teams` — the user's own teams, by name. */
export interface TeamsListResponse {
  teams: TeamWire[];
}

/** One common free slot, ISO 8601 instants. */
export interface TeamFreeSlotWire {
  startTime: string;
  endTime: string;
}

/**
 * `GET /api/teams/:id/availability` — the first common free slots for the user
 * and every member whose calendar the user can see. Query: `window_start`,
 * `window_end` (ISO instants, at most 14 days apart) and `duration_minutes`
 * (default 60, at most 480). Read-only: it creates no event.
 */
export interface TeamAvailabilityResponse {
  slots: TeamFreeSlotWire[];
  /** Members whose free/busy was actually checked. */
  checkedMembers: string[];
  /** Members whose calendars the user cannot see: availability UNKNOWN, never free. */
  unknownMembers: string[];
  /** The user's stored IANA zone, the one the slots were cut in. */
  timeZone: string;
}
