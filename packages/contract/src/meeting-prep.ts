/**
 * Wire contract for meeting prep (Context Engine slice 1) — the `meetingPrep`
 * field of `GET /api/briefing/today` and the body of
 * `GET /api/briefing/meeting-prep`. Built by packages/api/src/context/;
 * rendered by the web briefing page.
 *
 * Every item is a verified fact from the user's own data and carries its
 * source: a mail (link to it) or a commitment ledger row. Nothing here is
 * model-written. Text fields (titles, subjects, sender names) come from mail
 * and invites, so clients render them as plain text, never as markup.
 */

/** Where an item comes from; a client links to it. */
export type MeetingPrepSource =
  | { kind: "email"; emailId: string }
  | { kind: "commitment"; commitmentId: string };

/** How the item is tied to the meeting: an attendee's own address, or their organisation's domain. */
export type MeetingPrepMatch = "address" | "domain";

export type MeetingPrepItem =
  | {
      kind: "commitment";
      /** USER: the user promised it. COUNTERPARTY: the other side owes it. */
      owner: "USER" | "COUNTERPARTY";
      title: string;
      /** ISO instant, or null when the promise named no date. */
      dueAt: string | null;
      /** False: a rule-mined suggestion the user has not confirmed; show it as a suggestion. */
      confirmed: boolean;
      counterpartyName: string | null;
      match: MeetingPrepMatch;
      source: { kind: "commitment"; commitmentId: string };
    }
  | {
      /** "unanswered": the thread's newest mail wants a reply the user has not sent. */
      kind: "unanswered" | "thread";
      /** Display name (or address) of the sender, as written in the mail. */
      from: string;
      subject: string;
      /** ISO instant the newest mail of the thread arrived. */
      receivedAt: string;
      match: MeetingPrepMatch;
      source: { kind: "email"; emailId: string };
    };

export interface MeetingPrep {
  /** CalendarEvent id: the client links to /calendar/<id>. */
  eventId: string;
  title: string;
  startTime: string;
  endTime: string;
  /** The external attendees the items were linked through (at most a handful). */
  attendees: string[];
  /** At most 3, most pressing first. Never empty. */
  items: MeetingPrepItem[];
}

export interface MeetingPrepBlock {
  generatedAt: string;
  /** Meetings in the next 24 hours with at least one item, earliest first. */
  meetings: MeetingPrep[];
}
