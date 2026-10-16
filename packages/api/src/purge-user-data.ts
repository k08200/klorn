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
 * table below FKs to `User` (onDelete: Cascade). The other foreign keys among
 * them are CalendarEvent.sourceAccountId -> LinkedCalendarAccount (C2) and
 * DriveFile.sourceAccountId -> LinkedDriveAccount (D5a), which also cascade:
 * deleting an account removes its synced events or indexed files, and deleting
 * those never touches an account, so delete order is still unconstrained.
 */
export async function purgeUserData(tx: PurgeTx, userId: string): Promise<void> {
  const scope = { where: { userId } };

  // Secondary linked Google accounts hold live, decryptable OAuth access/refresh
  // tokens + the linked account's email — Google API data that must not survive
  // a deletion request (previously only removed by manual per-account unlink).
  await tx.linkedInboxAccount.deleteMany(scope);
  await tx.linkedCalendarAccount.deleteMany(scope);
  // A linked Google Drive / OneDrive account (D5a): its OAuth token pair and
  // address. Its cascade reaches only that account's GOOGLE/ONEDRIVE DriveFile
  // rows (a KLORN row has no account), never a Klorn file whose object must go
  // first.
  await tx.linkedDriveAccount.deleteMany(scope);
  // SenderTrait.evidenceText holds verbatim quoted email content.
  await tx.senderTrait.deleteMany(scope);
  // SenderLabel: the user's own relationship corrections, keyed by address.
  await tx.senderLabel.deleteMany(scope);
  // SentMessage: headers of the user's own sent mail.
  await tx.sentMessage.deleteMany(scope);
  // ImapMovedMessage: where trash/archive parked the user's Naver and iCloud mail
  // (folder, UID, subject and Message-ID of each message).
  await tx.imapMovedMessage.deleteMany(scope);
  // McpWriteAudit: what an agent changed through the user's API keys — opaque
  // message ids and argument hashes, no content, but still the user's history.
  await tx.mcpWriteAudit.deleteMany(scope);
  // API keys are REVOKED, not deleted: a purged account that re-links Google
  // must not be readable (or, with write tools on, writable) through a key
  // minted before the purge. The revoked row is inert — authenticateApiKey
  // rejects it — and stays so the audit history still names its key.
  await tx.apiKey.updateMany({
    where: { userId, revokedAt: null },
    data: { revokedAt: new Date() },
  });

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
  // DriveFileSummary: model summaries of the user's files (D4); DriveSummaryUsage:
  // their daily count. Both cascade with DriveFile and User; deleted by name so
  // this list stays the complete record.
  await tx.driveFileSummary.deleteMany(scope);
  await tx.driveSummaryUsage.deleteMany(scope);
  // DriveFile: the metadata index of the user's files (names, sizes, links). D2
  // writes no bytes; D3 must delete a Klorn file's object before its row goes.
  await tx.driveFile.deleteMany(scope);
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
