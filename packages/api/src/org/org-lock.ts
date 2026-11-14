/**
 * Serialization for organization changes. Every transaction that adds,
 * removes or re-roles a membership — or deletes the organization — first
 * takes the organization row's lock with a no-op update. Two such changes to
 * the same organization therefore run one after the other, and each re-reads
 * the roles and counts it decides on inside its own transaction: a leave
 * cannot delete an owner a concurrent transfer just promoted, and an owner
 * closing the organization cannot drop a member an accept just added. The
 * partial unique index OrgMembership_one_owner_per_org backs the one-OWNER
 * rule in the database itself.
 */

import { Prisma } from "@prisma/client";
import { INTERACTIVE_TX_OPTIONS, prisma } from "../db.js";
import { OrgError } from "./org-error.js";

export type OrgTx = Prisma.TransactionClient;

function isRecordNotFound(err: unknown): boolean {
  return err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2025";
}

/** Run `work` holding the organization's row lock; a vanished organization is NOT_IN_ORG. */
export async function withOrgLock<T>(orgId: string, work: (tx: OrgTx) => Promise<T>): Promise<T> {
  return prisma.$transaction(async (tx) => {
    try {
      await tx.organization.update({
        where: { id: orgId },
        data: { updatedAt: new Date() },
        select: { id: true },
      });
    } catch (err) {
      if (isRecordNotFound(err)) {
        throw new OrgError(404, "NOT_IN_ORG", "That organization no longer exists.");
      }
      throw err;
    }
    return work(tx);
  }, INTERACTIVE_TX_OPTIONS);
}

/** The caller's membership as the locked transaction sees it. */
export async function membershipInTx(tx: OrgTx, userId: string, orgId: string) {
  const mine = await tx.orgMembership.findUnique({
    where: { userId },
    select: { id: true, role: true, orgId: true },
  });
  if (!mine || mine.orgId !== orgId) {
    throw new OrgError(404, "NOT_IN_ORG", "You are not in an organization.");
  }
  return mine;
}

export async function ownerInTx(tx: OrgTx, userId: string, orgId: string) {
  const mine = await membershipInTx(tx, userId, orgId);
  if (mine.role !== "OWNER") {
    throw new OrgError(403, "OWNER_ONLY", "Only the organization's owner can do this.");
  }
  return mine;
}

/** Organization creation, invites and accepts need a verified address. */
export async function requireVerifiedEmail(userId: string): Promise<string> {
  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: { email: true, emailVerified: true },
  });
  if (!user?.emailVerified) {
    throw new OrgError(403, "EMAIL_NOT_VERIFIED", "Verify your email address first.");
  }
  return user.email.trim().toLowerCase();
}
