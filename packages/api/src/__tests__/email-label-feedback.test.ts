import { beforeEach, describe, expect, it, vi } from "vitest";

type EmailRow = {
  id: string;
  userId: string;
  from: string;
  subject: string;
  labels: string[];
  priority: "URGENT" | "NORMAL" | "LOW";
};

type FeedbackRow = {
  id: string;
  userId: string;
  emailId: string;
  originalPriority: "URGENT" | "NORMAL" | "LOW";
  correctedPriority: "URGENT" | "NORMAL" | "LOW";
  reason: string | null;
  signals: string[];
  fromAddress: string;
  subject: string;
  labels: string[];
  note: string | null;
  createdAt: Date;
  updatedAt: Date;
};

const store = vi.hoisted(() => ({
  emails: [] as EmailRow[],
  feedback: [] as FeedbackRow[],
  nextId: 1,
}));

vi.mock("../db.js", () => ({
  prisma: {
    emailMessage: {
      findFirst: vi.fn(
        async ({ where }: { where: { id: string; userId: string } }) =>
          store.emails.find((e) => e.id === where.id && e.userId === where.userId) ?? null,
      ),
    },
    emailLabelFeedback: {
      upsert: vi.fn(
        async ({
          where,
          create,
          update,
        }: {
          where: { userId_emailId: { userId: string; emailId: string } };
          create: Partial<FeedbackRow>;
          update: Partial<FeedbackRow>;
        }) => {
          const existing = store.feedback.find(
            (f) =>
              f.userId === where.userId_emailId.userId &&
              f.emailId === where.userId_emailId.emailId,
          );
          if (existing) {
            Object.assign(existing, update, { updatedAt: new Date("2026-04-29T00:00:00.000Z") });
            return existing;
          }
          const row: FeedbackRow = {
            id: `flb-${store.nextId++}`,
            userId: create.userId ?? "",
            emailId: create.emailId ?? "",
            originalPriority: create.originalPriority ?? "NORMAL",
            correctedPriority: create.correctedPriority ?? "NORMAL",
            reason: create.reason ?? null,
            signals: create.signals ?? [],
            fromAddress: create.fromAddress ?? "",
            subject: create.subject ?? "",
            labels: create.labels ?? [],
            note: create.note ?? null,
            createdAt: new Date("2026-04-28T00:00:00.000Z"),
            updatedAt: new Date("2026-04-28T00:00:00.000Z"),
          };
          store.feedback.push(row);
          return row;
        },
      ),
      findUnique: vi.fn(
        async ({ where }: { where: { userId_emailId: { userId: string; emailId: string } } }) =>
          store.feedback.find(
            (f) =>
              f.userId === where.userId_emailId.userId &&
              f.emailId === where.userId_emailId.emailId,
          ) ?? null,
      ),
    },
  },
}));

import { getFeedback, recordFeedback } from "../mail/email-label-feedback.js";

const seedEmail = (overrides: Partial<EmailRow> = {}): EmailRow => ({
  id: "email-1",
  userId: "user-1",
  from: "kim@vc-fund.com",
  subject: "Term sheet review by Friday",
  labels: ["INBOX"],
  priority: "NORMAL",
  ...overrides,
});

describe("email label feedback", () => {
  beforeEach(() => {
    store.emails.length = 0;
    store.feedback.length = 0;
    store.nextId = 1;
  });

  describe("recordFeedback", () => {
    it("captures originalPriority + heuristic signals at the moment of correction", async () => {
      store.emails.push(seedEmail());

      const row = await recordFeedback({
        userId: "user-1",
        emailId: "email-1",
        correctedPriority: "URGENT",
      });

      expect(row.originalPriority).toBe("NORMAL");
      expect(row.correctedPriority).toBe("URGENT");
      // The classifier evidence at feedback time should be persisted so we can
      // later replay the case as a regression test or few-shot example.
      expect(row.reason).toBeTruthy();
      expect(row.signals.length).toBeGreaterThan(0);
      expect(row.fromAddress).toBe("kim@vc-fund.com");
      expect(row.subject).toBe("Term sheet review by Friday");
      expect(row.labels).toEqual(["INBOX"]);
    });

    it("upsert is idempotent on (userId, emailId) — re-correction overwrites prior", async () => {
      store.emails.push(seedEmail());

      const first = await recordFeedback({
        userId: "user-1",
        emailId: "email-1",
        correctedPriority: "URGENT",
      });
      const second = await recordFeedback({
        userId: "user-1",
        emailId: "email-1",
        correctedPriority: "LOW",
        note: "actually a digest",
      });

      expect(second.id).toBe(first.id);
      expect(second.correctedPriority).toBe("LOW");
      expect(second.note).toBe("actually a digest");
      expect(store.feedback.length).toBe(1);
    });

    it("404s when the email does not belong to the requesting user", async () => {
      store.emails.push(seedEmail({ userId: "other-user" }));

      await expect(
        recordFeedback({
          userId: "user-1",
          emailId: "email-1",
          correctedPriority: "URGENT",
        }),
      ).rejects.toThrow(/not found/i);
    });

    it("rejects invalid correctedPriority values", async () => {
      store.emails.push(seedEmail());

      await expect(
        recordFeedback({
          userId: "user-1",
          emailId: "email-1",
          // biome-ignore lint/suspicious/noExplicitAny: deliberate bad input
          correctedPriority: "BOGUS" as any,
        }),
      ).rejects.toThrow(/priority/i);
    });

    it("rejects when corrected matches original — no signal to learn from", async () => {
      store.emails.push(seedEmail({ priority: "URGENT" }));

      await expect(
        recordFeedback({
          userId: "user-1",
          emailId: "email-1",
          correctedPriority: "URGENT",
        }),
      ).rejects.toThrow(/same/i);
    });
  });

  describe("getFeedback", () => {
    it("returns null when no feedback recorded", async () => {
      expect(await getFeedback("user-1", "email-1")).toBeNull();
    });

    it("returns the existing feedback row", async () => {
      store.emails.push(seedEmail());
      await recordFeedback({
        userId: "user-1",
        emailId: "email-1",
        correctedPriority: "URGENT",
      });
      const row = await getFeedback("user-1", "email-1");
      expect(row?.correctedPriority).toBe("URGENT");
    });
  });
});
