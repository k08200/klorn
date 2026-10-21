import type { db } from "./db.js";
import { NOT_KLORN_ADDRESS } from "./mail/klorn-mailbox.js";

/** The Prisma client (or a $transaction client cast to it) — exposes every model. */
type PurgeTx = typeof db;

/**
 * Delete every data-bearing row a user owns, keeping only the User account row.
 * Backs `DELETE /api/user/me/data`.
 *
 * Google / CASA require COMPLETE deletion of data obtained via Google APIs on
 * request, so this MUST stay exhaustive — every user-scoped model belongs here,
 * or in the test's KEPT_WITH_ACCOUNT list with its reason (a schema-driven
 * guard fails on any model with a userId that is neither).
 * A regression that drops one silently strands user data (this list has
 * regressed before: linked-account OAuth tokens and verbatim email excerpts
 * were surviving). `purge-user-data.test.ts` asserts the required set. Every
 * table below FKs to `User` (onDelete: Cascade). The other foreign keys among
 * them are CalendarEvent.sourceAccountId -> LinkedCalendarAccount (C2) and
 * DriveFile.sourceAccountId -> LinkedDriveAccount (D5a), which also cascade:
 * deleting an account removes its synced events or indexed files, and deleting
 * those never touches an account, so delete order is still unconstrained.
 */
const UTC_DAY_KEY_LENGTH = 10;

function utcDayKey(): string {
  return new Date().toISOString().slice(0, UTC_DAY_KEY_LENGTH);
}

/**
 * Remove what lets a sync, a scheduled job or an agent act for the user: the
 * primary and linked grants, the automation config, the API keys (revoked) and
 * the credentials kept on the account row. No background path re-creates a
 * grant (token refreshes are updates; only a consent flow the user starts
 * upserts one), so once this commits no new mail, calendar or drive sync starts
 * for the user. The one exception is pushed, not synced: the Klorn address's
 * mailbox (KLORN, step E1a) is kept, so mail sent to the address keeps arriving
 * after a wipe (the inbound webhook, E1b; it drops what predates the wipe). Not
 * every writer depends on these rows: the login-briefing
 * timer (routes/auth.ts) upserts the automation config, and the all-user jobs
 * (sender traits, digests) work from stored rows until those are gone. Part of
 * `purgeUserData`; the data wipe also runs it alone first, in its own short
 * transaction.
 */
export async function revokeUserAccess(tx: PurgeTx, userId: string): Promise<void> {
  const scope = { where: { userId } };

  // The primary Google grant. Its existence is the app-wide "has Gmail" check.
  await tx.userToken.deleteMany(scope);
  // Secondary linked Google accounts hold live, decryptable OAuth access/refresh
  // tokens + the linked account's email — Google API data that must not survive
  // a deletion request (previously only removed by manual per-account unlink).
  // The Klorn address's mailbox (KLORN, step E1a) is no grant: it holds no
  // credentials and belongs to the account like its address (KlornAddress, kept),
  // so mail to the address still arrives after a wipe. Its mail goes with
  // purgeUserData; account deletion's cascade takes the row.
  await tx.linkedInboxAccount.deleteMany({ where: { userId, ...NOT_KLORN_ADDRESS } });
  await tx.linkedCalendarAccount.deleteMany(scope);
  // A linked Google Drive / OneDrive account (D5a): its OAuth token pair and
  // address. Its cascade reaches only that account's GOOGLE/ONEDRIVE DriveFile
  // rows (a KLORN row has no account), never a Klorn file whose object must go
  // first.
  await tx.linkedDriveAccount.deleteMany(scope);
  // What the scheduler runs for the user (auto-mode, auto-reply, briefings).
  await tx.automationConfig.deleteMany(scope);
  // API keys are REVOKED, not deleted: a purged account that re-links Google
  // must not be readable (or, with write tools on, writable) through a key
  // minted before the purge. The revoked row is inert — authenticateApiKey
  // rejects it — and stays so the audit history still names its key.
  await tx.apiKey.updateMany({
    where: { userId, revokedAt: null },
    data: { revokedAt: new Date() },
  });
  // Credentials the user gave Klorn, kept on the account row: the retired Naver
  // IMAP and GitHub tokens, the user's own (BYOK) LLM keys, the Telegram link.
  // The account and its sign-in stay; these are re-entered after a wipe.
  await tx.user.updateMany({
    where: { id: userId },
    data: {
      naverImapEmail: null,
      naverImapPasswordCipher: null,
      naverImapHost: null,
      naverImapConnectedAt: null,
      githubTokenCipher: null,
      githubConnectedAt: null,
      githubLastPolledAt: null,
      openRouterApiKey: null,
      geminiApiKey: null,
      telegramChatId: null,
      telegramLinkCode: null,
      telegramLinkCodeExpiresAt: null,
    },
  });
}

export async function purgeUserData(tx: PurgeTx, userId: string): Promise<void> {
  const scope = { where: { userId } };

  await revokeUserAccess(tx, userId);
  // SenderTrait.evidenceText holds verbatim quoted email content.
  await tx.senderTrait.deleteMany(scope);
  // SenderLabel: the user's own relationship corrections, keyed by address.
  await tx.senderLabel.deleteMany(scope);
  // SentMessage: headers of the user's own sent mail.
  await tx.sentMessage.deleteMany(scope);
  // SendReceipt: the floor receipt of each manual send — recipient (receipt
  // target) and payload hash, written while MANUAL_SEND_RECEIPTS_ENABLED is on.
  await tx.sendReceipt.deleteMany(scope);
  // ImapMovedMessage: where trash/archive parked the user's Naver and iCloud mail
  // (folder, UID, subject and Message-ID of each message).
  await tx.imapMovedMessage.deleteMany(scope);
  // McpWriteAudit: what an agent changed through the user's API keys — opaque
  // message ids and argument hashes, no content, but still the user's history.
  await tx.mcpWriteAudit.deleteMany(scope);

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
  // Today's ledger row holds counts only (no content) and IS the daily spend
  // cap: deleting it would let repeated wipes reset the cap.
  await tx.llmCostLedger.deleteMany({ where: { userId, dayKey: { not: utcDayKey() } } });
  await tx.llmUsageLog.deleteMany(scope);
  await tx.pushSubscription.deleteMany(scope);
  await tx.notification.deleteMany(scope);
  await tx.agentLog.deleteMany(scope);
  await tx.calendarEvent.deleteMany(scope);
  // DriveFileSummary: model summaries of the user's files (D4); DriveSummaryUsage:
  // their daily count. Both cascade with DriveFile and User; deleted by name so
  // this list stays the complete record.
  await tx.driveFileSummary.deleteMany(scope);
  await tx.driveSummaryUsage.deleteMany(scope);
  // DriveFile: the metadata index of the user's files (names, sizes, links). D2
  // writes no bytes; D3 must delete a Klorn file's object before its row goes.
  await tx.driveFile.deleteMany(scope);
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
  // Built from the user's mail (Gmail data): summaries of contacts and threads,
  // and the screener's decisions about senders.
  await tx.contactDossier.deleteMany(scope);
  await tx.threadBrief.deleteMany(scope);
  await tx.screenerDecision.deleteMany(scope);
  // Agent actions awaiting approval can hold drafts and mail excerpts; most
  // cascade from their conversation, these catch any that do not.
  await tx.pendingAction.deleteMany(scope);
  await tx.analyticsEvent.deleteMany(scope);
  await tx.pmfResponse.deleteMany(scope);
  // Third-party addresses the user typed (like contacts); owner-scoped, never shared.
  await tx.team.deleteMany(scope);
}
