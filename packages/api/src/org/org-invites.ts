/**
 * Organization invites (Klorn Teams v1). The owner invites by email; the mail
 * goes out through the existing transactional path (mail/email.ts, Resend).
 *
 * Token security: only the SHA-256 is stored (invite-token.ts); an invite is
 * single use (a conditional update claims it inside the same transaction that
 * creates the membership, so two concurrent accepts cannot both succeed);
 * it expires after seven days; and it binds to the invited address — the
 * signed-in account's email must match it. Re-inviting an address revokes its
 * earlier pending invite.
 */

import { INTERACTIVE_TX_OPTIONS, prisma } from "../db.js";
import { sendOrgInviteEmail } from "../mail/email.js";
import { recordOrgAudit } from "./audit.js";
import {
  hashInviteToken,
  inviteExpiry,
  isWellFormedInviteToken,
  mintInviteToken,
} from "./invite-token.js";
import { OrgError } from "./org-error.js";
import { currentOrgView, findMembership, requireOwner } from "./org-members.js";
import { MAX_SELF_SERVE_SEATS, normalizeEmail } from "./org-shape.js";

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

export async function inviteMember(userId: string, body: unknown): Promise<InviteWire> {
  const owner = await requireOwner(userId);
  const email = normalizeEmail(((body ?? {}) as { email?: unknown }).email);
  if (!email) throw new OrgError(400, "INVALID_EMAIL", "Enter a valid email address.");
  const now = new Date();
  const [members, pending, inviter] = await Promise.all([
    prisma.orgMembership.findMany({
      where: { orgId: owner.orgId },
      select: { user: { select: { email: true } } },
    }),
    prisma.orgInvite.count({ where: { ...pendingWhere(owner.orgId, now), email: { not: email } } }),
    prisma.user.findUnique({ where: { id: userId }, select: { name: true, email: true } }),
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
  const { token, tokenHash } = mintInviteToken();
  const invite = await prisma.$transaction(async (tx) => {
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
      detail: { email },
    });
    return created;
  }, INTERACTIVE_TX_OPTIONS);

  const sent = await sendOrgInviteEmail({
    to: email,
    token,
    orgName: owner.org.name,
    inviterName: inviter?.name || inviter?.email || null,
  });
  if (!sent) {
    await prisma.orgInvite.updateMany({
      where: { id: invite.id },
      data: { revokedAt: new Date() },
    });
    throw new OrgError(
      502,
      "INVITE_EMAIL_FAILED",
      "The invite email could not be sent. Try again.",
    );
  }
  return inviteWire(invite);
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
  const now = new Date();
  const revoked = await prisma.$transaction(async (tx) => {
    const result = await tx.orgInvite.updateMany({
      where: { id: inviteId, orgId: owner.orgId, acceptedAt: null, revokedAt: null },
      data: { revokedAt: now },
    });
    if (result.count === 1) {
      await recordOrgAudit(tx, {
        orgId: owner.orgId,
        action: "invite.revoked",
        actorUserId: userId,
        detail: { inviteId },
      });
    }
    return result.count === 1;
  }, INTERACTIVE_TX_OPTIONS);
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

async function signedInEmail(userId: string): Promise<string> {
  const user = await prisma.user.findUnique({ where: { id: userId }, select: { email: true } });
  return (user?.email ?? "").trim().toLowerCase();
}

export async function previewInvite(userId: string, body: unknown) {
  const invite = await usableInvite(((body ?? {}) as { token?: unknown }).token, new Date());
  return {
    orgName: invite.org.name,
    expiresAt: invite.expiresAt.toISOString(),
    emailMatches: (await signedInEmail(userId)) === invite.email,
  };
}

export async function acceptInvite(userId: string, body: unknown) {
  const input = (body ?? {}) as { token?: unknown; shareFreeBusy?: unknown };
  const now = new Date();
  const invite = await usableInvite(input.token, now);
  if ((await signedInEmail(userId)) !== invite.email) {
    throw new OrgError(
      403,
      "INVITE_EMAIL_MISMATCH",
      "This invite was sent to a different address. Sign in with that address to accept it.",
    );
  }
  if (await findMembership(userId)) {
    throw new OrgError(409, "ALREADY_IN_ORG", "You are already in an organization.");
  }
  const share = input.shareFreeBusy === true;
  try {
    await prisma.$transaction(async (tx) => {
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
        create: { userId, orgId: invite.orgId, scope: share ? "FREEBUSY" : "NONE" },
        update: { orgId: invite.orgId, scope: share ? "FREEBUSY" : "NONE" },
        select: { userId: true },
      });
      await recordOrgAudit(tx, {
        orgId: invite.orgId,
        action: "member.joined",
        actorUserId: userId,
        targetUserId: userId,
        detail: { sharesFreeBusy: share },
      });
    }, INTERACTIVE_TX_OPTIONS);
  } catch (err) {
    if ((err as { code?: string })?.code === "P2002") {
      throw new OrgError(409, "ALREADY_IN_ORG", "You are already in an organization.");
    }
    throw err;
  }
  return currentOrgView(userId);
}
