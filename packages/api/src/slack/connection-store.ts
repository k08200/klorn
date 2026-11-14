/**
 * The per-user Slack connection (docs/providers/slack.md §5). The signing
 * secret is encrypted with crypto-tokens.ts and only ever selected by the
 * webhook's lookup; nothing here returns it to a route. The user token is
 * checked with auth.test on connect and never stored: v1 makes no Slack API
 * call that needs it. Every query is scoped by the session user's id or, for
 * the webhook, by the hook id in the URL.
 */

import crypto from "node:crypto";
import type { Prisma } from "@prisma/client";
import { encryptToken } from "../crypto-tokens.js";
import { prisma } from "../db.js";
import { slackEventsUrl } from "./manifest.js";
import { isUniqueViolation } from "./unique-violation.js";

const HOOK_ID_BYTES = 16;

export type SlackConnectionStatus =
  | { state: "none" }
  | {
      state: "pending" | "connected";
      /** Null when the API's public origin (PUBLIC_URL) is not configured. */
      requestUrl: string | null;
      teamId: string | null;
      workspaceUrl: string | null;
      optInChannelIds: string[];
      credentialsSetAt: string | null;
      lastEventAt: string | null;
    };

const STATUS_SELECT = {
  hookId: true,
  teamId: true,
  workspaceUrl: true,
  optInChannelIds: true,
  credentialsSetAt: true,
  lastEventAt: true,
} as const;

type StatusRow = {
  hookId: string;
  teamId: string | null;
  workspaceUrl: string | null;
  optInChannelIds: string[];
  credentialsSetAt: Date | null;
  lastEventAt: Date | null;
};

function toStatus(row: StatusRow | null): SlackConnectionStatus {
  if (!row) return { state: "none" };
  return {
    state: row.credentialsSetAt ? "connected" : "pending",
    requestUrl: slackEventsUrl(row.hookId),
    teamId: row.teamId,
    workspaceUrl: row.workspaceUrl,
    optInChannelIds: row.optInChannelIds,
    credentialsSetAt: row.credentialsSetAt?.toISOString() ?? null,
    lastEventAt: row.lastEventAt?.toISOString() ?? null,
  };
}

export async function getSlackConnectionStatus(userId: string): Promise<SlackConnectionStatus> {
  const row = await prisma.slackConnection.findUnique({
    where: { userId },
    select: STATUS_SELECT,
  });
  return toStatus(row);
}

/** Creates the pending connection (and its hookId) once; idempotent. */
export async function startSlackConnection(userId: string): Promise<SlackConnectionStatus> {
  const existing = await prisma.slackConnection.findUnique({
    where: { userId },
    select: { id: true },
  });
  if (!existing) {
    try {
      await prisma.slackConnection.create({
        data: { userId, hookId: crypto.randomBytes(HOOK_ID_BYTES).toString("hex") },
        select: { id: true },
      });
    } catch (err) {
      // A concurrent start already created it: same outcome.
      if (!isUniqueViolation(err)) throw err;
    }
  }
  return getSlackConnectionStatus(userId);
}

export interface SlackCredentials {
  signingSecret: string;
  teamId: string;
  slackUserId: string;
  workspaceUrl: string;
  now?: Date;
}

/**
 * Stores the verified connection. Moving to another workspace or another
 * Slack user drops what was stored for the previous one, opt-ins included.
 */
export async function saveSlackCredentials(
  userId: string,
  creds: SlackCredentials,
): Promise<"saved" | "not-started"> {
  const existing = await prisma.slackConnection.findUnique({
    where: { userId },
    select: { id: true, teamId: true, slackUserId: true },
  });
  if (!existing) return "not-started";
  const switched =
    (existing.teamId !== null && existing.teamId !== creds.teamId) ||
    (existing.slackUserId !== null && existing.slackUserId !== creds.slackUserId);
  const update = prisma.slackConnection.update({
    where: { userId },
    data: {
      signingSecretCipher: encryptToken(creds.signingSecret),
      teamId: creds.teamId,
      slackUserId: creds.slackUserId,
      workspaceUrl: creds.workspaceUrl,
      credentialsSetAt: creds.now ?? new Date(),
      ...(switched ? { optInChannelIds: [] } : {}),
    },
    select: { id: true },
  });
  const wipe: Prisma.PrismaPromise<unknown>[] = switched
    ? [
        prisma.slackMessage.deleteMany({ where: { userId } }),
        prisma.slackEpisode.deleteMany({ where: { userId } }),
      ]
    : [];
  await prisma.$transaction([...wipe, update]);
  return "saved";
}

/** Returns false when the user has no connection. */
export async function setSlackOptInChannels(
  userId: string,
  channelIds: string[],
): Promise<boolean> {
  const result = await prisma.slackConnection.updateMany({
    where: { userId },
    data: { optInChannelIds: channelIds },
  });
  return result.count > 0;
}

/** Disconnect: the signing secret and every stored Slack row of this user, atomically. */
export async function disconnectSlack(userId: string): Promise<void> {
  await prisma.$transaction([
    prisma.slackMessage.deleteMany({ where: { userId } }),
    prisma.slackEpisode.deleteMany({ where: { userId } }),
    prisma.slackConnection.deleteMany({ where: { userId } }),
  ]);
}

export interface SlackHook {
  id: string;
  userId: string;
  teamId: string | null;
  slackUserId: string | null;
  optInChannelIds: string[];
  signingSecretCipher: string | null;
  lastEventAt: Date | null;
}

/** The webhook's lookup: what signature verification and the filter need, no token. */
export async function findSlackHook(hookId: string): Promise<SlackHook | null> {
  return prisma.slackConnection.findUnique({
    where: { hookId },
    select: {
      id: true,
      userId: true,
      teamId: true,
      slackUserId: true,
      optInChannelIds: true,
      signingSecretCipher: true,
      lastEventAt: true,
    },
  });
}

/** A signed request arrived: shows "verified" in Settings. */
export async function touchSlackHook(connectionId: string, now: Date = new Date()): Promise<void> {
  await prisma.slackConnection.update({
    where: { id: connectionId },
    data: { lastEventAt: now },
    select: { id: true },
  });
}
