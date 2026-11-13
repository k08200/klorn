/**
 * Account Health (Settings -> Accounts): every connected mail account with its
 * provider, status, last successful sync and the action the user must take.
 * Read-only, scoped to the caller's own rows; no secret is selected.
 *
 * Sources: the primary Google grant (UserToken "google": a row without a refresh
 * token needs reconnecting; lastSyncedAt is stamped by email-sync.ts), and every
 * LinkedInboxAccount (needsReconnect, lastSyncedAt, syncErrorCode written by the
 * Google, IMAP and Outlook polls).
 */

import type {
  AccountHealthEntry,
  AccountHealthResponse,
  AccountHealthStatus,
  InboxProvider,
  MailSyncErrorCode,
} from "@klorn/contract";
import { prisma } from "../db.js";
import { SYNC_ERROR_CODES } from "./sync-error-code.js";

const PROVIDERS: readonly InboxProvider[] = [
  "GOOGLE",
  "NAVER",
  "ICLOUD",
  "OUTLOOK",
  "IMAP",
  "KLORN",
];

interface StatusInput {
  needsReconnect: boolean;
  errorCode: MailSyncErrorCode | null;
  lastSyncedAt: Date | null;
  /** False for a mailbox Klorn does not poll (the Klorn address receives mail). */
  polled: boolean;
}

/** The status and action of one account. Pure. */
export function accountHealthStatus(input: StatusInput): {
  status: AccountHealthStatus;
  action: "reconnect" | null;
} {
  if (input.needsReconnect) return { status: "reconnect", action: "reconnect" };
  if (input.errorCode) return { status: "error", action: null };
  if (input.polled && !input.lastSyncedAt) return { status: "pending", action: null };
  return { status: "ok", action: null };
}

/** A stored code the wire knows, or null (a rollback or hand edit reads as none). */
function asErrorCode(value: string | null): MailSyncErrorCode | null {
  return SYNC_ERROR_CODES.find((code) => code === value) ?? null;
}

function asProvider(value: string): InboxProvider {
  return PROVIDERS.find((provider) => provider === value) ?? "GOOGLE";
}

export async function listAccountHealth(userId: string): Promise<AccountHealthResponse> {
  const [user, googleToken, linked] = await Promise.all([
    prisma.user.findUnique({ where: { id: userId }, select: { email: true } }),
    prisma.userToken.findFirst({
      where: { userId, provider: "google" },
      select: { refreshToken: true, lastSyncedAt: true },
    }),
    prisma.linkedInboxAccount.findMany({
      where: { userId },
      select: {
        id: true,
        email: true,
        provider: true,
        needsReconnect: true,
        lastSyncedAt: true,
        syncErrorCode: true,
        syncErrorAt: true,
      },
      orderBy: { createdAt: "asc" },
    }),
  ]);

  const accounts: AccountHealthEntry[] = [];
  if (googleToken) {
    const lastSyncedAt = googleToken.lastSyncedAt ?? null;
    accounts.push({
      id: null,
      email: user?.email ?? null,
      provider: "GOOGLE",
      kind: "primary",
      // An invalidated grant keeps its row but loses the refresh token.
      ...accountHealthStatus({
        needsReconnect: !googleToken.refreshToken,
        errorCode: null,
        lastSyncedAt,
        polled: true,
      }),
      lastSyncedAt: lastSyncedAt?.toISOString() ?? null,
      errorCode: null,
      errorAt: null,
    });
  }
  for (const row of linked) {
    const provider = asProvider(row.provider);
    const errorCode = asErrorCode(row.syncErrorCode);
    accounts.push({
      id: row.id,
      email: row.email,
      provider,
      kind: "linked",
      ...accountHealthStatus({
        needsReconnect: row.needsReconnect,
        errorCode,
        lastSyncedAt: row.lastSyncedAt,
        polled: provider !== "KLORN",
      }),
      lastSyncedAt: row.lastSyncedAt?.toISOString() ?? null,
      errorCode,
      errorAt: errorCode ? (row.syncErrorAt?.toISOString() ?? null) : null,
    });
  }
  return { accounts };
}
