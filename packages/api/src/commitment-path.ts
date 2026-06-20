/**
 * Commitment Fulfillment Paths — AI backward chaining
 *
 * Given a commitment with a due date, asks an LLM to work backward and
 * produce a concrete step-by-step plan: "deck due Friday" → create slides
 * (Tue), review draft (Wed), send (Fri). Each step can optionally be
 * materialized as a Task or CalendarEvent with a single API call.
 *
 * This is a world-first feature: most AI tools surface *what* is due,
 * but not *how to get there*. The path bridges the gap between "I promised
 * to deliver X" and "here are the three things I need to do this week."
 */

import { prisma } from "./db.js";
import { parseLlmJson } from "./llm-json.js";
import { createCompletion, MODEL } from "./openai.js";

export interface PathStep {
  step: string;
  action: "task" | "event" | "email" | "check";
  dueIso: string;
  estimatedMinutes: number;
  taskId?: string | null;
  eventId?: string | null;
}

export interface CommitmentPathData {
  id: string;
  commitmentId: string;
  steps: PathStep[];
  builtAt: string;
  model: string | null;
}

// ─── Public API ────────────────────────────────────────────────────────────────

/** Returns the existing path or builds one if none exists. */
export async function getOrBuildPath(
  userId: string,
  commitmentId: string,
): Promise<CommitmentPathData> {
  const existing = await loadPath(commitmentId);
  if (existing) return existing;
  return buildPath(userId, commitmentId);
}

/** Force-rebuild the path for a commitment (e.g. user changes due date). */
export async function buildPath(userId: string, commitmentId: string): Promise<CommitmentPathData> {
  const commitment = await prisma.commitment.findFirst({
    where: { id: commitmentId, userId },
    select: {
      id: true,
      title: true,
      description: true,
      dueAt: true,
      dueText: true,
      kind: true,
      evidenceText: true,
    },
  });
  if (!commitment) throw new Error("Commitment not found");

  const now = new Date();
  const dueAt = commitment.dueAt ?? addDays(now, 7);
  const daysUntilDue = Math.max(
    1,
    Math.ceil((dueAt.getTime() - now.getTime()) / (24 * 60 * 60 * 1000)),
  );

  const prompt = buildPathPrompt(commitment, now, daysUntilDue);
  const response = await createCompletion(
    {
      model: MODEL,
      messages: [
        {
          role: "system",
          content:
            "You are a planning assistant. Return ONLY valid JSON — an array of step objects. No markdown, no explanation.",
        },
        { role: "user", content: prompt },
      ],
      max_tokens: 600,
      temperature: 0.2,
    },
    { userId },
  );

  const raw = response.choices[0]?.message?.content?.trim() ?? "[]";
  const steps = parseSteps(raw, now, dueAt);

  const model = (
    prisma as unknown as {
      commitmentPath?: {
        upsert: (args: unknown) => Promise<{ id: string; builtAt: Date; model: string | null }>;
      };
    }
  ).commitmentPath;

  if (!model) {
    return { id: "tmp", commitmentId, steps, builtAt: now.toISOString(), model: MODEL };
  }

  const row = (await model.upsert({
    where: { commitmentId },
    create: { commitmentId, steps, model: MODEL },
    update: { steps, builtAt: now, model: MODEL },
  })) as { id: string; builtAt: Date; model: string | null };

  return {
    id: row.id,
    commitmentId,
    steps,
    builtAt: row.builtAt.toISOString(),
    model: row.model,
  };
}

/**
 * Materialize a single path step as a Task.
 * Returns the created task id.
 */
export async function materializeStepAsTask(
  userId: string,
  commitmentId: string,
  stepIndex: number,
): Promise<{ taskId: string }> {
  const path = await loadPath(commitmentId);
  if (!path) throw new Error("No path found for commitment");

  const step = path.steps[stepIndex];
  if (!step) throw new Error(`Step ${stepIndex} not found`);

  const task = await prisma.task.create({
    data: {
      userId,
      title: step.step,
      status: "TODO",
      priority: "MEDIUM",
      dueDate: new Date(step.dueIso),
    },
    select: { id: true },
  });

  // Patch the step with the new taskId
  const updated = path.steps.map((s, i) => (i === stepIndex ? { ...s, taskId: task.id } : s));

  const model = (
    prisma as unknown as {
      commitmentPath?: { update: (args: unknown) => Promise<unknown> };
    }
  ).commitmentPath;
  if (model) {
    await model.update({ where: { commitmentId }, data: { steps: updated } });
  }

  return { taskId: task.id };
}

/**
 * Materialize all unlinked steps in a path as Tasks at once.
 */
export async function materializeAllSteps(
  userId: string,
  commitmentId: string,
): Promise<{ taskIds: string[] }> {
  const path = await loadPath(commitmentId);
  if (!path) throw new Error("No path found for commitment");

  const taskIds: string[] = [];
  const updated = [...path.steps];

  for (let i = 0; i < updated.length; i++) {
    const step = updated[i];
    if (!step || step.taskId) continue;

    const task = await prisma.task.create({
      data: {
        userId,
        title: step.step,
        status: "TODO",
        priority: "MEDIUM",
        dueDate: new Date(step.dueIso),
      },
      select: { id: true },
    });
    updated[i] = { ...step, taskId: task.id };
    taskIds.push(task.id);
  }

  const model = (
    prisma as unknown as {
      commitmentPath?: { update: (args: unknown) => Promise<unknown> };
    }
  ).commitmentPath;
  if (model && taskIds.length > 0) {
    await model.update({ where: { commitmentId }, data: { steps: updated } });
  }

  return { taskIds };
}

// ─── Internals ────────────────────────────────────────────────────────────────

async function loadPath(commitmentId: string): Promise<CommitmentPathData | null> {
  const model = (
    prisma as unknown as {
      commitmentPath?: {
        findUnique: (args: unknown) => Promise<{
          id: string;
          steps: unknown;
          builtAt: Date;
          model: string | null;
        } | null>;
      };
    }
  ).commitmentPath;
  if (!model) return null;

  const row = await model.findUnique({ where: { commitmentId } });
  if (!row) return null;

  return {
    id: row.id,
    commitmentId,
    steps: row.steps as PathStep[],
    builtAt: row.builtAt.toISOString(),
    model: row.model,
  };
}

function buildPathPrompt(
  commitment: {
    title: string;
    description?: string | null;
    dueText?: string | null;
    kind: string;
    evidenceText?: string | null;
  },
  now: Date,
  daysUntilDue: number,
): string {
  const today = now.toISOString().slice(0, 10);
  const dueLabel = commitment.dueText ?? `${daysUntilDue} days from now`;
  const evidence = commitment.evidenceText
    ? `\nOriginal promise: "${commitment.evidenceText}"`
    : "";

  return `Today is ${today}. The user must fulfill this commitment in ${daysUntilDue} day(s) (due: ${dueLabel}).

Commitment: "${commitment.title}"
Type: ${commitment.kind}${evidence}

Work backward from the due date. Generate 2–5 concrete steps the user must take to deliver this on time. For each step:
- "step": short imperative sentence (max 80 chars)
- "action": one of "task" | "event" | "email" | "check"
- "dueIso": ISO 8601 date-time string (schedule realistically, not all on the last day)
- "estimatedMinutes": realistic time estimate (15–240)

Return ONLY a JSON array. Example:
[{"step":"Draft initial outline","action":"task","dueIso":"${today}T14:00:00Z","estimatedMinutes":60},{"step":"Review and revise draft","action":"task","dueIso":"${addDays(
    now,
    daysUntilDue - 1,
  )
    .toISOString()
    .slice(0, 10)}T10:00:00Z","estimatedMinutes":30}]`;
}

function parseSteps(raw: string, now: Date, dueAt: Date): PathStep[] {
  try {
    const arr = parseLlmJson<unknown>(raw);
    if (!Array.isArray(arr)) return fallbackSteps(now, dueAt);

    return arr
      .slice(0, 6)
      .map((item: unknown) => {
        const obj = item as Record<string, unknown>;
        const dueIso =
          typeof obj.dueIso === "string" && !Number.isNaN(Date.parse(obj.dueIso))
            ? obj.dueIso
            : now.toISOString();
        return {
          step: String(obj.step ?? "").slice(0, 120),
          action: (["task", "event", "email", "check"].includes(String(obj.action))
            ? obj.action
            : "task") as PathStep["action"],
          dueIso,
          estimatedMinutes:
            typeof obj.estimatedMinutes === "number"
              ? Math.max(5, Math.min(480, Math.round(obj.estimatedMinutes)))
              : 30,
          taskId: null,
          eventId: null,
        };
      })
      .filter((s) => s.step.length > 0);
  } catch {
    return fallbackSteps(now, dueAt);
  }
}

function fallbackSteps(now: Date, dueAt: Date): PathStep[] {
  const mid = addDays(
    now,
    Math.max(1, Math.floor((dueAt.getTime() - now.getTime()) / (2 * 24 * 60 * 60 * 1000))),
  );
  return [
    {
      step: "Plan and prepare deliverable",
      action: "task",
      dueIso: mid.toISOString(),
      estimatedMinutes: 60,
      taskId: null,
      eventId: null,
    },
    {
      step: "Finalize and send",
      action: "task",
      dueIso: addDays(dueAt, -1).toISOString(),
      estimatedMinutes: 30,
      taskId: null,
      eventId: null,
    },
  ];
}

function addDays(date: Date, days: number): Date {
  return new Date(date.getTime() + days * 24 * 60 * 60 * 1000);
}
