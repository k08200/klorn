import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

// Real-Postgres check of the attachment identity key. Gmail mints a fresh
// attachmentId on every messages.get, so ("emailId", "gmailAttachmentId") never
// matched a re-fetch and every re-sync inserted another copy (prod 2026-10-16:
// 123,997 rows for 296 files). Mocked SQL cannot prove ON CONFLICT or adoption
// semantics, so these run the real statements. Skipped unless
// KLORN_TEST_PG_URL points at a database with every migration applied.
vi.mock("../db.js", async () => {
  const { PrismaClient } = await import("@prisma/client");
  const url = process.env.KLORN_TEST_PG_URL;
  return { prisma: url ? new PrismaClient({ datasources: { db: { url } } }) : {} };
});
vi.mock("../llm/llm-credentials.js", () => ({ getUserLlmCredentials: vi.fn() }));
vi.mock("../llm/openai.js", () => ({ createCompletion: vi.fn(), MODEL: "test-model" }));

import { prisma } from "../db.js";
import {
  isUniqueViolation,
  type RawEmailAttachment,
  upsertEmailAttachments,
} from "../mail/email-attachments.js";

const describePg = process.env.KLORN_TEST_PG_URL ? describe : describe.skip;

const userId = `u-${randomUUID()}`;
const emailId = `e-${randomUUID()}`;

function part(overrides: Partial<RawEmailAttachment>): RawEmailAttachment {
  return {
    gmailAttachmentId: `ANGj-${randomUUID()}`,
    partKey: "1",
    filename: "contract.pdf",
    mimeType: "application/pdf",
    size: 1024,
    contentId: null,
    contentText: "contract text",
    ...overrides,
  };
}

interface Row {
  id: string;
  partKey: string | null;
  gmailAttachmentId: string;
  contentId: string | null;
  summary: string | null;
}

async function rows(): Promise<Row[]> {
  return prisma.$queryRaw<Row[]>`
    SELECT "id", "partKey", "gmailAttachmentId", "contentId", "summary"
    FROM "EmailAttachment" WHERE "emailId" = ${emailId} ORDER BY "id"`;
}

async function insertLegacy(input: {
  id: string;
  filename?: string;
  contentId?: string | null;
  summary?: string | null;
  createdAt: string;
}): Promise<void> {
  await prisma.$executeRaw`
    INSERT INTO "EmailAttachment" (
      "id", "userId", "emailId", "gmailAttachmentId", "filename", "mimeType",
      "size", "contentId", "summary", "createdAt", "updatedAt"
    ) VALUES (
      ${input.id}, ${userId}, ${emailId}, ${`ANGj-old-${input.id}`},
      ${input.filename ?? "contract.pdf"}, 'application/pdf', 1024,
      ${input.contentId ?? null}, ${input.summary ?? null},
      ${new Date(input.createdAt)}, NOW()
    )`;
}

describePg("upsertEmailAttachments: stable part identity (real Postgres)", () => {
  beforeAll(async () => {
    await prisma.$executeRaw`
      INSERT INTO "User" ("id", "email", "updatedAt") VALUES (${userId}, ${`${userId}@test.local`}, NOW())`;
    await prisma.$executeRaw`
      INSERT INTO "EmailMessage" ("id", "userId", "gmailId", "from", "to", "subject", "receivedAt", "updatedAt")
      VALUES (${emailId}, ${userId}, ${`g-${emailId}`}, 'a@b.test', 'c@d.test', 's', NOW(), NOW())`;
  });

  beforeEach(async () => {
    await prisma.$executeRaw`DELETE FROM "EmailAttachment" WHERE "emailId" = ${emailId}`;
  });

  afterAll(async () => {
    await prisma.$executeRaw`DELETE FROM "User" WHERE "id" = ${userId}`;
    await prisma.$disconnect();
  });

  it("keeps one row when Gmail re-mints the attachmentId on a re-fetch", async () => {
    await upsertEmailAttachments({ userId, emailId, attachments: [part({ gmailAttachmentId: "ANGj-a" })] });
    await upsertEmailAttachments({ userId, emailId, attachments: [part({ gmailAttachmentId: "ANGj-b" })] });

    const stored = await rows();
    expect(stored).toHaveLength(1);
    // The latest handle wins: it is what attachments.get is called with.
    expect(stored[0]).toMatchObject({ partKey: "1", gmailAttachmentId: "ANGj-b" });
  });

  it("keeps two parts with the same filename and size apart", async () => {
    await upsertEmailAttachments({
      userId,
      emailId,
      attachments: [part({ partKey: "1" }), part({ partKey: "2" })],
    });

    expect((await rows()).map((r) => r.partKey)).toEqual(expect.arrayContaining(["1", "2"]));
    expect(await rows()).toHaveLength(2);
  });

  it("adopts a pre-fix copy (the summarised one) instead of adding another", async () => {
    await insertLegacy({ id: "old-1", createdAt: "2026-05-11T00:00:00Z" });
    await insertLegacy({ id: "old-2", summary: "S", createdAt: "2026-05-12T00:00:00Z" });
    await insertLegacy({ id: "old-3", createdAt: "2026-05-13T00:00:00Z" });

    await upsertEmailAttachments({ userId, emailId, attachments: [part({ gmailAttachmentId: "ANGj-new" })] });

    const stored = await rows();
    expect(stored).toHaveLength(3);
    const keyed = stored.filter((r) => r.partKey !== null);
    expect(keyed).toEqual([
      expect.objectContaining({ id: "old-2", partKey: "1", gmailAttachmentId: "ANGj-new", summary: "S" }),
    ]);
  });

  it("adopts a copy synced before Content-ID capture and fills the Content-ID", async () => {
    await insertLegacy({ id: "old-1", contentId: null, createdAt: "2026-05-11T00:00:00Z" });

    await upsertEmailAttachments({ userId, emailId, attachments: [part({ contentId: "logo@mail" })] });

    expect(await rows()).toEqual([
      expect.objectContaining({ id: "old-1", partKey: "1", contentId: "logo@mail" }),
    ]);
  });

  it("does not adopt a copy of a different file", async () => {
    await insertLegacy({ id: "old-1", filename: "other.pdf", createdAt: "2026-05-11T00:00:00Z" });

    await upsertEmailAttachments({ userId, emailId, attachments: [part({})] });

    const stored = await rows();
    expect(stored).toHaveLength(2);
    expect(stored.find((r) => r.id === "old-1")?.partKey).toBeNull();
  });

  it("does not adopt a second copy once the part is keyed", async () => {
    await insertLegacy({ id: "old-1", createdAt: "2026-05-11T00:00:00Z" });
    await insertLegacy({ id: "old-2", createdAt: "2026-05-12T00:00:00Z" });

    await upsertEmailAttachments({ userId, emailId, attachments: [part({})] });
    await upsertEmailAttachments({ userId, emailId, attachments: [part({})] });

    const stored = await rows();
    expect(stored).toHaveLength(2);
    expect(stored.filter((r) => r.partKey === "1")).toHaveLength(1);
  });

  it("stays at one keyed row when two syncs upsert the same part at once", async () => {
    await insertLegacy({ id: "old-1", createdAt: "2026-05-11T00:00:00Z" });

    await Promise.all([
      upsertEmailAttachments({ userId, emailId, attachments: [part({ gmailAttachmentId: "ANGj-x" })] }),
      upsertEmailAttachments({ userId, emailId, attachments: [part({ gmailAttachmentId: "ANGj-y" })] }),
    ]);

    const stored = await rows();
    expect(stored).toHaveLength(1);
    expect(stored[0]?.partKey).toBe("1");
  });

  it("recognises the error Postgres raises for a duplicate part key", async () => {
    await upsertEmailAttachments({ userId, emailId, attachments: [part({ partKey: "1" })] });
    await upsertEmailAttachments({ userId, emailId, attachments: [part({ partKey: "2" })] });

    const err = await prisma.$executeRaw`
      UPDATE "EmailAttachment" SET "partKey" = '1'
      WHERE "emailId" = ${emailId} AND "partKey" = '2'`.catch((e: unknown) => e);

    expect(isUniqueViolation(err)).toBe(true);
    expect(isUniqueViolation(new Error("connection reset"))).toBe(false);
  });
});
