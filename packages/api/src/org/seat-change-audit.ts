/**
 * The audit trail of a Klorn Teams seat change (seat-management.ts), which is
 * also its concurrency mark: a seat change row committed since a request
 * read Paddle means that read is stale.
 *
 * Under the organization's lock, the request row is committed on its own
 * connection before the one Paddle call, so it stays on record — and marks a
 * change for the next request that takes the lock — whatever the call or the
 * locked transaction does next (a call that times out, a commit that fails
 * after Paddle accepted). A write that fails stops the call. Because the row
 * is visible while its call is still running, a request whose live read
 * started within SEAT_CHANGE_IN_FLIGHT_MS of it is refused too: Paddle may
 * have answered that read before applying the change. When Paddle answers
 * and refuses (4xx: nothing changed there) the row is taken back, so a
 * refused call still leaves no row. When no answer says either way — a
 * timeout, a dropped connection, a Paddle 5xx — the new count may be live or
 * may still land, so an "unconfirmed" row names the failure class, and for
 * SEAT_CHANGE_DOUBT_MS no other change starts from a count read before it.
 *
 * Rows carry counts, the payer basis and a ProviderFailureCode only — never
 * Paddle's text — and age out with the rest of the log (audit-retention.ts,
 * 400 days).
 */

import { PaddleApiError } from "../billing/paddle.js";
import { prisma } from "../db.js";
import type { ProviderFailureCode } from "../public-failure.js";
import { captureDbFailure } from "../report-db-failure.js";
import type { OrgAuditAction } from "./audit.js";
import { OrgError } from "./org-error.js";
import type { OrgTx } from "./org-lock.js";

export const SEATS_CHANGE_ACTION = "billing.seats_change_requested" satisfies OrgAuditAction;
export const SEATS_UNCONFIRMED_ACTION = "billing.seats_change_unconfirmed" satisfies OrgAuditAction;

/** The one Paddle call under the lock: the 15 s transaction keeps ~9 s for the lock wait. */
export const SEAT_CHANGE_CALL_TIMEOUT_MS = 6_000;

/** Clock difference between this server and the database that stamps createdAt, allowed for. */
const CLOCK_MARGIN_MS = 4_000;

/**
 * How long after its request row a change's Paddle call may still be running:
 * a live read that started this soon after the row may predate the change.
 */
export const SEAT_CHANGE_IN_FLIGHT_MS = SEAT_CHANGE_CALL_TIMEOUT_MS + CLOCK_MARGIN_MS;

/**
 * How long an unconfirmed change keeps the count in doubt: Paddle may still
 * apply a request it did not answer, after a later request read the count.
 */
export const SEAT_CHANGE_DOUBT_MS = 2 * 60_000;

/** How an owner passed the payer check, as the audit detail records it. */
export type PayerBasis = "recorded" | "email";

/** A seat change as its rows name it: who asked, from what count to what, and how the payer check passed. */
export interface SeatChangeAttempt {
  orgId: string;
  actorUserId: string;
  from: number;
  to: number;
  /** How the payer check passed (increases only). */
  payer: PayerBasis | null;
}

function requestedData(attempt: SeatChangeAttempt) {
  const { orgId, actorUserId, from, to, payer } = attempt;
  return {
    orgId,
    action: SEATS_CHANGE_ACTION,
    actorUserId,
    detail: { from, to, ...(payer ? { payer } : {}) },
  };
}

function unconfirmedData(attempt: SeatChangeAttempt, failure: ProviderFailureCode) {
  const { orgId, actorUserId, from, to } = attempt;
  return { orgId, action: SEATS_UNCONFIRMED_ACTION, actorUserId, detail: { from, to, failure } };
}

const STATUS_CLIENT_ERROR = 400;
const STATUS_REQUEST_TIMEOUT = 408;
const STATUS_SERVER_ERROR = 500;

/**
 * True when Paddle answered and refused (4xx): the subscription is as it was.
 * A 408 is a timeout someone answered for Paddle, not a refusal.
 */
export function paddleRefused(err: unknown): boolean {
  return (
    err instanceof PaddleApiError &&
    err.status >= STATUS_CLIENT_ERROR &&
    err.status < STATUS_SERVER_ERROR &&
    err.status !== STATUS_REQUEST_TIMEOUT
  );
}

/** The newest seat change requested through Klorn, or null: a mark taken before the live read. */
export type SeatChangeMark = { id: string; createdAt: Date } | null;

/** What a request knew before it read Paddle's live count: the mark, and when the read began. */
export interface LiveRead {
  mark: SeatChangeMark;
  startedAt: Date;
}

export function lastSeatChange(orgId: string): Promise<SeatChangeMark> {
  return prisma.orgAuditEvent.findFirst({
    where: { orgId, action: SEATS_CHANGE_ACTION },
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    select: { id: true, createdAt: true },
  });
}

const SEATS_CHANGED = () =>
  new OrgError(
    409,
    "SEATS_CHANGED",
    "The seat count changed while this request was waiting. Check the count and try again.",
  );

function agoFrom(when: Date, ms: number): Date {
  return new Date(when.getTime() - ms);
}

/**
 * Under the lock: the live quantity read before the lock is stale — and with
 * it the increase-or-decrease call, so two concurrent decreases cannot add up
 * to an unchecked increase — when a seat change was requested since the
 * mark, or so shortly before the read that its Paddle call may still have
 * been running, or when a recent change is still unconfirmed (Paddle may
 * apply it yet).
 */
export async function assertNoSeatChangeSince(
  tx: OrgTx,
  orgId: string,
  read: LiveRead,
  now = new Date(),
): Promise<void> {
  const { mark } = read;
  const since = mark
    ? {
        OR: [
          { createdAt: { gt: mark.createdAt } },
          { createdAt: mark.createdAt, id: { not: mark.id } },
        ],
      }
    : {};
  const newer = await tx.orgAuditEvent.findFirst({
    where: {
      orgId,
      OR: [
        { action: SEATS_CHANGE_ACTION, ...since },
        {
          action: SEATS_CHANGE_ACTION,
          createdAt: { gt: agoFrom(read.startedAt, SEAT_CHANGE_IN_FLIGHT_MS) },
        },
        {
          action: SEATS_UNCONFIRMED_ACTION,
          createdAt: { gt: agoFrom(now, SEAT_CHANGE_DOUBT_MS) },
        },
      ],
    },
    select: { id: true },
  });
  if (newer) throw SEATS_CHANGED();
}

/** Commit the request row now, on its own connection; its id, to take it back after a refusal. */
export async function recordSeatChangeRequest(attempt: SeatChangeAttempt): Promise<string> {
  const row = await prisma.orgAuditEvent.create({
    data: requestedData(attempt),
    select: { id: true },
  });
  return row.id;
}

/** Paddle refused: take the request row back. A failure is reported; the row then marks a change that did not happen, which only costs a retry. */
export async function withdrawSeatChangeRequest(id: string, orgId: string): Promise<void> {
  try {
    await prisma.orgAuditEvent.deleteMany({ where: { id, orgId, action: SEATS_CHANGE_ACTION } });
  } catch (err) {
    captureDbFailure("[ORG] withdrawing a refused seat change's audit row failed", err, {
      tags: { scope: "org.billing.audit_seat_change" },
      extra: { orgId, auditEventId: id },
    });
  }
}

/** A failed unconfirmed write is tried once more: without it, the count's doubt goes unmarked. */
const UNCONFIRMED_WRITE_ATTEMPTS = 2;

/** No answer said either way: record why the change is unconfirmed. A failure is reported with the row's facts, never thrown. */
export async function recordSeatChangeUnconfirmed(
  attempt: SeatChangeAttempt,
  failure: ProviderFailureCode,
): Promise<void> {
  let lastError: unknown = null;
  for (let i = 0; i < UNCONFIRMED_WRITE_ATTEMPTS; i++) {
    try {
      await prisma.orgAuditEvent.create({ data: unconfirmedData(attempt, failure) });
      return;
    } catch (err) {
      lastError = err;
    }
  }
  // Seat counts, named so no address scan mistakes them for mail headers.
  const { orgId, from: seatsFrom, to: seatsTo } = attempt;
  captureDbFailure("[ORG] audit of an unconfirmed seat change failed", lastError, {
    tags: { scope: "org.billing.audit_seat_change" },
    extra: { orgId, seatsFrom, seatsTo, failure },
  });
}
