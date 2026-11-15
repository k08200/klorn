/**
 * Bell rows the user cleared stay out of every bell view (#1767).
 *
 * "Clear all" hides a recent Notification row instead of deleting it: the row
 * gets `clearedAt` (and `isRead`) and is kept, because the "already notified?"
 * reads (urgent mail, the day's briefing, proactive nudges, meeting alerts...)
 * must still see it, or the mail rings again. So every read that shows the
 * user their bell rows (the list, the delivery view, the today-actions card,
 * engagement stats) must filter `clearedAt: null`, or `isRead: false`, which a
 * cleared row never is. Until this guard only a schema comment said so.
 *
 * The scan parses every source module and finds each read of the Notification
 * model (`prisma|tx|db|client .notification .findMany/findFirst/...`). It fails
 * when:
 *   - a read's top-level `where` neither sets `clearedAt: null` nor
 *     `isRead: false` (directly, through a local `where` object, or through a
 *     spread of a helper listed in HIDING_HELPERS) and the read is not listed
 *     in SEES_CLEARED with the exact number of such reads in its function;
 *   - a SEES_CLEARED entry no longer matches (stale entries hide new reads);
 *   - the model is reached some way the scan cannot see: the delegate aliased
 *     or passed around, a relation `include`/`select` of notifications, or raw
 *     SQL naming the table.
 *
 * A new read that must see cleared rows (a dedupe look-back, a ledger, a
 * retention sweep, the data export) goes in SEES_CLEARED with the reason.
 * Anything the user sees as their bell filters.
 */

import { readdirSync, readFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { describe, expect, it } from "vitest";

const srcDir = join(dirname(fileURLToPath(import.meta.url)), "..");

const READ_METHODS = new Set([
  "findMany",
  "findFirst",
  "findFirstOrThrow",
  "findUnique",
  "findUniqueOrThrow",
  "count",
  "aggregate",
  "groupBy",
]);
const WRITE_METHODS = new Set([
  "create",
  "createMany",
  "createManyAndReturn",
  "update",
  "updateMany",
  "updateManyAndReturn",
  "upsert",
  "delete",
  "deleteMany",
]);
/** The names a Prisma client (or transaction client) goes by in this codebase. */
const CLIENTS = new Set(["prisma", "tx", "db", "client"]);

/** Helpers whose returned where-object hides cleared rows (checked below). */
const HIDING_HELPERS: Record<string, string> = {
  unreadUrgentMailRows: "notify/open-push-mail.ts",
};

/**
 * Reads that see cleared rows on purpose: "file#function" → how many such
 * reads that function makes, and why. Counted, so a bell read added next to
 * an allowed one still fails.
 */
const SEES_CLEARED: Record<string, { reads: number; why: string }> = {
  // "Already notified?" look-backs: a cleared row must still count, or the
  // thing rings again (the #1767 bug).
  "agentcore/agent-proposal-dedup.ts#hasRecentNotification": {
    reads: 2,
    why: "dedupe: was this agent proposal already sent",
  },
  "agentcore/agent-urgent-overlap.ts#urgentRungEmailIds": {
    reads: 1,
    why: "dedupe: mail an urgent alert already covered",
  },
  "agentcore/proactive-actions.ts#checkFollowUpSuggestions": { reads: 1, why: "dedupe: daily" },
  "agentcore/proactive-actions.ts#checkUpcomingMeetings": { reads: 1, why: "dedupe: per meeting" },
  "agentcore/proactive-actions.ts#checkOverdueTasks": { reads: 1, why: "dedupe: daily" },
  "agentcore/proactive-actions.ts#checkWeeklyReview": { reads: 1, why: "dedupe: weekly" },
  "agentcore/proactive-actions.ts#checkEndOfDayReview": { reads: 1, why: "dedupe: daily" },
  "agentcore/proactive-actions.ts#checkDeadlineCountdown": { reads: 1, why: "dedupe: daily" },
  "agentcore/proactive-actions.ts#checkUnansweredEmails": { reads: 1, why: "dedupe: daily" },
  "agentcore/proactive-actions.ts#checkBackToBackMeetings": { reads: 1, why: "dedupe: daily" },
  "automation-scheduler.ts#hasBriefingBeenSentToday": {
    reads: 1,
    why: "dedupe: one briefing a day",
  },
  "automation-scheduler.ts#notifyCandidateEmails": {
    reads: 1,
    why: "dedupe: candidate mail already announced",
  },
  "automation-scheduler.ts#maybeNudgeFreeDailyLimit": { reads: 1, why: "dedupe: one nudge a day" },
  "automation-scheduler.ts#sweepUrgentEmails": {
    reads: 1,
    why: "dedupe: urgent mail already rang",
  },
  "background.ts#checkUpcomingMeetings": { reads: 1, why: "dedupe: meeting alert already sent" },
  "judge/firewall-push.ts#firewallPushGatesPass": {
    reads: 1,
    why: "dedupe: urgent mail already rang",
  },
  "slack/notify.ts#slackRowsToday": { reads: 2, why: "daily Slack alert cap counts sent rows" },
  // Locks, ledgers and budgets kept in Notification rows (hidden at any age).
  "agentcore/auto-mode-candidates.ts#findAutoModeCandidates": {
    reads: 1,
    why: "unattended-reply ledger",
  },
  "agentcore/unattended-reply-guards.ts#unattendedRepliesToday": {
    reads: 1,
    why: "unattended-reply daily cap",
  },
  "automation-scheduler.ts#hasAutoReplyClaim": { reads: 2, why: "unattended-reply lock" },
  "judge/v3/push-budget-gate.ts#usedSlots": { reads: 1, why: "interrupt budget slots" },
  "judge/v3/push-budget-gate.ts#interruptBudgetStatus": { reads: 1, why: "interrupt budget" },
  "mail/sent-origin-classifier.ts#loadClaimEvidence": { reads: 1, why: "reply-claim ledger" },
  "notify/quiet-hours-summary.ts#windowClaimed": { reads: 1, why: "summary at-most-once claim" },
  // Facts about delivery, not bell views: a cleared row was still sent.
  "notify/channel-delivery-log.ts#ownsSubject": {
    reads: 1,
    why: "owner check for a desktop receipt of a delivered row",
  },
  "pim/briefing-status.ts#getBriefingStatus": {
    reads: 1,
    why: "whether today's briefing went out",
  },
  "routes/diagnostics.ts#diagnosticsRoutes": { reads: 1, why: "briefing delivery diagnostics" },
  "routes/ops.ts#collectReadinessData": { reads: 1, why: "reminder delivery readiness" },
  "scripts/diagnose-push.ts#main": { reads: 2, why: "operator push diagnosis script" },
  // The queue join resolves rows its FOLLOWUP items point at; clearing drops
  // those items, so a cleared row has no item left to resolve.
  "pim/inbox-summary.ts#buildInboxSummary": { reads: 1, why: "queue join by item source id" },
  // Every stored row is the user's data, cleared or not.
  "routes/core.ts#registerCoreRoutes": { reads: 1, why: "the user's data export" },
  // The sweep that deletes cleared rows after 30 days reads only cleared rows.
  "log-retention.ts#findExpiredIds": { reads: 1, why: "retention sweep of cleared rows" },
};

interface Source {
  readonly path: string;
  readonly text: string;
}

interface NotificationRead {
  readonly key: string;
  readonly where: string;
  readonly hides: boolean;
}

interface Scan {
  readonly reads: NotificationRead[];
  /** Ways into the model the read scan cannot follow. */
  readonly unreadable: string[];
}

function sourceFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) return entry.name === "__tests__" ? [] : sourceFiles(full);
    return entry.name.endsWith(".ts") && !entry.name.endsWith(".test.ts") ? [full] : [];
  });
}

function parse(path: string, text: string): ts.SourceFile {
  return ts.createSourceFile(path, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
}

function walk(node: ts.Node, visit: (n: ts.Node) => void): void {
  visit(node);
  ts.forEachChild(node, (child) => walk(child, visit));
}

function propName(name: ts.PropertyName | ts.Identifier): string {
  return ts.isIdentifier(name) || ts.isStringLiteral(name) ? name.text : name.getText();
}

/** `x as T`, `(x)`, `x!`, `x satisfies T` → x. */
function unwrap(expr: ts.Expression): ts.Expression {
  let current = expr;
  while (
    ts.isParenthesizedExpression(current) ||
    ts.isAsExpression(current) ||
    ts.isNonNullExpression(current) ||
    ts.isSatisfiesExpression(current) ||
    ts.isTypeAssertionExpression(current)
  ) {
    current = current.expression;
  }
  return current;
}

/** The name of the nearest named function around `node` ("<module>" at top level). */
function enclosingName(node: ts.Node): string {
  for (let n = node.parent; n; n = n.parent) {
    if ((ts.isFunctionDeclaration(n) || ts.isMethodDeclaration(n)) && n.name) {
      return propName(n.name);
    }
    if (ts.isArrowFunction(n) || ts.isFunctionExpression(n)) {
      const holder = n.parent;
      if (ts.isVariableDeclaration(holder) && ts.isIdentifier(holder.name)) return holder.name.text;
      if (ts.isPropertyAssignment(holder)) return propName(holder.name);
    }
  }
  return "<module>";
}

function enclosingFunction(node: ts.Node): ts.Node {
  for (let n = node.parent; n; n = n.parent) {
    if (ts.isFunctionLike(n)) return n;
  }
  return node.getSourceFile();
}

/** A local object a read names (`{ where }`, `where: filter`), if declared above it. */
function localObject(name: string, at: ts.Node): ts.ObjectLiteralExpression | null {
  let found: ts.ObjectLiteralExpression | null = null;
  walk(enclosingFunction(at), (n) => {
    if (
      ts.isVariableDeclaration(n) &&
      ts.isIdentifier(n.name) &&
      n.name.text === name &&
      n.getStart() < at.getStart() &&
      n.initializer
    ) {
      const init = unwrap(n.initializer);
      found = ts.isObjectLiteralExpression(init) ? init : null;
    }
  });
  return found;
}

function objectOf(expr: ts.Expression | undefined, at: ts.Node): ts.ObjectLiteralExpression | null {
  if (!expr) return null;
  const value = unwrap(expr);
  if (ts.isObjectLiteralExpression(value)) return value;
  return ts.isIdentifier(value) ? localObject(value.text, at) : null;
}

function propertyValue(obj: ts.ObjectLiteralExpression, name: string): ts.Expression | undefined {
  for (const prop of obj.properties) {
    if (ts.isPropertyAssignment(prop) && propName(prop.name) === name) return prop.initializer;
    if (ts.isShorthandPropertyAssignment(prop) && prop.name.text === name) return prop.name;
  }
  return undefined;
}

function calleeName(call: ts.CallExpression): string | null {
  const callee = unwrap(call.expression);
  if (ts.isIdentifier(callee)) return callee.text;
  return ts.isPropertyAccessExpression(callee) ? callee.name.text : null;
}

/** Whether a where-object, at its top level, leaves cleared rows out. */
function whereHidesCleared(where: ts.ObjectLiteralExpression): boolean {
  return where.properties.some((prop) => {
    if (ts.isSpreadAssignment(prop)) {
      const spread = unwrap(prop.expression);
      return ts.isCallExpression(spread) && (calleeName(spread) ?? "") in HIDING_HELPERS;
    }
    if (!ts.isPropertyAssignment(prop)) return false;
    const name = propName(prop.name);
    const value = unwrap(prop.initializer);
    if (name === "clearedAt") return value.kind === ts.SyntaxKind.NullKeyword;
    if (name === "isRead") return value.kind === ts.SyntaxKind.FalseKeyword;
    return false;
  });
}

/** `node` with every cast or parenthesis wrapped around it. */
function outermostCast(node: ts.Node): ts.Node {
  let current = node;
  while (
    ts.isParenthesizedExpression(current.parent) ||
    ts.isAsExpression(current.parent) ||
    ts.isNonNullExpression(current.parent) ||
    ts.isSatisfiesExpression(current.parent) ||
    ts.isTypeAssertionExpression(current.parent)
  ) {
    current = current.parent;
  }
  return current;
}

/** The call a `<client>.notification.<method>` access is the callee of, through casts. */
function callOf(access: ts.Node): ts.CallExpression | null {
  const callee = outermostCast(access);
  const parent = callee.parent;
  return ts.isCallExpression(parent) && parent.expression === callee ? parent : null;
}

function isNotificationDelegate(node: ts.Node): node is ts.PropertyAccessExpression {
  return (
    ts.isPropertyAccessExpression(node) &&
    node.name.text === "notification" &&
    ts.isIdentifier(node.expression) &&
    CLIENTS.has(node.expression.text)
  );
}

function isRelationRead(node: ts.Node): boolean {
  if (!ts.isPropertyAssignment(node) && !ts.isShorthandPropertyAssignment(node)) return false;
  if (!["notification", "notifications"].includes(propName(node.name))) return false;
  const holder = node.parent.parent;
  return ts.isPropertyAssignment(holder) && ["include", "select"].includes(propName(holder.name));
}

function isRawNotificationSql(node: ts.Node): boolean {
  const raw = (expr: ts.Expression) => /\$queryRaw(Unsafe)?$/.test(expr.getText());
  if (ts.isTaggedTemplateExpression(node) && raw(node.tag)) {
    return node.template.getText().includes('"Notification"');
  }
  if (ts.isCallExpression(node) && raw(node.expression)) {
    return node.arguments.some((arg) => arg.getText().includes('"Notification"'));
  }
  return false;
}

/** What a `<client>.notification` delegate is used for: a read call, a write, or else its name. */
function delegateUse(delegate: ts.Node): ts.CallExpression | "write" | string {
  const access = outermostCast(delegate).parent;
  const method = ts.isPropertyAccessExpression(access) ? access.name.text : null;
  if (method === null) return "delegate";
  if (WRITE_METHODS.has(method)) return "write";
  const call = READ_METHODS.has(method) ? callOf(access) : null;
  return call ?? method;
}

function readHidesCleared(call: ts.CallExpression): boolean {
  const filter = objectOf(call.arguments[0], call);
  const where = filter ? objectOf(propertyValue(filter, "where"), call) : null;
  return where !== null && whereHidesCleared(where);
}

function scanSource({ path, text }: Source): Scan {
  const file = parse(path, text);
  const reads: NotificationRead[] = [];
  const unreadable: string[] = [];
  const where = (node: ts.Node) =>
    `${path}:${file.getLineAndCharacterOfPosition(node.getStart()).line + 1}`;
  walk(file, (node) => {
    if (isRelationRead(node)) unreadable.push(`${where(node)} relation read`);
    if (isRawNotificationSql(node)) unreadable.push(`${where(node)} raw SQL`);
    if (!isNotificationDelegate(node)) return;
    const use = delegateUse(node);
    if (use === "write") return;
    if (typeof use === "string") {
      unreadable.push(`${where(node)} ${use} used other than as a call`);
      return;
    }
    reads.push({
      key: `${path}#${enclosingName(use)}`,
      where: where(use),
      hides: readHidesCleared(use),
    });
  });
  return { reads, unreadable };
}

/** The where-object a helper returns hides cleared rows on every return path. */
function helperHidesCleared({ path, text }: Source, name: string): boolean {
  const file = parse(path, text);
  const returns: ts.ObjectLiteralExpression[] = [];
  let declared = false;
  walk(file, (node) => {
    if (!ts.isFunctionDeclaration(node) || node.name?.text !== name || !node.body) return;
    declared = true;
    walk(node.body, (inner) => {
      if (ts.isReturnStatement(inner) && inner.expression) {
        const value = unwrap(inner.expression);
        if (ts.isObjectLiteralExpression(value)) returns.push(value);
        else returns.push(ts.factory.createObjectLiteralExpression([]));
      }
    });
  });
  return declared && returns.length > 0 && returns.every(whereHidesCleared);
}

const sources: Source[] = sourceFiles(srcDir).map((full) => ({
  path: relative(srcDir, full).split("\\").join("/"),
  text: readFileSync(full, "utf8"),
}));
const scans = sources.filter((s) => s.text.includes("notification")).map(scanSource);
const allReads = scans.flatMap((scan) => scan.reads);

function countsOf(reads: readonly NotificationRead[]): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const read of reads) counts[read.key] = (counts[read.key] ?? 0) + 1;
  return counts;
}

function fixture(text: string): Scan {
  return scanSource({ path: "fixture.ts", text });
}

describe("the scan catches bad readers (self-test)", () => {
  it("flags a read with no cleared filter, and one whose filter sits in an OR branch", () => {
    const scan = fixture(
      [
        "export async function bell(userId: string) {",
        "  await prisma.notification.findMany({ where: { userId } });",
        "  await prisma.notification.count({ where: { OR: [{ clearedAt: null }, { userId }] } });",
        "  await tx.notification.findFirst({ where: { userId, clearedAt: { not: null } } });",
        "}",
      ].join("\n"),
    );
    expect(scan.reads.map((read) => read.hides)).toEqual([false, false, false]);
    expect(countsOf(scan.reads)).toEqual({ "fixture.ts#bell": 3 });
  });

  it("sees through a cast delegate: its read is checked, its write is not a read", () => {
    const scan = fixture(
      [
        "export async function bell(userId: string) {",
        "  await (prisma.notification as unknown as Reader).findMany({ where: { userId } });",
        "  await (prisma.notification as unknown as Writer).create({ data: { userId } });",
        "}",
      ].join("\n"),
    );
    expect(scan.reads.map((read) => read.hides)).toEqual([false]);
    expect(scan.unreadable).toEqual([]);
  });

  it("flags a read whose arguments it cannot read", () => {
    const scan = fixture(
      "export async function bell(query: object) { return prisma.notification.findFirst(query); }",
    );
    expect(scan.reads).toEqual([{ key: "fixture.ts#bell", where: "fixture.ts:1", hides: false }]);
  });

  it("flags the delegate aliased, a relation include and raw SQL on the table", () => {
    const scan = fixture(
      [
        "const delegate = prisma.notification;",
        "export async function viaRelation(id: string) {",
        "  return prisma.user.findUnique({ where: { id }, include: { notifications: true } });",
        "}",
        'export const viaSql = () => prisma.$queryRaw`SELECT * FROM "Notification"`;',
      ].join("\n"),
    );
    expect(scan.unreadable).toEqual([
      "fixture.ts:1 delegate used other than as a call",
      "fixture.ts:3 relation read",
      "fixture.ts:5 raw SQL",
    ]);
  });

  it("accepts clearedAt: null, isRead: false, a local where object, a hiding helper and a cast", () => {
    const scan = fixture(
      [
        "export async function bell(userId: string) {",
        "  await prisma.notification.findMany({ where: { userId, clearedAt: null } });",
        "  await prisma.notification.count({ where: { userId, isRead: false } });",
        "  const where = { userId, clearedAt: null };",
        "  await prisma.notification.findMany({ where });",
        "  await prisma.notification.findMany({ where: { ...unreadUrgentMailRows(userId) } });",
        "  await (prisma.notification.findMany as (a: unknown) => Promise<unknown>)({ where });",
        "  await prisma.notification.updateMany({ where: { userId }, data: { isRead: true } });",
        "}",
      ].join("\n"),
    );
    expect(scan.reads.map((read) => read.hides)).toEqual([true, true, true, true, true]);
    expect(scan.unreadable).toEqual([]);
  });

  it("checks a hiding helper's own return value", () => {
    const good = {
      path: "h.ts",
      text: "export function h(u: string) { return { u, isRead: false }; }",
    };
    const bad = { path: "h.ts", text: "export function h(u: string) { return { u }; }" };
    expect([helperHidesCleared(good, "h"), helperHidesCleared(bad, "h")]).toEqual([true, false]);
  });
});

describe("bell readers leave cleared rows out", () => {
  it("finds the reads (so this guard cannot pass by scanning nothing)", () => {
    expect(allReads.length).toBeGreaterThan(40);
  });

  it("the bell list, delivery view, today-actions card and engagement stats filter", () => {
    const hiding = new Set(allReads.filter((read) => read.hides).map((read) => read.key));
    for (const key of [
      "background.ts#getNotifications",
      "notify/notification-center.ts#notificationDelivery",
      "routes/automations.ts#automationRoutes",
      "routes/admin.ts#adminRoutes",
      "routes/notifications.ts#notificationRoutes",
    ]) {
      expect(hiding).toContain(key);
    }
  });

  it("every read that sees cleared rows is listed, with its exact count", () => {
    const seeing = countsOf(allReads.filter((read) => !read.hides));
    const listed = Object.fromEntries(
      Object.entries(SEES_CLEARED).map(([key, { reads }]) => [key, reads]),
    );
    expect(seeing).toEqual(listed);
  });

  it("reaches the model only through reads and writes the scan can see", () => {
    expect(scans.flatMap((scan) => scan.unreadable)).toEqual([]);
  });

  it("each hiding helper really hides cleared rows", () => {
    for (const [name, path] of Object.entries(HIDING_HELPERS)) {
      const source = sources.find((s) => s.path === path);
      expect(source, path).toBeDefined();
      expect(helperHidesCleared(source as Source, name), name).toBe(true);
    }
  });
});
