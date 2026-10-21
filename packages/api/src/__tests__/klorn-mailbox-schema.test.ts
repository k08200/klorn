/**
 * Step E1a of docs/providers/unified-platform-plan.md: the KLORN inbox provider.
 * The provider list lives in three places that nothing ties together (the Prisma
 * enum, the API's InboxProviderName and the contract's InboxProvider); this pins
 * them to one list. A KLORN mailbox has no provider actions until E2.
 */

import { readdirSync, readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";

vi.mock("../db.js", () => {
  const prisma = { linkedInboxAccount: { findFirst: vi.fn() } };
  return { prisma, db: prisma };
});
vi.mock("../sentry.js", () => ({ captureError: vi.fn() }));

const { mailActionsForProvider } = await import("../mail/providers/dispatch.js");

const read = (path: string) => readFileSync(new URL(path, import.meta.url), "utf8");

function prismaEnum(name: string): string[] {
  const schema = read("../../prisma/schema.prisma");
  const block = schema.match(new RegExp(`enum ${name} \\{([^}]*)\\}`))?.[1] ?? "";
  return block
    .split("\n")
    .map((line) => line.replace(/\/\/.*$/, "").trim())
    .filter(Boolean)
    .sort();
}

function stringUnion(source: string, typeName: string): string[] {
  const union = source.match(new RegExp(`export type ${typeName} =([^;]*);`))?.[1] ?? "";
  return [...union.matchAll(/"([A-Z]+)"/g)].map((m) => m[1] ?? "").sort();
}

describe("the inbox provider list", () => {
  it("is the same in the Prisma enum, the API and the contract", () => {
    const prisma = prismaEnum("InboxProvider");
    const api = stringUnion(read("../mail/inbox-credentials.ts"), "InboxProviderName");
    const contract = stringUnion(read("../../../contract/src/email.ts"), "InboxProvider");
    expect(prisma).toContain("KLORN");
    expect(api).toEqual(prisma);
    expect(contract).toEqual(prisma);
  });
});

describe("a Klorn mailbox's provider actions", () => {
  it("are unsupported until E2", async () => {
    const actions = mailActionsForProvider("KLORN");
    expect(actions.provider).toBe("KLORN");
    await expect(
      actions.sendEmail({ to: "a@b.c", subject: "s", body: "b" } as never),
    ).resolves.toMatchObject({ unsupported: true });
    await expect(actions.archive("m1" as never)).resolves.toMatchObject({ unsupported: true });
  });
});

describe("the KlornAddress migration", () => {
  const migrationDir = new URL("../../prisma/migrations/", import.meta.url);
  const sql = (() => {
    const dir = readdirSync(migrationDir).find((d) => d.endsWith("_klorn_mailbox_schema"));
    return dir ? readFileSync(new URL(`${dir}/migration.sql`, migrationDir), "utf8") : "";
  })();

  it("adds KLORN to the enum and the address table with a tombstone-keeping foreign key", () => {
    expect(sql).toMatch(/ALTER TYPE "InboxProvider" ADD VALUE IF NOT EXISTS 'KLORN'/);
    expect(sql).toMatch(/CREATE TABLE "KlornAddress"/);
    // SetNull, never Cascade: deleting the account must leave the handle behind.
    expect(sql).toMatch(/FOREIGN KEY \("userId"\) REFERENCES "User"\("id"\) ON DELETE SET NULL/);
    expect(sql).not.toMatch(/"KlornAddress"[^;]*ON DELETE CASCADE/);
  });

  it("keeps one address per account and one account per address", () => {
    expect(sql).toMatch(/CONSTRAINT "KlornAddress_pkey" PRIMARY KEY \("handle"\)/);
    expect(sql).toMatch(
      /CREATE UNIQUE INDEX "KlornAddress_userId_key" ON "KlornAddress"\("userId"\)/,
    );
  });

  it("stores only a lowercase handle", () => {
    expect(sql).toMatch(/CHECK \("handle" = lower\("handle"\)\)/);
  });

  it("adds the authentication results column to EmailMessage", () => {
    expect(sql).toMatch(/ALTER TABLE "EmailMessage" ADD COLUMN "authentication" JSONB/);
  });
});
