/**
 * Organization invites (Klorn Teams v1). The owner invites by email; the mail
 * goes out through the existing transactional path (mail/email.ts, Resend).
 *
 * Token security: only the SHA-256 is stored (invite-token.ts); an invite is
 * single use (a conditional update claims it inside the same transaction that
 * creates the membership, under the organization's lock, so two concurrent
 * accepts cannot both succeed); it expires after seven days; and it binds to
 * the invited address — the signed-in account's VERIFIED email must match it.
 * Re-inviting an address revokes its earlier pending invite.
 *
 * Abuse: inviting needs a verified address, and the database caps invites
 * per organization per day and per recipient per day across organizations, so
 * the invite mail cannot be turned into a relay.
 */

import { prisma } from "../db.js";
import { sendOrgInviteEmail } from "../mail/email.js";
import { recordOrgAudit } from "./audit.js";
import { seatsActive } from "./effective-tier.js";
import {
  hashInviteToken,
  inviteExpiry,
  isWellFormedInviteToken,
  mintInviteToken,
} from "./invite-token.js";
import { OrgError } from "./org-error.js";
import { type OrgTx, ownerInTx, requireVerifiedEmail, withOrgLock } from "./org-lock.js";
import { currentOrgView, findMembership, requireOwner } from "./org-members.js";
import { MAX_SELF_SERVE_SEATS, normalizeEmail } from "./org-shape.js";

/** Invites an organization without an active subscription may send a day. */
export const UNPAID_ORG_INVITES_PER_DAY = 20;
/** Invites one address may receive a day, across every organization. */
export const RECIPIENT_INVITES_PER_DAY = 3;
const DAY_MS = 24 * 60 * 60 * 1000;

export interface InviteWire {
  id: string;
  email: string;
  expiresAt: string;
  createdAt: string;
}

function inviteWire(invite: { id: string; email: string; expiresAt: Date; createdAt: Date }) {
  return {
    id: invite.id,
    email: invite.email,
    expiresAt: invite.expiresAt.toISOString(),
    createdAt: invite.createdAt.toISOString(),
  };
}

function pendingWhere(orgId: string, now: Date) {
  return { orgId, acceptedAt: null, revokedAt: null, expiresAt: { gt: now } };
}

/** Membership, seat and send-rate limits, read under the organization's lock. */
async function assertInviteAllowed(tx: OrgTx, orgId: string, email: string, now: Date) {
  const dayAgo = new Date(now.getTime() - DAY_MS);
  const [members, pending, orgToday, recipientToday, org] = await Promise.all([
    tx.orgMembership.findMany({ where: { orgId }, select: { user: { select: { email: true } } } }),
    tx.orgInvite.count({ where: { ...pendingWhere(orgId, now), email: { not: email } } }),
    tx.orgInvite.count({ where: { orgId, createdAt: { gte: dayAgo } } }),
    tx.orgInvite.count({ where: { email, createdAt: { gte: dayAgo } } }),
    tx.organization.findUnique({ where: { id: orgId }, select: { subscriptionStatus: true } }),
  ]);
  if (members.some((member) => member.user.email.toLowerCase() === email)) {
    throw new OrgError(409, "ALREADY_MEMBER", "That address is already a member.");
  }
  if (members.length + pending + 1 > MAX_SELF_SERVE_SEATS) {
    throw new OrgError(
      409,
      "MEMBER_LIMIT",
      `A self-serve organization holds up to ${MAX_SELF_SERVE_SEATS} members and pending invites.`,
    );
  }
  const orgCap = seatsActive(org?.subscriptionStatus)
    ? MAX_SELF_SERVE_SEATS
    : UNPAID_ORG_INVITES_PER_DAY;
  if (orgToday >= orgCap || recipientToday >= RECIPIENT_INVITES_PER_DAY) {
    throw new OrgError(429, "INVITE_LIMIT", "Too many invites today. Try again tomorrow.");
  }
}

export async function inviteMember(userId: string, body: unknown): Promise<InviteWire> {
  const email = normalizeEmail(((body ?? {}) as { email?: unknown }).email);
  if (!email) throw new OrgError(400, "INVALID_EMAIL", "Enter a valid email address.");
  await requireVerifiedEmail(userId);
  const owner = await requireOwner(userId);
  const now = new Date();
  const { token, tokenHash } = mintInviteToken();
  const invite = await withOrgLock(owner.orgId, async (tx) => {
    await ownerInTx(tx, userId, owner.orgId);
    await assertInviteAllowed(tx, owner.orgId, email, now);
    await tx.orgInvite.updateMany({
      where: { orgId: owner.orgId, email, acceptedAt: null, revokedAt: null },
      data: { revokedAt: now },
    });
    const created = await tx.orgInvite.create({
      data: {
        orgId: owner.orgId,
        email,
        tokenHash,
        invitedById: userId,
        expiresAt: inviteExpiry(now),
      },
      select: { id: true, email: true, expiresAt: true, createdAt: true },
    });
    await recordOrgAudit(tx, {
      orgId: owner.orgId,
      action: "invite.created",
      actorUserId: userId,
      detail: { email, inviteId: created.id },
    });
    return created;
  });
  await sendInvite(userId, owner.org.name, invite.id, email, token);
  return inviteWire(invite);
}

async function sendInvite(
  userId: string,
  orgName: string,
  inviteId: string,
  email: string,
  token: string,
) {
  const inviter = await prisma.user.findUnique({
    where: { id: userId },
    select: { name: true, email: true },
  });
  const sent = await sendOrgInviteEmail({
    to: email,
    token,
    orgName,
    inviterName: inviter?.name || inviter?.email || null,
  });
  if (sent) return;
  // Nothing reached the recipient: the invite goes (so it does not count
  // against the day's limits) and the audit log says the send failed.
  const deleted = await prisma.orgInvite.findUnique({
    where: { id: inviteId },
    select: { orgId: true },
  });
  await prisma.orgInvite.deleteMany({ where: { id: inviteId } });
  if (deleted) {
    await recordOrgAudit(prisma, {
      orgId: deleted.orgId,
      action: "invite.email_failed",
      actorUserId: userId,
      detail: { inviteId },
    });
  }
  throw new OrgError(502, "INVITE_EMAIL_FAILED", "The invite email could not be sent. Try again.");
}

export async function listInvites(userId: string): Promise<InviteWire[]> {
  const owner = await requireOwner(userId);
  const invites = await prisma.orgInvite.findMany({
    where: pendingWhere(owner.orgId, new Date()),
    orderBy: { createdAt: "desc" },
    select: { id: true, email: true, expiresAt: true, createdAt: true },
  });
  return invites.map(inviteWire);
}

export async function revokeInvite(userId: string, inviteId: string) {
  const owner = await requireOwner(userId);
  const revoked = await withOrgLock(owner.orgId, async (tx) => {
    await ownerInTx(tx, userId, owner.orgId);
    const result = await tx.orgInvite.updateMany({
      where: { id: inviteId, orgId: owner.orgId, acceptedAt: null, revokedAt: null },
      data: { revokedAt: new Date() },
    });
    if (result.count !== 1) return false;
    await recordOrgAudit(tx, {
      orgId: owner.orgId,
      action: "invite.revoked",
      actorUserId: userId,
      detail: { inviteId },
    });
    return true;
  });
  if (!revoked) throw new OrgError(404, "INVITE_NOT_FOUND", "No such pending invite.");
  return { revoked: true as const };
}

const INVALID = () => new OrgError(404, "INVITE_INVALID", "This invite link is not valid.");

/** The invite a token names, if it can still be accepted. */
async function usableInvite(rawToken: unknown, now: Date) {
  if (!isWellFormedInviteToken(rawToken)) throw INVALID();
  const invite = await prisma.orgInvite.findUnique({
    where: { tokenHash: hashInviteToken(rawToken) },
    select: {
      id: true,
      orgId: true,
      email: true,
      expiresAt: true,
      acceptedAt: true,
      revokedAt: true,
      org: { select: { name: true } },
    },
  });
  if (!invite || invite.revokedAt) throw INVALID();
  if (invite.acceptedAt) throw new OrgError(410, "INVITE_USED", "This invite was already used.");
  if (invite.expiresAt <= now) {
    throw new OrgError(410, "INVITE_EXPIRED", "This invite has expired. Ask for a new one.");
  }
  return invite;
}

export async function previewInvite(userId: string, body: unknown) {
  const invite = await usableInvite(((body ?? {}) as { token?: unknown }).token, new Date());
  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: { email: true, emailVerified: true },
  });
  return {
    orgName: invite.org.name,
    expiresAt: invite.expiresAt.toISOString(),
    emailMatches: (user?.email ?? "").trim().toLowerCase() === invite.email,
    emailVerified: user?.emailVerified === true,
  };
}

export async function acceptInvite(userId: string, body: unknown) {
  const input = (body ?? {}) as { token?: unknown; shareFreeBusy?: unknown };
  const now = new Date();
  const invite = await usableInvite(input.token, now);
  // A session can exist before its address is verified, so the binding is to
  // the VERIFIED address: holding a forwarded link is not enough.
  if ((await requireVerifiedEmail(userId)) !== invite.email) {
    throw new OrgError(
      403,
      "INVITE_EMAIL_MISMATCH",
      "This invite was sent to a different address. Sign in with that address to accept it.",
    );
  }
  if (await findMembership(userId)) {
    throw new OrgError(409, "ALREADY_IN_ORG", "You are already in an organization.");
  }
  const scope = input.shareFreeBusy === true ? "FREEBUSY" : "NONE";
  try {
    await withOrgLock(invite.orgId, async (tx) => {
      const claimed = await tx.orgInvite.updateMany({
        where: { id: invite.id, acceptedAt: null, revokedAt: null, expiresAt: { gt: now } },
        data: { acceptedAt: now, acceptedById: userId },
      });
      if (claimed.count !== 1) {
        throw new OrgError(410, "INVITE_USED", "This invite was already used.");
      }
      await tx.orgMembership.create({
        data: { orgId: invite.orgId, userId, role: "MEMBER" },
        select: { id: true },
      });
      await tx.availabilityGrant.upsert({
        where: { userId },
        create: { userId, orgId: invite.orgId, scope },
        update: { orgId: invite.orgId, scope },
        select: { userId: true },
      });
      await recordOrgAudit(tx, {
        orgId: invite.orgId,
        action: "member.joined",
        actorUserId: userId,
        targetUserId: userId,
        detail: { sharesFreeBusy: scope === "FREEBUSY" },
      });
    });
  } catch (err) {
    if ((err as { code?: string })?.code === "P2002") {
      throw new OrgError(409, "ALREADY_IN_ORG", "You are already in an organization.");
    }
    // The organization was closed between the link and the accept.
    if (err instanceof OrgError && err.code === "NOT_IN_ORG") throw INVALID();
    throw err;
  }
  return currentOrgView(userId);
}
