/**
 * Work Graph v0.
 *
 * This is the first connective layer above Attention Queue and Commitment
 * Ledger. It groups existing signals into active work contexts so Eve can talk
 * about "the PartnerCo thread" or "the launch chat" instead of isolated rows.
 *
 * v0 is intentionally read-only and inferred from current tables. A durable
 * graph schema can come after the grouping rules prove useful in dogfooding.
 */

import { prisma } from "./db.js";

/**
 * How far back the work graph reaches when scanning mail. Active contexts
 * means "things you might still need to act on" — surfacing a month-old
 * Vercel notification as today's "High Mail" makes the dashboard noisy and
 * trains the user to ignore it.
 */
const EMAIL_RECENCY_WINDOW_MS = 14 * 24 * 60 * 60 * 1000;

export type WorkGraphContextKind = "email_thread" | "chat_conversation" | "loose_commitment";
export type WorkGraphRisk = "high" | "medium" | "low";

export interface WorkGraphPerson {
  name: string | null;
  email: string | null;
}

export interface WorkGraphSignals {
  emails: number;
  unreadEmails: number;
  urgentEmails: number;
  pendingActions: number;
  commitments: number;
  overdueCommitments: number;
}

export interface WorkGraphContext {
  id: string;
  kind: WorkGraphContextKind;
  title: string;
  subtitle: string | null;
  href: string | null;
  people: WorkGraphPerson[];
  lastActivityAt: string;
  risk: WorkGraphRisk;
  reasons: string[];
  signals: WorkGraphSignals;
}

export interface WorkGraphSummary {
  generatedAt: string;
  contexts: WorkGraphContext[];
}

type EmailRow = {
  id: string;
  threadId: string | null;
  from: string;
  to: string;
  subject: string;
  isRead: boolean;
  priority: string;
  receivedAt: Date;
};

type ConversationRow = {
  id: string;
  title: string | null;
  updatedAt: Date;
  createdAt: Date;
};

type PendingActionRow = {
  id: string;
  conversationId: string;
  status: string;
  toolName: string;
  createdAt: Date;
};

type CommitmentRow = {
  id: string;
  title: string;
  description: string | null;
  status: string;
  owner: string;
  counterpartyName: string | null;
  dueAt: Date | null;
  dueText: string | null;
  sourceType: string;
  sourceId: string | null;
  threadId: string | null;
  createdAt: Date;
  updatedAt: Date;
};

interface MutableContext {
  id: string;
  kind: WorkGraphContextKind;
  title: string;
  subtitle: string | null;
  href: string | null;
  peopleByKey: Map<string, WorkGraphPerson>;
  lastActivityAt: Date;
  reasons: string[];
  signals: WorkGraphSignals;
}

const DEFAULT_LIMIT = 6;
const MAX_LIMIT = 20;

function normalizeLimit(limit: number | undefined): number {
  if (!Number.isFinite(limit) || !limit || limit < 1) return DEFAULT_LIMIT;
  return Math.min(Math.floor(limit), MAX_LIMIT);
}

function emptySignals(): WorkGraphSignals {
  return {
    emails: 0,
    unreadEmails: 0,
    urgentEmails: 0,
    pendingActions: 0,
    commitments: 0,
    overdueCommitments: 0,
  };
}

function normalizeSubject(subject: string): string {
  return subject.replace(/^(\s*(re|fw|fwd)\s*:\s*)+/i, "").trim() || "(No subject)";
}

function parsePerson(raw: string): WorkGraphPerson | null {
  const trimmed = raw.trim();
  if (!trimmed) return null;
  const angle = trimmed.match(/^(.*?)\s*<([^>]+)>$/);
  if (angle) {
    const name = angle[1]?.replace(/^"|"$/g, "").trim() || null;
    const email = angle[2]?.trim() || null;
    return { name, email };
  }
  if (/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(trimmed)) return { name: null, email: trimmed };
  return { name: trimmed, email: null };
}

function personKey(person: WorkGraphPerson): string {
  return (person.email || person.name || "").toLowerCase();
}

function addPerson(ctx: MutableContext, person: WorkGraphPerson | null): void {
  if (!person) return;
  const key = personKey(person);
  if (!key || ctx.peopleByKey.has(key)) return;
  ctx.peopleByKey.set(key, person);
}

function bumpActivity(ctx: MutableContext, at: Date): void {
  if (at.getTime() > ctx.lastActivityAt.getTime()) ctx.lastActivityAt = at;
}

function pushReason(ctx: MutableContext, reason: string): void {
  if (!ctx.reasons.includes(reason)) ctx.reasons.push(reason);
}

function createContext(input: {
  id: string;
  kind: WorkGraphContextKind;
  title: string;
  subtitle?: string | null;
  href?: string | null;
  lastActivityAt: Date;
}): MutableContext {
  return {
    id: input.id,
    kind: input.kind,
    title: input.title,
    subtitle: input.subtitle ?? null,
    href: input.href ?? null,
    peopleByKey: new Map(),
    lastActivityAt: input.lastActivityAt,
    reasons: [],
    signals: emptySignals(),
  };
}

function getOrCreate(
  contexts: Map<string, MutableContext>,
  input: Parameters<typeof createContext>[0],
): MutableContext {
  const existing = contexts.get(input.id);
  if (existing) {
    bumpActivity(existing, input.lastActivityAt);
    if (!existing.href && input.href) existing.href = input.href;
    if (existing.title === "Email thread" && input.title !== "Email thread") {
      existing.title = input.title;
    }
    return existing;
  }
  const created = createContext(input);
  contexts.set(input.id, created);
  return created;
}

function addEmail(contexts: Map<string, MutableContext>, email: EmailRow): void {
  const key = `email:${email.threadId || email.id}`;
  const ctx = getOrCreate(contexts, {
    id: key,
    kind: "email_thread",
    title: normalizeSubject(email.subject),
    subtitle: email.from,
    href: `/email/${email.id}`,
    lastActivityAt: email.receivedAt,
  });
  ctx.signals.emails++;
  if (!email.isRead) ctx.signals.unreadEmails++;
  if (email.priority === "URGENT") ctx.signals.urgentEmails++;
  if (!email.isRead) pushReason(ctx, "Unread mail");
  if (email.priority === "URGENT") pushReason(ctx, "Urgent mail");
  addPerson(ctx, parsePerson(email.from));
}

function addConversation(
  contexts: Map<string, MutableContext>,
  conversation: ConversationRow,
): void {
  getOrCreate(contexts, {
    id: `chat:${conversation.id}`,
    kind: "chat_conversation",
    title: conversation.title?.trim() || "Untitled thread",
    subtitle: "Chat",
    href: `/chat/${conversation.id}`,
    lastActivityAt: conversation.updatedAt || conversation.createdAt,
  });
}

function addPendingAction(contexts: Map<string, MutableContext>, action: PendingActionRow): void {
  if (action.status !== "PENDING") return;
  const ctx = getOrCreate(contexts, {
    id: `chat:${action.conversationId}`,
    kind: "chat_conversation",
    title: "Untitled thread",
    subtitle: "Chat",
    href: `/chat/${action.conversationId}`,
    lastActivityAt: action.createdAt,
  });
  ctx.signals.pendingActions++;
  pushReason(ctx, `Awaiting approval: ${action.toolName.replace(/_/g, " ")}`);
}

function commitmentContextInput(commitment: CommitmentRow): Parameters<typeof createContext>[0] {
  if (commitment.sourceType === "CHAT" && commitment.threadId) {
    return {
      id: `chat:${commitment.threadId}`,
      kind: "chat_conversation",
      title: "Untitled thread",
      subtitle: "Chat",
      href: `/chat/${commitment.threadId}`,
      lastActivityAt: commitment.updatedAt || commitment.createdAt,
    };
  }
  if (commitment.sourceType === "EMAIL" && commitment.threadId) {
    return {
      id: `email:${commitment.threadId}`,
      kind: "email_thread",
      title: "Email thread",
      subtitle: commitment.description,
      href: commitment.sourceId ? `/email/${commitment.sourceId}` : null,
      lastActivityAt: commitment.updatedAt || commitment.createdAt,
    };
  }
  return {
    id: `commitment:${commitment.id}`,
    kind: "loose_commitment",
    title: commitment.title,
    subtitle: commitment.description,
    href: null,
    lastActivityAt: commitment.updatedAt || commitment.createdAt,
  };
}

function addCommitment(
  contexts: Map<string, MutableContext>,
  commitment: CommitmentRow,
  now: number,
): void {
  if (commitment.status !== "OPEN") return;
  const ctx = getOrCreate(contexts, commitmentContextInput(commitment));
  ctx.signals.commitments++;
  pushReason(ctx, commitment.dueText ? `Commitment: ${commitment.dueText}` : "Open commitment");
  if (commitment.dueAt && commitment.dueAt.getTime() < now) {
    ctx.signals.overdueCommitments++;
    pushReason(ctx, "Overdue commitment");
  }
  if (commitment.counterpartyName) {
    addPerson(ctx, { name: commitment.counterpartyName, email: null });
  }
}

function riskFor(signals: WorkGraphSignals): WorkGraphRisk {
  if (signals.pendingActions > 0 || signals.overdueCommitments > 0 || signals.urgentEmails > 0) {
    return "high";
  }
  if (signals.commitments > 0 || signals.unreadEmails > 0) return "medium";
  return "low";
}

function riskWeight(risk: WorkGraphRisk): number {
  if (risk === "high") return 3;
  if (risk === "medium") return 2;
  return 1;
}

function finalize(ctx: MutableContext): WorkGraphContext {
  const risk = riskFor(ctx.signals);
  return {
    id: ctx.id,
    kind: ctx.kind,
    title: ctx.title,
    subtitle: ctx.subtitle,
    href: ctx.href,
    people: Array.from(ctx.peopleByKey.values()).slice(0, 5),
    lastActivityAt: ctx.lastActivityAt.toISOString(),
    risk,
    reasons: ctx.reasons.slice(0, 4),
    signals: ctx.signals,
  };
}

export async function buildWorkGraphSummary(
  userId: string,
  opts?: { limit?: number; now?: number },
): Promise<WorkGraphSummary> {
  const now = opts?.now ?? Date.now();
  const limit = normalizeLimit(opts?.limit);

  const recencyFloor = new Date(now - EMAIL_RECENCY_WINDOW_MS);
  const [emails, conversations, pendingActions, commitments] = await Promise.all([
    prisma.emailMessage.findMany({
      where: { userId, receivedAt: { gte: recencyFloor } },
      orderBy: { receivedAt: "desc" },
      take: 100,
    }),
    prisma.conversation.findMany({
      where: { userId },
      orderBy: { updatedAt: "desc" },
      take: 50,
    }),
    (prisma.pendingAction.findMany as (args: unknown) => Promise<PendingActionRow[]>)({
      where: { userId, status: "PENDING" },
      orderBy: { createdAt: "desc" },
      take: 50,
    }),
    prisma.commitment.findMany({
      where: { userId, status: "OPEN" },
      orderBy: [{ dueAt: "asc" }, { updatedAt: "desc" }],
      take: 100,
    }),
  ]);

  const contexts = new Map<string, MutableContext>();
  for (const email of emails as EmailRow[]) addEmail(contexts, email);
  for (const conversation of conversations as ConversationRow[]) {
    addConversation(contexts, conversation);
  }
  for (const action of pendingActions) addPendingAction(contexts, action);
  for (const commitment of commitments as CommitmentRow[]) {
    addCommitment(contexts, commitment, now);
  }

  const sorted = Array.from(contexts.values())
    .map(finalize)
    .filter(
      (ctx) =>
        ctx.signals.pendingActions +
          ctx.signals.commitments +
          ctx.signals.unreadEmails +
          ctx.signals.urgentEmails >
        0,
    )
    .sort((a, b) => {
      const riskDelta = riskWeight(b.risk) - riskWeight(a.risk);
      if (riskDelta !== 0) return riskDelta;
      return new Date(b.lastActivityAt).getTime() - new Date(a.lastActivityAt).getTime();
    })
    .slice(0, limit);

  await persistWorkContextSnapshots(userId, sorted, now);

  return { generatedAt: new Date(now).toISOString(), contexts: sorted };
}

async function persistWorkContextSnapshots(
  userId: string,
  contexts: WorkGraphContext[],
  now: number,
): Promise<void> {
  const model = (
    prisma as unknown as {
      workContextSnapshot?: { upsert: (args: unknown) => Promise<unknown> };
    }
  ).workContextSnapshot;
  if (!model || contexts.length === 0) return;

  await Promise.all(
    contexts.map((context) =>
      model
        .upsert({
          where: { userId_contextKey: { userId, contextKey: context.id } },
          create: {
            userId,
            contextKey: context.id,
            kind: context.kind,
            title: context.title,
            subtitle: context.subtitle,
            href: context.href,
            risk: context.risk,
            reasons: context.reasons,
            signals: context.signals,
            people: context.people,
            lastActivityAt: new Date(context.lastActivityAt),
            generatedAt: new Date(now),
          },
          update: {
            kind: context.kind,
            title: context.title,
            subtitle: context.subtitle,
            href: context.href,
            risk: context.risk,
            reasons: context.reasons,
            signals: context.signals,
            people: context.people,
            lastActivityAt: new Date(context.lastActivityAt),
            generatedAt: new Date(now),
          },
        })
        .catch(() => {}),
    ),
  );
}
