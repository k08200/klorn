import { prisma } from "../db.js";

export type MeetingPrepReadiness = "ready" | "watch" | "needs_review";

export interface MeetingPrepEvent {
  id: string;
  title: string;
  description: string | null;
  startTime: string;
  endTime: string;
  location: string | null;
  meetingLink: string | null;
}

export interface MeetingPrepEmail {
  id: string;
  from: string;
  subject: string;
  snippet: string | null;
  receivedAt: string;
  isRead: boolean;
}

export interface MeetingPrepTask {
  id: string;
  title: string;
  status: string;
  priority: string;
  dueDate: string | null;
}

export interface MeetingPrepCommitment {
  id: string;
  title: string;
  owner: string;
  dueAt: string | null;
  dueText: string | null;
  confidence: number;
}

export interface MeetingPrepPack {
  generatedAt: string;
  event: MeetingPrepEvent;
  readiness: MeetingPrepReadiness;
  checklist: string[];
  relatedEmails: MeetingPrepEmail[];
  openTasks: MeetingPrepTask[];
  openCommitments: MeetingPrepCommitment[];
}

type EventRow = {
  id: string;
  userId: string;
  title: string;
  description: string | null;
  startTime: Date;
  endTime: Date;
  location: string | null;
  meetingLink: string | null;
};

type EmailRow = {
  id: string;
  from: string;
  subject: string;
  snippet: string | null;
  body: string | null;
  summary: string | null;
  receivedAt: Date;
  isRead: boolean;
};

type TaskRow = {
  id: string;
  title: string;
  description: string | null;
  status: string;
  priority: string;
  dueDate: Date | null;
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
  confidence: number;
};

const STOPWORDS = new Set([
  "meeting",
  "sync",
  "call",
  "weekly",
  "daily",
  "standup",
  "회의",
  "미팅",
  "정기",
  "주간",
  "일간",
  "논의",
]);

function toEvent(event: EventRow): MeetingPrepEvent {
  return {
    id: event.id,
    title: event.title,
    description: event.description,
    startTime: event.startTime.toISOString(),
    endTime: event.endTime.toISOString(),
    location: event.location,
    meetingLink: event.meetingLink,
  };
}

function extractKeywords(event: EventRow): string[] {
  const source = [event.title, event.description, event.location].filter(Boolean).join(" ");
  const words = source.match(/[A-Za-z0-9가-힣]{2,}/g) || [];
  const seen = new Set<string>();
  const keywords: string[] = [];
  for (const word of words) {
    const normalized = word.toLowerCase();
    if (STOPWORDS.has(normalized) || seen.has(normalized)) continue;
    seen.add(normalized);
    keywords.push(normalized);
    if (keywords.length >= 6) break;
  }
  return keywords;
}

function scoreText(text: string, keywords: string[]): number {
  const lower = text.toLowerCase();
  return keywords.reduce((score, keyword) => score + (lower.includes(keyword) ? 1 : 0), 0);
}

function rankByKeywords<T>(rows: T[], keywords: string[], textFor: (row: T) => string): T[] {
  if (keywords.length === 0) return [];
  return rows
    .map((row) => ({ row, score: scoreText(textFor(row), keywords) }))
    .filter((entry) => entry.score > 0)
    .sort((a, b) => b.score - a.score)
    .map((entry) => entry.row);
}

function isDueBeforeMeeting(task: TaskRow, event: EventRow): boolean {
  return !!task.dueDate && task.dueDate.getTime() <= event.startTime.getTime();
}

function isCommitmentOverdue(commitment: CommitmentRow, now: number): boolean {
  return !!commitment.dueAt && commitment.dueAt.getTime() < now;
}

function buildChecklist(input: {
  event: EventRow;
  relatedEmails: EmailRow[];
  openTasks: TaskRow[];
  openCommitments: CommitmentRow[];
  now: number;
}): { readiness: MeetingPrepReadiness; checklist: string[] } {
  const checklist: string[] = [];
  let risk = 0;

  if (!input.event.description?.trim()) {
    checklist.push("Confirm the agenda or meeting purpose.");
    risk++;
  }
  if (!input.event.meetingLink && !input.event.location) {
    checklist.push("Add a meeting link or location.");
    risk++;
  }
  const dueTasks = input.openTasks.filter((task) => isDueBeforeMeeting(task, input.event));
  if (dueTasks.length > 0) {
    checklist.push(
      `Review ${dueTasks.length} task${dueTasks.length === 1 ? "" : "s"} due before this meeting.`,
    );
    risk++;
  }
  const overdueCommitments = input.openCommitments.filter((c) => isCommitmentOverdue(c, input.now));
  if (overdueCommitments.length > 0) {
    checklist.push(
      `Resolve ${overdueCommitments.length} overdue commitment${overdueCommitments.length === 1 ? "" : "s"}.`,
    );
    risk++;
  }
  if (input.relatedEmails.length > 0) {
    checklist.push(
      `Skim ${input.relatedEmails.length} related email${input.relatedEmails.length === 1 ? "" : "s"}.`,
    );
  }
  if (checklist.length === 0) checklist.push("No prep risk detected.");

  const readiness: MeetingPrepReadiness =
    risk >= 2 ? "needs_review" : risk === 1 ? "watch" : "ready";
  return { readiness, checklist };
}

export async function buildMeetingPrepPack(
  userId: string,
  eventId: string,
  opts?: { now?: number },
): Promise<MeetingPrepPack | null> {
  const event = (await prisma.calendarEvent.findUnique({
    where: { id: eventId },
  })) as EventRow | null;
  if (!event || event.userId !== userId) return null;

  const now = opts?.now ?? Date.now();
  const keywords = extractKeywords(event);

  const [emails, tasks, commitments] = (await Promise.all([
    prisma.emailMessage.findMany({
      where: { userId },
      orderBy: { receivedAt: "desc" },
      take: 50,
    }),
    prisma.task.findMany({
      where: { userId, status: { not: "DONE" } },
      orderBy: [{ dueDate: "asc" }, { updatedAt: "desc" }],
      take: 50,
    }),
    prisma.commitment.findMany({
      where: { userId, status: "OPEN" },
      orderBy: [{ dueAt: "asc" }, { updatedAt: "desc" }],
      take: 50,
    }),
  ])) as [EmailRow[], TaskRow[], CommitmentRow[]];

  const relatedEmails = rankByKeywords(
    emails,
    keywords,
    (email) =>
      `${email.from} ${email.subject} ${email.snippet || ""} ${email.summary || ""} ${email.body || ""}`,
  ).slice(0, 3);

  const keywordTasks = rankByKeywords(
    tasks,
    keywords,
    (task) => `${task.title} ${task.description || ""}`,
  );
  const openTasks = [
    ...new Map(
      [...keywordTasks, ...tasks.filter((t) => isDueBeforeMeeting(t, event))].map((t) => [t.id, t]),
    ).values(),
  ].slice(0, 3);

  const openCommitments = rankByKeywords(
    commitments,
    keywords,
    (c) => `${c.title} ${c.description || ""} ${c.counterpartyName || ""}`,
  ).slice(0, 3);

  const checklist = buildChecklist({ event, relatedEmails, openTasks, openCommitments, now });

  return {
    generatedAt: new Date(now).toISOString(),
    event: toEvent(event),
    readiness: checklist.readiness,
    checklist: checklist.checklist,
    relatedEmails: relatedEmails.map((email) => ({
      id: email.id,
      from: email.from,
      subject: email.subject,
      snippet: email.snippet,
      receivedAt: email.receivedAt.toISOString(),
      isRead: email.isRead,
    })),
    openTasks: openTasks.map((task) => ({
      id: task.id,
      title: task.title,
      status: task.status,
      priority: task.priority,
      dueDate: task.dueDate ? task.dueDate.toISOString() : null,
    })),
    openCommitments: openCommitments.map((commitment) => ({
      id: commitment.id,
      title: commitment.title,
      owner: commitment.owner,
      dueAt: commitment.dueAt ? commitment.dueAt.toISOString() : null,
      dueText: commitment.dueText,
      confidence: commitment.confidence,
    })),
  };
}
