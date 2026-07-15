import { beforeEach, describe, expect, it, vi } from "vitest";

type StoredTask = {
  id: string;
  userId: string;
  title: string;
  status: "TODO" | "IN_PROGRESS" | "DONE";
  priority: "LOW" | "MEDIUM" | "HIGH" | "URGENT";
  description: string | null;
  dueDate: Date | null;
  createdAt: Date;
};

const store: StoredTask[] = [];
let idCounter = 1;

vi.mock("../db.js", () => ({
  prisma: {
    task: {
      findMany: vi.fn(
        async ({
          where,
        }: {
          where: {
            userId: string;
            status?: { in: string[] };
            createdAt?: { gte: Date };
          };
        }) => {
          return store
            .filter((t) => t.userId === where.userId)
            .filter((t) => !where.status || where.status.in.includes(t.status))
            .filter((t) => !where.createdAt || t.createdAt >= where.createdAt.gte)
            .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
        },
      ),
      create: vi.fn(
        async ({ data }: { data: Partial<StoredTask> & { userId: string; title: string } }) => {
          const task: StoredTask = {
            id: `task-${idCounter++}`,
            userId: data.userId,
            title: data.title,
            description: data.description ?? null,
            status: data.status ?? "TODO",
            priority: data.priority ?? "MEDIUM",
            dueDate: data.dueDate ?? null,
            createdAt: new Date(),
          };
          store.push(task);
          return task;
        },
      ),
    },
  },
}));

describe("createTask dedup", () => {
  beforeEach(() => {
    store.length = 0;
    idCounter = 1;
  });

  it("creates a task when no duplicates exist", async () => {
    const { createTask } = await import("../pim/tasks.js");
    const result = await createTask("user-1", "Write the quarterly report");
    expect(result.success).toBe(true);
    if (result.success) expect(result.task.title).toBe("Write the quarterly report");
  });

  it("blocks creation when a similar open task already exists", async () => {
    const { createTask } = await import("../pim/tasks.js");
    await createTask("user-1", "앤트로픽 인턴 남은 작업 1개 제출 패키징");
    const result = await createTask("user-1", "앤트로픽 인턴 남은 작업 1개 최종 체크 패키징");
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.reason).toBe("duplicate");
      expect(result.existingTask?.title).toContain("앤트로픽");
    }
  });

  it("allows creation when titles share few keywords", async () => {
    const { createTask } = await import("../pim/tasks.js");
    await createTask("user-1", "Buy groceries today");
    const result = await createTask("user-1", "Fix login bug in staging");
    expect(result.success).toBe(true);
  });

  it("flags identical short titles as duplicates", async () => {
    const { createTask } = await import("../pim/tasks.js");
    await createTask("user-1", "Buy milk");
    const result = await createTask("user-1", "Buy milk");
    expect(result.success).toBe(false);
    if (!result.success) expect(result.reason).toBe("duplicate");
  });

  it("does not flag unrelated long titles that only share stopwords", async () => {
    const { createTask } = await import("../pim/tasks.js");
    await createTask("user-1", "Review the quarterly financial projections with the team");
    const result = await createTask("user-1", "Ship the new onboarding flow with the designers");
    expect(result.success).toBe(true);
  });

  it("treats punctuation and casing differences as the same title", async () => {
    const { createTask } = await import("../pim/tasks.js");
    await createTask("user-1", "Fix the LOGIN-bug in staging");
    const result = await createTask("user-1", "fix the login bug in staging!");
    expect(result.success).toBe(false);
    if (!result.success) expect(result.reason).toBe("duplicate");
  });

  it("blocks creation when user has too many recent open tasks", async () => {
    const { createTask } = await import("../pim/tasks.js");
    for (let i = 0; i < 15; i++) {
      store.push({
        id: `seed-${i}`,
        userId: "user-spam",
        title: `Unique task ${i} alpha beta gamma`,
        status: "TODO",
        priority: "MEDIUM",
        description: null,
        dueDate: null,
        createdAt: new Date(),
      });
    }
    const result = await createTask("user-spam", "Completely new unrelated task about weather");
    expect(result.success).toBe(false);
    if (!result.success) expect(result.reason).toBe("too_many_open_tasks");
  });

  it("does not count DONE tasks toward dedup", async () => {
    const { createTask } = await import("../pim/tasks.js");
    store.push({
      id: "old-done",
      userId: "user-2",
      title: "앤트로픽 인턴 남은 작업 1개 제출",
      status: "DONE",
      priority: "MEDIUM",
      description: null,
      dueDate: null,
      createdAt: new Date(),
    });
    const result = await createTask("user-2", "앤트로픽 인턴 남은 작업 1개 제출 새 버전");
    expect(result.success).toBe(true);
  });

  it("isolates dedup per user", async () => {
    const { createTask } = await import("../pim/tasks.js");
    await createTask("user-a", "Weekly planning session with team leads");
    const result = await createTask("user-b", "Weekly planning session with team leads");
    expect(result.success).toBe(true);
  });
});
