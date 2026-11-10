/**
 * Ownership of commitments and their fulfillment paths at the service layer
 * (src/pim/commitments.ts, src/pim/commitment-path.ts). The routes check the
 * owner before calling in (routes-commitments.test.ts covers that), and every
 * service call is scoped to the caller's userId as well: another user's
 * commitment id reads nothing, changes nothing and creates nothing.
 *
 * The prisma stand-in honours the `where` filters it is given, including the
 * `commitment: { userId }` relation filter, so a query that omits the owner
 * matches another user's row exactly as the real database would.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

type CommitmentRow = {
  id: string;
  userId: string;
  title: string;
  description: string | null;
  status: string;
  dueAt: Date | null;
  dueText: string | null;
  kind: string;
  evidenceText: string | null;
};
type PathRow = {
  id: string;
  commitmentId: string;
  steps: unknown;
  builtAt: Date;
  model: string | null;
};
type TaskRow = { id: string; userId: string; title: string };

const commitments: CommitmentRow[] = [];
const paths: PathRow[] = [];
const tasks: TaskRow[] = [];

type Where = Record<string, unknown>;

function commitmentMatches(row: CommitmentRow, where: Where): boolean {
  return Object.entries(where).every(([key, value]) => row[key as keyof CommitmentRow] === value);
}

function pathMatches(row: PathRow, where: Where): boolean {
  return Object.entries(where).every(([key, value]) => {
    if (key === "commitment") {
      const parent = commitments.find((c) => c.id === row.commitmentId);
      return parent !== undefined && commitmentMatches(parent, value as Where);
    }
    return row[key as keyof PathRow] === value;
  });
}

/** Prisma's update/delete throw P2025 when the unique filter matches nothing. */
function notFound(): never {
  throw Object.assign(new Error("Record to update not found."), { code: "P2025" });
}

vi.mock("../db.js", () => {
  const prisma = {
    commitment: {
      findUnique: vi.fn(
        async ({ where }: { where: Where }) =>
          commitments.find((c) => commitmentMatches(c, where)) ?? null,
      ),
      findFirst: vi.fn(
        async ({ where }: { where: Where }) =>
          commitments.find((c) => commitmentMatches(c, where)) ?? null,
      ),
      update: vi.fn(async ({ where, data }: { where: Where; data: Partial<CommitmentRow> }) => {
        const idx = commitments.findIndex((c) => commitmentMatches(c, where));
        if (idx < 0) notFound();
        commitments[idx] = { ...(commitments[idx] as CommitmentRow), ...data };
        return commitments[idx];
      }),
      delete: vi.fn(async ({ where }: { where: Where }) => {
        const idx = commitments.findIndex((c) => commitmentMatches(c, where));
        if (idx < 0) notFound();
        return commitments.splice(idx, 1)[0];
      }),
      deleteMany: vi.fn(async ({ where }: { where: Where }) => {
        const before = commitments.length;
        const kept = commitments.filter((c) => !commitmentMatches(c, where));
        commitments.splice(0, commitments.length, ...kept);
        return { count: before - kept.length };
      }),
    },
    commitmentPath: {
      findUnique: vi.fn(
        async ({ where }: { where: Where }) => paths.find((p) => pathMatches(p, where)) ?? null,
      ),
      findFirst: vi.fn(
        async ({ where }: { where: Where }) => paths.find((p) => pathMatches(p, where)) ?? null,
      ),
      upsert: vi.fn(
        async ({
          where,
          create,
          update,
        }: {
          where: Where;
          create: Omit<PathRow, "id" | "builtAt">;
          update: Partial<PathRow>;
        }) => {
          const idx = paths.findIndex((p) => pathMatches(p, where));
          if (idx >= 0) {
            paths[idx] = { ...(paths[idx] as PathRow), ...update };
            return paths[idx];
          }
          const row: PathRow = { id: `p-${paths.length + 1}`, builtAt: new Date(), ...create };
          paths.push(row);
          return row;
        },
      ),
      update: vi.fn(async ({ where, data }: { where: Where; data: Partial<PathRow> }) => {
        const idx = paths.findIndex((p) => pathMatches(p, where));
        if (idx < 0) notFound();
        paths[idx] = { ...(paths[idx] as PathRow), ...data };
        return paths[idx];
      }),
    },
    task: {
      create: vi.fn(async ({ data }: { data: { userId: string; title: string } }) => {
        const row = { id: `t-${tasks.length + 1}`, userId: data.userId, title: data.title };
        tasks.push(row);
        return { id: row.id };
      }),
    },
  };
  return { prisma, db: prisma };
});

vi.mock("../judge/attention-mirror.js", () => ({
  upsertAttentionForCommitment: vi.fn(async () => undefined),
  deleteAttentionForCommitments: vi.fn(async () => undefined),
}));

vi.mock("../llm/openai.js", () => ({
  MODEL: "test-model",
  createCompletion: vi.fn(async () => ({
    choices: [
      {
        message: {
          content: JSON.stringify([
            { step: "Draft the deck", action: "write", daysFromNow: 1, estimatedMinutes: 30 },
          ]),
        },
      },
    ],
  })),
}));

const OWNER = "user-a";
const OTHER = "user-b";
const STEPS = [
  { step: "Owner-only step one", action: "write", dueIso: "2026-12-01T00:00:00.000Z" },
  { step: "Owner-only step two", action: "send", dueIso: "2026-12-02T00:00:00.000Z" },
];

function seed() {
  commitments.splice(0, commitments.length, {
    id: "c-owned",
    userId: OWNER,
    title: "Send the board deck",
    description: "Owner-only description",
    status: "OPEN",
    dueAt: new Date("2026-12-05T00:00:00.000Z"),
    dueText: null,
    kind: "PROMISE",
    evidenceText: null,
  });
  paths.splice(0, paths.length, {
    id: "p-owned",
    commitmentId: "c-owned",
    steps: STEPS,
    builtAt: new Date("2026-11-01T00:00:00.000Z"),
    model: "test-model",
  });
  tasks.length = 0;
}

const snapshot = () => JSON.stringify({ commitments, paths, tasks });

describe("commitment services are scoped to the caller", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    seed();
  });

  it("updateCommitment changes nothing for another user's id", async () => {
    const { updateCommitment } = await import("../pim/commitments.js");
    const before = snapshot();
    await expect(updateCommitment("c-owned", OTHER, { status: "DONE" })).rejects.toMatchObject({
      code: "P2025",
    });
    expect(snapshot()).toBe(before);
    const { upsertAttentionForCommitment } = await import("../judge/attention-mirror.js");
    expect(upsertAttentionForCommitment).not.toHaveBeenCalled();
  });

  it("updateCommitment updates the owner's row", async () => {
    const { updateCommitment } = await import("../pim/commitments.js");
    const updated = await updateCommitment("c-owned", OWNER, { status: "DONE" });
    expect(updated.status).toBe("DONE");
    expect(commitments[0]?.status).toBe("DONE");
  });

  it("deleteCommitment deletes nothing for another user's id", async () => {
    const { deleteCommitment } = await import("../pim/commitments.js");
    const before = snapshot();
    await deleteCommitment("c-owned", OTHER);
    expect(snapshot()).toBe(before);
    const { deleteAttentionForCommitments } = await import("../judge/attention-mirror.js");
    expect(deleteAttentionForCommitments).not.toHaveBeenCalled();
  });

  it("deleteCommitment deletes the owner's row and its queue mirror", async () => {
    const { deleteCommitment } = await import("../pim/commitments.js");
    await deleteCommitment("c-owned", OWNER);
    expect(commitments).toHaveLength(0);
    const { deleteAttentionForCommitments } = await import("../judge/attention-mirror.js");
    expect(deleteAttentionForCommitments).toHaveBeenCalledWith(["c-owned"], OWNER);
  });
});

describe("commitment path services are scoped to the caller", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    seed();
  });

  it("getOrBuildPath returns none of another user's path and builds nothing", async () => {
    const { getOrBuildPath } = await import("../pim/commitment-path.js");
    const before = snapshot();
    const result = await getOrBuildPath(OTHER, "c-owned").catch((err: unknown) => err);
    expect(result).toBeInstanceOf(Error);
    expect((result as Error).message).not.toContain("Owner-only");
    expect(snapshot()).toBe(before);
    const { createCompletion } = await import("../llm/openai.js");
    expect(createCompletion).not.toHaveBeenCalled();
  });

  it("getOrBuildPath returns the owner's stored path", async () => {
    const { getOrBuildPath } = await import("../pim/commitment-path.js");
    const path = await getOrBuildPath(OWNER, "c-owned");
    expect(path.steps).toEqual(STEPS);
  });

  it("buildPath builds nothing for another user's id", async () => {
    const { buildPath } = await import("../pim/commitment-path.js");
    const before = snapshot();
    await expect(buildPath(OTHER, "c-owned")).rejects.toThrow();
    expect(snapshot()).toBe(before);
    const { createCompletion } = await import("../llm/openai.js");
    expect(createCompletion).not.toHaveBeenCalled();
  });

  it("materializeStepAsTask creates no task from another user's path", async () => {
    const { materializeStepAsTask } = await import("../pim/commitment-path.js");
    const before = snapshot();
    await expect(materializeStepAsTask(OTHER, "c-owned", 0)).rejects.toThrow();
    expect(snapshot()).toBe(before);
  });

  it("materializeAllSteps creates no tasks from another user's path", async () => {
    const { materializeAllSteps } = await import("../pim/commitment-path.js");
    const before = snapshot();
    await expect(materializeAllSteps(OTHER, "c-owned")).rejects.toThrow();
    expect(snapshot()).toBe(before);
  });

  it("materializes the owner's steps as the owner's tasks", async () => {
    const { materializeAllSteps } = await import("../pim/commitment-path.js");
    const { taskIds } = await materializeAllSteps(OWNER, "c-owned");
    expect(taskIds).toHaveLength(2);
    expect(tasks.every((t) => t.userId === OWNER)).toBe(true);
  });
});
