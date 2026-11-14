/**
 * The per-user Slack connection (docs/providers/slack.md §5). Secrets are
 * encrypted with crypto-tokens.ts and only ever selected by the two readers
 * that need them (the webhook's signing secret); nothing here returns a
 * secret to a route. Every query is scoped by the session user's id or, for
 * the webhook, by the hook id in the URL.
 */

import crypto from "node:crypto";
import { encryptToken } from "../crypto-tokens.js";
import { prisma } from "../db.js";
import { slackEventsUrl } from "./manifest.js";

const HOOK_ID_BYTES = 16;

export type SlackConnectionStatus =
  | { state: "none" }
  | {
      state: "pending" | "connected";
      requestUrl: string;
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
    await prisma.slackConnection.create({
      data: { userId, hookId: crypto.randomBytes(HOOK_ID_BYTES).toString("hex") },
      select: { id: true },
    });
  }
  return getSlackConnectionStatus(userId);
}

export interface SlackCredentials {
  signingSecret: string;
  userToken: string;
  teamId: string;
  slackUserId: string;
  workspaceUrl: string;
  now?: Date;
}

/** Stores the verified credentials; a different workspace drops the old one's data. */
export async function saveSlackCredentials(
  userId: string,
  creds: SlackCredentials,
): Promise<"saved" | "not-started"> {
  const existing = await prisma.slackConnection.findUnique({
    where: { userId },
    select: { id: true, teamId: true },
  });
  if (!existing) return "not-started";
  if (existing.teamId && existing.teamId !== creds.teamId) {
    await prisma.slackMessage.deleteMany({ where: { userId } });
    await prisma.slackEpisode.deleteMany({ where: { userId } });
  }
  await prisma.slackConnection.update({
    where: { userId },
    data: {
      signingSecretCipher: encryptToken(creds.signingSecret),
      userTokenCipher: encryptToken(creds.userToken),
      teamId: creds.teamId,
      slackUserId: creds.slackUserId,
      workspaceUrl: creds.workspaceUrl,
      credentialsSetAt: creds.now ?? new Date(),
    },
    select: { id: true },
  });
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

/** Disconnect: the tokens and every stored Slack row of this user. */
export async function disconnectSlack(userId: string): Promise<void> {
  await prisma.slackMessage.deleteMany({ where: { userId } });
  await prisma.slackEpisode.deleteMany({ where: { userId } });
  await prisma.slackConnection.deleteMany({ where: { userId } });
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
