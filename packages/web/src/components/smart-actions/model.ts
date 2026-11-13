/**
 * Smart actions — the pure model behind the "Draft reply" and "Add to
 * calendar" taps (api routes/smart-actions.ts). Checked from
 * packages/api/src/__tests__/web-smart-actions.test.ts.
 *
 * Send binds what is on screen: the request carries the body the user is
 * looking at and the hash of the { to, subject, body } the card shows, the same
 * canonical bytes as the API's sendEmailPayloadHash (judge/attention-floor.ts)
 * and the mobile confirm sheet. The server refuses anything else.
 */

import type {
  SmartEventCreateRequest,
  SmartEventProposalWire,
  SmartExistingEventWire,
  SmartReplySendRequest,
} from "@klorn/contract";
import { sha256 } from "../../lib/sha256";

export type SmartAction = "reply-draft" | "reply" | "event-proposal" | "event";

/** The reminder chip: one popup this long before the start. */
export const REMINDER_CHIP_MINUTES = 30;

const DATE_KEY = /^\d{4}-\d{2}-\d{2}$/;
const CLOCK_24H = /^(?:[01]\d|2[0-3]):[0-5]\d$/;
const API_ERROR = /^API (\d{3}):/;

/** Shown only when the server opened smart actions to this user, never on a demo mail. */
export function smartActionsVisible(
  user: { smartActions?: boolean } | null | undefined,
  emailId: string | null | undefined,
): boolean {
  return user?.smartActions === true && !!emailId && !emailId.startsWith("demo-");
}

export function smartActionPath(emailId: string, action: SmartAction): string {
  return `/api/smart-actions/emails/${encodeURIComponent(emailId)}/${action}`;
}

/** The status in the Error apiFetch throws (`API <status>: <body>`); null otherwise. */
export function apiErrorStatus(err: unknown): number | null {
  if (!(err instanceof Error)) return null;
  const match = API_ERROR.exec(err.message);
  return match ? Number(match[1]) : null;
}

/**
 * The overlapping events of a 409 from the event save (nothing was written);
 * null for any other failure.
 */
export function duplicateFromError(err: unknown): SmartExistingEventWire[] | null {
  if (apiErrorStatus(err) !== 409 || !(err instanceof Error)) return null;
  try {
    const body = JSON.parse(err.message.slice(err.message.indexOf(":") + 1)) as unknown;
    const existing = (body as { existing?: unknown } | null)?.existing;
    return Array.isArray(existing) ? (existing as SmartExistingEventWire[]) : null;
  } catch {
    return null;
  }
}

// ─── Send ────────────────────────────────────────────────────────────────

/** Canonical JSON, byte-identical to the API's sendEmailPayloadHash input. */
function sendPayloadCanonical(payload: { to: string; subject: string; body: string }): string {
  return JSON.stringify({
    v: "v1",
    action: "send_email",
    to: payload.to.normalize("NFC").trim().toLowerCase(),
    subject: payload.subject.normalize("NFC"),
    body: payload.body.normalize("NFC"),
  });
}

export function sendPayloadHash(payload: { to: string; subject: string; body: string }): string {
  const digest = sha256(new TextEncoder().encode(sendPayloadCanonical(payload)));
  return Array.from(digest, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

/** The Send request for the body on screen, under the recipient and subject on screen. */
export function replySendRequest(
  shown: { to: string; subject: string },
  body: string,
): SmartReplySendRequest {
  return { body, payloadHash: sendPayloadHash({ to: shown.to, subject: shown.subject, body }) };
}

// ─── Calendar confirm card ───────────────────────────────────────────────

export interface EventChoice {
  title: string;
  /** `YYYY-MM-DD`; "" until answered. */
  date: string;
  /** `HH:MM` 24h; "" until answered (an AM/PM question leaves it empty). */
  time: string;
  durationMinutes: number;
  location: string;
  reminderMinutes: number | null;
  /** Events the user has been shown at this slot; saving then means "add anyway". */
  existing: SmartExistingEventWire[];
}

export function initialEventChoice(proposal: SmartEventProposalWire): EventChoice {
  return {
    title: proposal.title,
    date: proposal.date ?? "",
    time: proposal.time ?? "",
    durationMinutes: proposal.durationMinutes,
    location: proposal.location ?? "",
    reminderMinutes: null,
    existing: proposal.existing,
  };
}

/** A new date or time is a new slot: the duplicate warning no longer applies. */
export function withDateTime(
  choice: EventChoice,
  change: { date?: string; time?: string },
): EventChoice {
  return { ...choice, ...change, existing: [] };
}

/** The event's length the API takes, in minutes. */
export const MIN_EVENT_MINUTES = 5;
export const MAX_EVENT_MINUTES = 24 * 60;

export function canSaveEvent(choice: EventChoice): boolean {
  return (
    choice.title.trim() !== "" &&
    DATE_KEY.test(choice.date) &&
    CLOCK_24H.test(choice.time) &&
    Number.isInteger(choice.durationMinutes) &&
    choice.durationMinutes >= MIN_EVENT_MINUTES &&
    choice.durationMinutes <= MAX_EVENT_MINUTES
  );
}

export function eventSaveRequest(choice: EventChoice): SmartEventCreateRequest {
  const location = choice.location.trim();
  return {
    title: choice.title.trim(),
    date: choice.date,
    time: choice.time,
    durationMinutes: choice.durationMinutes,
    ...(location ? { location } : {}),
    ...(choice.reminderMinutes !== null ? { reminderMinutes: choice.reminderMinutes } : {}),
    ...(choice.existing.length > 0 ? { allowDuplicate: true } : {}),
  };
}

/** "15:30" → "3:30", for the AM/PM choice labels. */
export function twelveHourLabel(hhmm: string): string {
  const [hour, minute] = hhmm.split(":");
  const h = Number.parseInt(hour, 10) % 12 || 12;
  return `${h}:${minute}`;
}
