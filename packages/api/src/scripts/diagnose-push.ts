/**
 * Diagnostic script — find out why push/briefing isn't reaching the user.
 * Usage: cd packages/api && pnpm tsx src/scripts/diagnose-push.ts <email>
 */

import { prisma } from "../db.js";

const email = process.argv[2];
if (!email) {
  console.error("Usage: pnpm tsx src/scripts/diagnose-push.ts <email>");
  process.exit(1);
}

async function main() {
  console.log(`\n=== Klorn Push/Briefing Diagnosis for ${email} ===\n`);

  // 1. User account state
  const user = await prisma.user.findUnique({
    where: { email },
    select: { id: true, email: true, plan: true, role: true, createdAt: true },
  });
  if (!user) {
    console.log(`X User ${email} not found in DB.`);
    return;
  }
  console.log("USER:", user);

  const userId = user.id;

  // 2. Push subscriptions
  const subs = await prisma.pushSubscription.findMany({
    where: { userId },
    select: { id: true, endpoint: true, createdAt: true },
  });
  console.log(`\nPUSH SUBSCRIPTIONS: ${subs.length}`);
  for (const s of subs) {
    const host = (() => {
      try {
        return new URL(s.endpoint).hostname;
      } catch {
        return "?";
      }
    })();
    console.log(`  - ${host} (created ${s.createdAt.toISOString()})`);
  }

  // 3. Automation config
  const cfg = await prisma.automationConfig.findUnique({ where: { userId } });
  console.log(`\nAUTOMATION CONFIG:`, cfg);

  // 4. Recent notifications
  const notifs = await prisma.notification.findMany({
    where: { userId },
    orderBy: { createdAt: "desc" },
    take: 20,
    select: { type: true, title: true, createdAt: true, isRead: true },
  });
  console.log(`\nRECENT NOTIFICATIONS (${notifs.length}):`);
  for (const n of notifs) {
    console.log(
      `  ${n.createdAt.toISOString()} [${n.type}] ${n.title} ${n.isRead ? "(read)" : "(unread)"}`,
    );
  }

  // 5. Plan feature check
  const { planHasFeature } = await import("../stripe.js");
  console.log(`\nFEATURE GATES (plan=${user.plan}, role=${user.role}):`);
  for (const feat of [
    "daily_briefing",
    "email_auto_classify",
    "email_auto_reply",
    "autonomous_agent",
  ] as const) {
    console.log(`  ${feat}: ${planHasFeature(user.plan, feat, user.role) ? "ALLOWED" : "BLOCKED"}`);
  }

  // 6. VAPID keys present in this process?
  console.log(`\nVAPID KEYS:`);
  console.log(`  PUBLIC: ${process.env.VAPID_PUBLIC_KEY ? "SET" : "MISSING"}`);
  console.log(`  PRIVATE: ${process.env.VAPID_PRIVATE_KEY ? "SET" : "MISSING"}`);

  // 7. Recent urgent emails (would trigger push)
  const urgent = await prisma.emailMessage.count({
    where: { userId, priority: "URGENT", isRead: false },
  });
  const totalEmails = await prisma.emailMessage.count({ where: { userId } });
  console.log(`\nEMAIL STATE: ${totalEmails} total in DB, ${urgent} URGENT unread`);

  // 8. Briefings already sent today
  const todayStart = new Date();
  todayStart.setHours(0, 0, 0, 0);
  const briefingsToday = await prisma.notification.count({
    where: { userId, type: "briefing", createdAt: { gte: todayStart } },
  });
  console.log(`\nBRIEFINGS TODAY: ${briefingsToday}`);

  // 9. Push delivery receipts (last 24h)
  const since = new Date(Date.now() - 24 * 60 * 60 * 1000);
  const deliveryLogs = await prisma.pushDeliveryLog.findMany({
    where: { userId, createdAt: { gte: since } },
    orderBy: { createdAt: "desc" },
    take: 50,
    select: {
      category: true,
      title: true,
      status: true,
      skipReason: true,
      endpointHost: true,
      errorStatusCode: true,
      acceptedAt: true,
      receivedAt: true,
      clickedAt: true,
      createdAt: true,
    },
  });
  const accepted = deliveryLogs.filter((log) => log.status === "ACCEPTED").length;
  const received = deliveryLogs.filter((log) => log.receivedAt).length;
  const failed = deliveryLogs.filter((log) => log.status === "FAILED").length;
  const skipped = deliveryLogs.filter((log) => log.status === "SKIPPED").length;
  const receiptRate = accepted > 0 ? `${Math.round((received / accepted) * 100)}%` : "n/a";
  console.log(
    `\nPUSH DELIVERY 24H: ${accepted} accepted, ${received} received (${receiptRate}), ${failed} failed, ${skipped} skipped`,
  );
  for (const log of deliveryLogs.slice(0, 10)) {
    const receipt = log.receivedAt ? "received" : log.acceptedAt ? "accepted" : log.status;
    const detail = log.skipReason || log.errorStatusCode || log.endpointHost || "";
    console.log(`  ${log.createdAt.toISOString()} [${log.category}] ${receipt} ${detail}`);
  }

  await prisma.$disconnect();
}

main().catch((err) => {
  console.error("Diagnosis failed:", err);
  process.exit(1);
});
