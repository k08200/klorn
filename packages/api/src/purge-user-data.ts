import type { db } from "./db.js";

/** The Prisma client (or a $transaction client cast to it) — exposes every model. */
type PurgeTx = typeof db;

/**
 * Delete every data-bearing row a user owns, keeping only the User account row.
 * Backs `DELETE /api/user/me/data`.
 *
 * Google / CASA require COMPLETE deletion of data obtained via Google APIs on
 * request, so this MUST stay exhaustive — every user-scoped model belongs here.
 * A regression that drops one silently strands user data (this list has
 * regressed before: linked-account OAuth tokens and verbatim email excerpts
 * were surviving). `purge-user-data.test.ts` asserts the required set. Every
 * table below FKs only to `User` (onDelete: Cascade), so delete order is
 * unconstrained.
 */
export async function purgeUserData(tx: PurgeTx, userId: string): Promise<void> {
  const scope = { where: { userId } };

  // Secondary linked Google accounts hold live, decryptable OAuth access/refresh
  // tokens + the linked account's email — Google API data that must not survive
  // a deletion request (previously only removed by manual per-account unlink).
  await tx.linkedInboxAccount.deleteMany(scope);
  await tx.linkedCalendarAccount.deleteMany(scope);
  // SenderTrait.evidenceText holds verbatim quoted email content.
  await tx.senderTrait.deleteMany(scope);

  await tx.emailAttachment.deleteMany(scope);
  await tx.candidateIntake.deleteMany(scope);
  await tx.emailLabelFeedback.deleteMany(scope);
  await tx.emailProcessingLog.deleteMany(scope);
  await tx.emailMessage.deleteMany(scope);
  await tx.emailRule.deleteMany(scope);
  await tx.decisionLabel.deleteMany(scope);
  await tx.learnedRule.deleteMany(scope);
  await tx.calibrationSnapshot.deleteMany(scope);
  await tx.devicePushToken.deleteMany(scope);
  await tx.device.deleteMany(scope);
  await tx.pushDeliveryLog.deleteMany(scope);
  await tx.pushRingEvent.deleteMany(scope);
  await tx.phoneEscalation.deleteMany(scope);
  await tx.actionOutbox.deleteMany(scope);
  await tx.skill.deleteMany(scope);
  await tx.activatedPlaybook.deleteMany(scope);
  await tx.feedbackPolicyPreference.deleteMany(scope);
  await tx.workContextSnapshot.deleteMany(scope);
  await tx.llmCostLedger.deleteMany(scope);
  await tx.llmUsageLog.deleteMany(scope);
  await tx.pushSubscription.deleteMany(scope);
  await tx.notification.deleteMany(scope);
  await tx.agentLog.deleteMany(scope);
  await tx.automationConfig.deleteMany(scope);
  await tx.calendarEvent.deleteMany(scope);
  await tx.userToken.deleteMany(scope);
  await tx.tokenUsage.deleteMany(scope);
  await tx.memory.deleteMany(scope);
  await tx.conversationSummary.deleteMany({ where: { conversation: { userId } } });
  await tx.message.deleteMany({ where: { conversation: { userId } } });
  await tx.conversation.deleteMany(scope);
  await tx.task.deleteMany(scope);
  await tx.note.deleteMany(scope);
  await tx.contactEngagementScore.deleteMany(scope);
  await tx.contactTrustScore.deleteMany(scope);
  await tx.contact.deleteMany(scope);
  await tx.reminder.deleteMany(scope);
  await tx.commitment.deleteMany(scope);
  await tx.feedbackEvent.deleteMany(scope);
  await tx.attentionItem.deleteMany(scope);
}
