import { upsertAttentionForTask } from "../attention-mirror.js";
import { prisma } from "../db.js";

const OPEN_STATUSES = ["TODO", "IN_PROGRESS"] as const;
const DUPLICATE_WINDOW_MS = 24 * 60 * 60 * 1000;
const MAX_OPEN_TASKS_IN_WINDOW = 15;
const DUPLICATE_JACCARD_THRESHOLD = 0.5;

// Noise words that should not count toward title similarity. Without this,
// two unrelated long English titles can trip the threshold on filler words alone.
const STOPWORDS = new Set([
  "the",
  "and",
  "for",
  "with",
  "from",
  "into",
  "onto",
  "this",
  "that",
  "these",
  "those",
  "will",
  "would",
  "could",
  "should",
  "about",
  "your",
  "you",
  "our",
  "are",
  "is",
  "was",
  "were",
  "been",
  "being",
  "has",
  "have",
  "had",
  "not",
  "but",
  "any",
  "all",
  "via",
]);

export function normalizeTitleWords(title: string): Set<string> {
  const words = title
    .toLowerCase()
    .replace(/[[\]()'"“”‘’`~!@#$%^&*_+=<>?,./\\|{}:;-]/g, " ")
    .split(/\s+/)
    .map((w) => w.trim())
    .filter((w) => w.length >= 2 && !STOPWORDS.has(w));
  return new Set(words);
}

/**
 * Jaccard similarity on normalized title word sets: |A ∩ B| / |A ∪ B|.
 * Identical word sets → 1.0, no overlap → 0. Either side empty → 0.
 */
export function titleSimilarity(a: string, b: string): number {
  const aWords = normalizeTitleWords(a);
  const bWords = normalizeTitleWords(b);
  if (aWords.size === 0 || bWords.size === 0) return 0;
  let intersect = 0;
  for (const w of aWords) if (bWords.has(w)) intersect++;
  const union = aWords.size + bWords.size - intersect;
  return union === 0 ? 0 : intersect / union;
}

export async function listTasks(userId: string, status?: string) {
  const where: Record<string, unknown> = { userId };
  if (status) where.status = status.toUpperCase();

  const tasks = await prisma.task.findMany({
    where,
    orderBy: [{ priority: "desc" }, { dueDate: "asc" }, { createdAt: "desc" }],
  });

  return {
    tasks: tasks.map(
      (t: {
        id: string;
        title: string;
        description: string | null;
        status: string;
        priority: string;
        dueDate: Date | null;
      }) => ({
        id: t.id,
        title: t.title,
        description: t.description,
        status: t.status,
        priority: t.priority,
        dueDate: t.dueDate?.toISOString() || null,
      }),
    ),
  };
}

type TaskSummary = { id: string; title: string; status: string };
export type CreateTaskResult =
  | { success: true; task: TaskSummary }
  | { success: false; reason: "too_many_open_tasks"; openTaskCount: number; message: string }
  | { success: false; reason: "duplicate"; existingTask: TaskSummary; message: string };

export async function createTask(
  userId: string,
  title: string,
  description?: string,
  priority?: string,
  dueDate?: string,
): Promise<CreateTaskResult> {
  const recentOpen = await prisma.task.findMany({
    where: {
      userId,
      status: { in: [...OPEN_STATUSES] },
      createdAt: { gte: new Date(Date.now() - DUPLICATE_WINDOW_MS) },
    },
    orderBy: { createdAt: "desc" },
    select: { id: true, title: true, status: true, createdAt: true },
  });

  if (recentOpen.length >= MAX_OPEN_TASKS_IN_WINDOW) {
    return {
      success: false,
      reason: "too_many_open_tasks" as const,
      openTaskCount: recentOpen.length,
      message: `You already have ${recentOpen.length} open tasks created in the last 24h. Complete or delete existing tasks before creating more — do not create another duplicate.`,
    };
  }

  const duplicate = recentOpen.find(
    (t) => titleSimilarity(t.title, title) >= DUPLICATE_JACCARD_THRESHOLD,
  );
  if (duplicate) {
    return {
      success: false,
      reason: "duplicate" as const,
      existingTask: { id: duplicate.id, title: duplicate.title, status: duplicate.status },
      message: `A similar open task already exists: "${duplicate.title}" (id: ${duplicate.id}). Use update_task on the existing task instead of creating a new one.`,
    };
  }

  const task = await prisma.task.create({
    data: {
      userId,
      title,
      description: description || null,
      priority: (priority?.toUpperCase() as "LOW" | "MEDIUM" | "HIGH" | "URGENT") || "MEDIUM",
      dueDate: dueDate ? new Date(dueDate) : null,
    },
  });
  await upsertAttentionForTask(task);

  return { success: true, task: { id: task.id, title: task.title, status: task.status } };
}
