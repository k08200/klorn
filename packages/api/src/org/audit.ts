/**
 * The organization audit log (Klorn Teams launch feature 7): every admin
 * action and every cross-member free/busy read. A row names the actor and the
 * target by user id and carries non-content detail only (window bounds, an
 * invited address, the settings that changed). Never mail data.
 */

import type { Prisma } from "@prisma/client";

export type OrgAuditAction =
  | "org.created"
  | "settings.changed"
  | "invite.created"
  | "invite.revoked"
  | "invite.email_failed"
  | "member.joined"
  | "member.removed"
  | "member.left"
  | "owner.transferred"
  | "owner.succeeded"
  | "availability.grant_changed"
  | "availability.read";

export interface OrgAuditInput {
  orgId: string;
  action: OrgAuditAction;
  actorUserId: string | null;
  targetUserId?: string | null;
  detail?: Prisma.InputJsonValue;
}

/** Anything with the audit model: the client or an interactive transaction. */
interface AuditWriter {
  orgAuditEvent: { create(args: { data: Prisma.OrgAuditEventUncheckedCreateInput }): unknown };
}

export async function recordOrgAudit(client: AuditWriter, input: OrgAuditInput): Promise<void> {
  await client.orgAuditEvent.create({
    data: {
      orgId: input.orgId,
      action: input.action,
      actorUserId: input.actorUserId,
      targetUserId: input.targetUserId ?? null,
      ...(input.detail === undefined ? {} : { detail: input.detail }),
    },
  });
}
