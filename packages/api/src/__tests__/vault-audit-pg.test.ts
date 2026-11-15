import { randomUUID } from "node:crypto";
import { afterAll, describe, expect, it, vi } from "vitest";

// Real-Postgres proof of the Klorn Vault export audit (vault/vault-audit.ts and
// migration 20261114120000_data_export_audit): the row holds no content, the
// cooldown reads the latest row per user (so it survives a restart), ignores a
// row that ended in `error`, never sees another user's rows, and a settle can
// only touch the owner's row. Skipped unless KLORN_TEST_PG_URL points at a
// database with every migration applied; DATABASE_URL is set to the same URL
// because setup.ts loads db.ts first.
const url = vi.hoisted(() => {
  const value = process.env.KLORN_TEST_PG_URL;
  if (value) process.env.DATABASE_URL = value;
  return value;
});

vi.mock("../sentry.js", () => ({ captureError: vi.fn() }));

import { prisma } from "../db.js";
import {
  cooldownRemainingMs,
  recordExportEnd,
  recordExportStart,
  VAULT_EXPORT_COOLDOWN_MS,
} from "../vault/vault-audit.js";

const describePg = url ? describe : describe.skip;
const created: string[] = [];

async function newUser(): Promise<string> {
  const user = await prisma.user.create({ data: { email: `vault-${randomUUID()}@test.local` } });
  created.push(user.id);
  return user.id;
}

describePg("vault export audit (Postgres)", () => {
  afterAll(async () => {
    await prisma.user.deleteMany({ where: { id: { in: created } } });
    await prisma.$disconnect();
  });

  it("starts the cooldown, settles without content, and scopes both to the user", async () => {
    const userId = await newUser();
    const other = await newUser();
    expect(await cooldownRemainingMs(userId, new Date())).toBe(0);

    const id = await recordExportStart(userId, true);
    const wait = await cooldownRemainingMs(userId, new Date());
    expect(wait).toBeGreaterThan(VAULT_EXPORT_COOLDOWN_MS - 60_000);
    expect(wait).toBeLessThanOrEqual(VAULT_EXPORT_COOLDOWN_MS);
    expect(await cooldownRemainingMs(other, new Date())).toBe(0);

    // Another user's id cannot settle this row.
    await recordExportEnd(id, other, { outcome: "ok", noteCount: 1, byteCount: 1 });
    expect((await prisma.dataExportAudit.findUniqueOrThrow({ where: { id } })).outcome).toBe(
      "started",
    );
    await recordExportEnd(id, userId, { outcome: "ok", noteCount: 12, byteCount: 3456 });
    const row = await prisma.dataExportAudit.findUniqueOrThrow({ where: { id } });
    expect(row).toMatchObject({
      userId,
      format: "vault-markdown",
      includeBodies: true,
      outcome: "ok",
      noteCount: 12,
      byteCount: 3456,
    });
    expect(row.finishedAt).toBeInstanceOf(Date);
  });

  it("does not hold a server-side failure against the user", async () => {
    const userId = await newUser();
    const id = await recordExportStart(userId, false);
    await recordExportEnd(id, userId, { outcome: "error", noteCount: 0, byteCount: 0 });
    expect(await cooldownRemainingMs(userId, new Date())).toBe(0);
  });

  it("holds an aborted export against the user, so start-then-drop cannot skip the cooldown", async () => {
    const userId = await newUser();
    const id = await recordExportStart(userId, false);
    await recordExportEnd(id, userId, { outcome: "aborted", noteCount: 0, byteCount: 0 });
    expect(await cooldownRemainingMs(userId, new Date())).toBeGreaterThan(0);
  });

  it("is removed with the user", async () => {
    const userId = await newUser();
    await recordExportStart(userId, false);
    await prisma.user.delete({ where: { id: userId } });
    expect(await prisma.dataExportAudit.count({ where: { userId } })).toBe(0);
  });
});
