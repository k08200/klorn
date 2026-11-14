import type { FastifyInstance } from "fastify";
import {
  caldavCalendarEnabled,
  deviceCalendarEnabled,
  driveEnabled,
  genericImapEnabled,
  icloudInboxEnabled,
  klornMailboxEnabled,
  outlookInboxEnabled,
} from "./config.js";
import { IMAP_PROVIDERS } from "./mail/imap-providers.js";
import { briefingRoutes } from "./pim/briefing.js";
import { adminRoutes } from "./routes/admin.js";
import { alertEndpointRoutes } from "./routes/alert-endpoints.js";
import { analyticsRoutes } from "./routes/analytics.js";
import { apiKeyRoutes } from "./routes/api-keys.js";
import { authRoutes } from "./routes/auth.js";
import { automationRoutes } from "./routes/automations.js";
import { billingRoutes } from "./routes/billing.js";
import { caldavCalendarRoutes } from "./routes/caldav-calendar.js";
import { calendarRoutes } from "./routes/calendar.js";
import { chatConversationRoutes } from "./routes/chat-conversations.js";
import { chatRoutes } from "./routes/chat-pending-actions.js";
import { commitmentRoutes } from "./routes/commitments.js";
import { registerCoreRoutes } from "./routes/core.js";
import { cronRoutes } from "./routes/cron.js";
import { desktopReceiptRoutes } from "./routes/desktop-receipts.js";
import { deviceCalendarRoutes } from "./routes/device-calendar.js";
import { deviceRoutes } from "./routes/devices.js";
import { diagnosticsRoutes } from "./routes/diagnostics.js";
import { driveRoutes } from "./routes/drive.js";
import { emailRoutes } from "./routes/email.js";
import { feedbackRoutes } from "./routes/feedback.js";
import { firewallRoutes } from "./routes/firewall.js";
import { gmailPushRoutes } from "./routes/gmail-push.js";
import { googleDriveLinkRoutes, googleDriveRoutesEnabled } from "./routes/google-drive-link.js";
import { imapConnectRoutes } from "./routes/imap-connect.js";
import { registerImapPresetRoutes } from "./routes/imap-preset-routes.js";
import { inboxRoutes } from "./routes/inbox.js";
import { klornDriveRoutes, klornDriveRoutesEnabled } from "./routes/klorn-drive.js";
import { klornMailboxInboundRoutes } from "./routes/klorn-mailbox-inbound.js";
import { linkCompleteRoutes } from "./routes/link-complete.js";
import { mcpRoutes } from "./routes/mcp.js";
import { memoryRoutes } from "./routes/memory.js";
import { notificationRoutes } from "./routes/notifications.js";
import { opsRoutes } from "./routes/ops.js";
import { orgRoutes } from "./routes/orgs.js";
import { outlookAuthRoutes } from "./routes/outlook-auth.js";
import { patternRoutes } from "./routes/patterns.js";
import { phoneRoutes } from "./routes/phone.js";
import { playbookRoutes } from "./routes/playbooks.js";
import { playgroundRoutes } from "./routes/playground.js";
import { pmfRoutes } from "./routes/pmf.js";
import { providersAvailableRoutes } from "./routes/providers-available.js";
import { receiptRoutes } from "./routes/receipt.js";
import { rulesDslRoutes } from "./routes/rules-dsl.js";
import { screenerRoutes } from "./routes/screener.js";
import { skillRoutes } from "./routes/skills.js";
import { slackConnectionRoutes } from "./routes/slack-connection.js";
import { slackEventsRoutes } from "./routes/slack-events.js";
import { smartActionsRoutes } from "./routes/smart-actions.js";
import { smsRoutes } from "./routes/sms.js";
import { appleAuthProvider, naverAuthProvider, socialAuthRoutes } from "./routes/social-auth.js";
import { teamRoutes } from "./routes/teams.js";
import { telegramRoutes } from "./routes/telegram.js";
import { tokenUsageRoutes } from "./routes/token-usage.js";
import { vaultExportRoutes } from "./routes/vault-export.js";
import { webhookRoutes } from "./routes/webhook.js";
import { installRouteAuthGuard } from "./security/route-auth-guard.js";

/**
 * Every HTTP route the API serves, in one place, so the production server
 * (index.ts) and the route-inventory test register exactly the same set.
 *
 * The route-auth guard is installed FIRST: it is an onRoute hook, and Fastify
 * only runs onRoute hooks for routes declared after the hook is added. Every
 * route below therefore gets the active-session check unless it is listed in
 * security/route-auth-exemptions.ts (see route-auth-guard.ts).
 */
export async function registerApiRoutes(app: FastifyInstance): Promise<void> {
  installRouteAuthGuard(app);

  await app.register(billingRoutes, { prefix: "/api/billing" });
  await app.register(deviceRoutes, { prefix: "/api/devices" });
  await app.register(teamRoutes, { prefix: "/api/teams" });
  await app.register(orgRoutes, { prefix: "/api/orgs" });
  await app.register(webhookRoutes, { prefix: "/api/webhook" });
  await app.register(chatRoutes, { prefix: "/api/chat" });
  await app.register(chatConversationRoutes, { prefix: "/api/chat" });
  await app.register(authRoutes, { prefix: "/api/auth" });
  // POST /api/auth/link/complete: finishes every account-link OAuth flow (Google
  // connect/calendar/inbox, Outlook inbox/calendar) for the session that started
  // it. Its Outlook flows re-check their flags at completion (defaults: the same
  // OUTLOOK_INBOX_ENABLED / OUTLOOK_CALENDAR_ENABLED gates as the routes below).
  await app.register(linkCompleteRoutes(), { prefix: "/api/auth" });
  await app.register(briefingRoutes, { prefix: "/api/briefing" });
  await app.register(notificationRoutes, { prefix: "/api/notifications" });
  await app.register(alertEndpointRoutes, { prefix: "/api/notifications/alert-endpoints" });
  await app.register(desktopReceiptRoutes, { prefix: "/api/notifications/desktop/receipts" });
  await app.register(opsRoutes, { prefix: "/api/ops" });
  await app.register(cronRoutes, { prefix: "/api/cron" });
  await app.register(diagnosticsRoutes, { prefix: "/api/diagnostics" });
  await app.register(inboxRoutes, { prefix: "/api/inbox" });
  await app.register(firewallRoutes, { prefix: "/api/inbox/firewall" });
  await app.register(receiptRoutes, { prefix: "/api/inbox/receipt" });
  await app.register(playbookRoutes, { prefix: "/api/playbooks" });
  await app.register(commitmentRoutes, { prefix: "/api/commitments" });
  await app.register(feedbackRoutes, { prefix: "/api/feedback" });
  await app.register(calendarRoutes, { prefix: "/api/calendar" });
  await app.register(smartActionsRoutes, { prefix: "/api/smart-actions" });
  await app.register(vaultExportRoutes, { prefix: "/api/user/me/vault" });
  await app.register(rulesDslRoutes, { prefix: "/api/email/rules/dsl" });
  await app.register(emailRoutes, { prefix: "/api/email" });
  await app.register(apiKeyRoutes, { prefix: "/api/keys" });
  await app.register(mcpRoutes, { prefix: "/api/mcp" });
  await app.register(gmailPushRoutes, { prefix: "/api/gmail" });
  await app.register(automationRoutes, { prefix: "/api/automations" });
  await app.register(pmfRoutes, { prefix: "/api/pmf" });
  await app.register(screenerRoutes, { prefix: "/api/screener" });
  await app.register(playgroundRoutes, { prefix: "/api/playground" });
  await app.register(adminRoutes, { prefix: "/api/admin" });
  await app.register(analyticsRoutes, { prefix: "/api/analytics" });
  await app.register(memoryRoutes, { prefix: "/api/memories" });
  await app.register(imapConnectRoutes(IMAP_PROVIDERS.NAVER), { prefix: "/api/naver-imap" });
  // Phase 2: dark until ICLOUD_INBOX_ENABLED — every route (auth'd or not)
  // answers 404 while the flag is off (CASA surface freeze).
  await app.register(imapConnectRoutes(IMAP_PROVIDERS.ICLOUD, { gate: icloudInboxEnabled }), {
    prefix: "/api/icloud-imap",
  });
  // Step B4: generic IMAP with a user-supplied host — dark until GENERIC_IMAP_ENABLED
  // (same cloaked 404 while off; the flag is not to be flipped before the SSRF review).
  await app.register(imapConnectRoutes(IMAP_PROVIDERS.IMAP, { gate: genericImapEnabled }), {
    prefix: "/api/generic-imap",
  });
  // Provider phase 2: the app-password presets (Daum, Kakao, Yahoo, AOL, Fastmail,
  // Zoho), one /api/<preset>-imap plugin each, dark until IMAP_PRESETS_ENABLED.
  await registerImapPresetRoutes(app);
  // Phase 3: dark until OUTLOOK_INBOX_ENABLED — same 404 gate as iCloud.
  await app.register(outlookAuthRoutes({ gate: outlookInboxEnabled }), {
    prefix: "/api/auth/outlook",
  });
  // Step C3: iCloud and Naver calendars over CalDAV, dark until CALDAV_CALENDAR_ENABLED
  // (every route answers the default 404 while off).
  await app.register(caldavCalendarRoutes({ gate: caldavCalendarEnabled }), {
    prefix: "/api/caldav-calendar",
  });
  // Step C6: calendars the desktop app uploads from the device (EventKit), one opted-in
  // calendar at a time — dark until DEVICE_CALENDAR_ENABLED (the default 404 while off,
  // which the Mac app reads as "hide the setting").
  await app.register(deviceCalendarRoutes({ gate: deviceCalendarEnabled }), {
    prefix: "/api/device-calendar",
  });
  // The drive's read-only metadata routes (step D2) — dark until DRIVE_ENABLED.
  await app.register(driveRoutes({ gate: driveEnabled }), { prefix: "/api/drive" });
  // The Klorn drive (step D3): upload, folders, download, rename/move, delete —
  // dark until DRIVE_ENABLED, KLORN_DRIVE_ENABLED and OBJECT_STORAGE_ENABLED are on.
  await app.register(klornDriveRoutes({ gate: klornDriveRoutesEnabled }), { prefix: "/api/drive" });
  // Google Drive link and unlink (step D5b) — dark until DRIVE_ENABLED and
  // GOOGLE_DRIVE_ENABLED are both on. The consent's callback is routes/auth.ts's.
  await app.register(googleDriveLinkRoutes({ gate: googleDriveRoutesEnabled }), {
    prefix: "/api/drive/google",
  });
  // The Klorn mailbox's inbound webhook (step E1b): Resend Inbound's email.received,
  // dark until KLORN_MAILBOX_ENABLED. Its own plugin, so the gate cannot reach the
  // Stripe and Paddle webhooks.
  await app.register(klornMailboxInboundRoutes({ gate: klornMailboxEnabled }), {
    prefix: "/api/mailbox",
  });
  // Slack integration v1 (docs/providers/slack.md), dark until SLACK_ENABLED. The
  // events webhook is its own plugin: its raw-body parser must not reach any
  // other route, and it verifies Slack's signature before parsing anything.
  await app.register(slackEventsRoutes, { prefix: "/api/slack" });
  await app.register(slackConnectionRoutes, { prefix: "/api/slack" });
  // Which account types this deployment can connect, for the first run's provider
  // grid (productization plan P8) — dark until ONBOARDING_V2 (the default 404 while off).
  await app.register(providersAvailableRoutes, { prefix: "/api/providers" });
  // Social LOGIN providers beyond Google — dark until APPLE_LOGIN_ENABLED /
  // NAVER_LOGIN_ENABLED flip; every route answers the cloaked 404 while off
  // (same CASA surface freeze as the dark IMAP providers above).
  await app.register(socialAuthRoutes(appleAuthProvider), { prefix: "/api/auth/apple" });
  await app.register(socialAuthRoutes(naverAuthProvider), { prefix: "/api/auth/naver" });
  await app.register(patternRoutes, { prefix: "/api/patterns" });
  await app.register(tokenUsageRoutes, { prefix: "/api/usage" });
  await app.register(skillRoutes, { prefix: "/api/skills" });
  await app.register(smsRoutes, { prefix: "/api/sms" });
  await app.register(telegramRoutes, { prefix: "/api/telegram" });
  await app.register(phoneRoutes, { prefix: "/api/phone" });

  registerCoreRoutes(app);
}
