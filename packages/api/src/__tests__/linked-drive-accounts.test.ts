/**
 * D5b: drive/linked-drive-accounts.ts, the one module that touches
 * LinkedDriveAccount (drive-file-guard.test.ts). Over the strict, schema-checked
 * fake database, with the real token cipher:
 *   - a link stores both tokens encrypted, the normalised address, and refuses
 *     an empty token (encryptToken("") is "", which the NOT NULL columns would
 *     take as a stored token);
 *   - every read is scoped to (id, userId, provider), and the listing never
 *     carries a token;
 *   - unlinking deletes that account's DriveFile rows (through the writer) and
 *     then the account, in one transaction, and nothing of anyone else's.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import { createFakeDb, type FakeDb, type Row } from "./helpers/fake-db.js";

const dbHolder = vi.hoisted(() => ({ current: null as unknown }));

vi.mock("../db.js", async () => {
  const { fakePrismaClient } = await import("./helpers/fake-db.js");
  const prisma = fakePrismaClient(() => dbHolder.current as FakeDb, { rollbackOnError: true });
  return { prisma, db: prisma, INTERACTIVE_TX_OPTIONS: { maxWait: 10_000, timeout: 15_000 } };
});

import { decryptToken } from "../crypto-tokens.js";
import {
  countDriveAccounts,
  isDriveAccountLinked,
  listDriveAccounts,
  loadDriveAccountCredentials,
  MAX_DRIVE_ACCOUNTS_PER_PROVIDER,
  markDriveAccountForReconnect,
  normaliseDriveAccountEmail,
  saveLinkedDriveAccount,
  saveRefreshedDriveTokens,
  unlinkDriveAccount,
} from "../drive/linked-drive-accounts.js";

const GRANT = {
  accessToken: "ya29.access",
  refreshToken: "1//refresh",
  expiresAt: new Date("2026-10-15T12:00:00.000Z"),
  grantedScopes: "openid https://www.googleapis.com/auth/drive.file",
};

let db: FakeDb;

function account(over: Row = {}): Row {
  return {
    id: "acct-1",
    userId: "user-1",
    provider: "GOOGLE",
    email: "me@example.com",
    accessToken: "cipher-at",
    refreshToken: "cipher-rt",
    grantedScopes: GRANT.grantedScopes,
    createdAt: new Date("2026-10-01T00:00:00.000Z"),
    ...over,
  };
}

function driveFile(id: string, over: Row = {}): Row {
  return {
    id,
    userId: "user-1",
    provider: "GOOGLE",
    sourceKey: "acct-1",
    sourceAccountId: "acct-1",
    externalId: `ext-${id}`,
    name: `${id}.pdf`,
    modifiedAt: new Date("2026-10-02T00:00:00.000Z"),
    ...over,
  };
}

function seed(tables: Record<string, Row[]>): void {
  db = createFakeDb(tables);
  dbHolder.current = db;
}

beforeEach(() => {
  seed({ linkedDriveAccount: [] });
});

describe("normaliseDriveAccountEmail", () => {
  it("trims and lower-cases, as the table's CHECK requires", () => {
    expect(normaliseDriveAccountEmail("  Me@Example.COM ")).toBe("me@example.com");
  });
});

describe("saveLinkedDriveAccount", () => {
  it("stores both tokens encrypted, the scopes, and the normalised address", async () => {
    const result = await saveLinkedDriveAccount("user-1", "GOOGLE", " Me@Example.com", GRANT);
    expect(result.ok).toBe(true);
    const rows = db.tables.linkedDriveAccount ?? [];
    expect(rows).toHaveLength(1);
    const row = rows[0] as Row;
    expect(row).toMatchObject({
      userId: "user-1",
      provider: "GOOGLE",
      email: "me@example.com",
      expiresAt: GRANT.expiresAt,
      grantedScopes: GRANT.grantedScopes,
      needsReconnect: false,
    });
    expect(row.accessToken).not.toBe(GRANT.accessToken);
    expect(row.refreshToken).not.toBe(GRANT.refreshToken);
    expect(decryptToken(row.accessToken as string)).toBe(GRANT.accessToken);
    expect(decryptToken(row.refreshToken as string)).toBe(GRANT.refreshToken);
    if (result.ok) expect(result.id).toBe(row.id);
  });

  it("a re-link updates the same row in place and clears the reconnect flag", async () => {
    seed({ linkedDriveAccount: [account({ needsReconnect: true })] });
    const result = await saveLinkedDriveAccount("user-1", "GOOGLE", "ME@example.com", GRANT);
    expect(result).toEqual({ ok: true, id: "acct-1" });
    const rows = db.tables.linkedDriveAccount ?? [];
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ id: "acct-1", needsReconnect: false });
    expect(decryptToken((rows[0] as Row).refreshToken as string)).toBe(GRANT.refreshToken);
  });

  it.each([
    ["access", { ...GRANT, accessToken: "" }],
    ["refresh", { ...GRANT, refreshToken: "" }],
  ])("refuses an empty %s token and writes nothing", async (_name, grant) => {
    const result = await saveLinkedDriveAccount("user-1", "GOOGLE", "me@example.com", grant);
    expect(result).toEqual({ ok: false, reason: "empty-token" });
    expect(db.writes.linkedDriveAccount).toBeUndefined();
  });

  it.each([
    "",
    "   ",
    "not-an-address",
  ])("refuses the address %j and writes nothing", async (email) => {
    const result = await saveLinkedDriveAccount("user-1", "GOOGLE", email, GRANT);
    expect(result).toEqual({ ok: false, reason: "email" });
    expect(db.writes.linkedDriveAccount).toBeUndefined();
  });
});

describe("the reads are scoped to one user and one provider", () => {
  beforeEach(() => {
    seed({
      linkedDriveAccount: [
        account(),
        account({ id: "acct-2", email: "work@example.com", needsReconnect: true }),
        account({ id: "acct-other", userId: "user-2", email: "me@example.com" }),
        account({ id: "acct-od", provider: "ONEDRIVE", email: "me@outlook.com" }),
      ],
    });
  });

  it("the listing names id, email, needsReconnect and createdAt, never a token", async () => {
    const list = await listDriveAccounts("user-1", "GOOGLE");
    expect(list.map((a) => a.id)).toEqual(["acct-1", "acct-2"]);
    for (const entry of list) {
      expect(Object.keys(entry).sort()).toEqual(["createdAt", "email", "id", "needsReconnect"]);
    }
  });

  it("loads the credentials only by (id, userId, provider)", async () => {
    expect(await loadDriveAccountCredentials("user-1", "GOOGLE", "acct-1")).toMatchObject({
      id: "acct-1",
      email: "me@example.com",
      accessToken: "cipher-at",
      refreshToken: "cipher-rt",
      needsReconnect: false,
    });
    expect(await loadDriveAccountCredentials("user-2", "GOOGLE", "acct-1")).toBeNull();
    expect(await loadDriveAccountCredentials("user-1", "GOOGLE", "acct-other")).toBeNull();
    expect(await loadDriveAccountCredentials("user-1", "GOOGLE", "acct-od")).toBeNull();
    expect(await loadDriveAccountCredentials("user-1", "GOOGLE", "missing")).toBeNull();
  });

  it("counts and finds one provider's accounts of one user", async () => {
    expect(await countDriveAccounts("user-1", "GOOGLE")).toBe(2);
    expect(await countDriveAccounts("user-2", "GOOGLE")).toBe(1);
    expect(await isDriveAccountLinked("user-1", "GOOGLE", "WORK@example.com ")).toBe(true);
    expect(await isDriveAccountLinked("user-1", "GOOGLE", "me@outlook.com")).toBe(false);
    expect(MAX_DRIVE_ACCOUNTS_PER_PROVIDER).toBe(5);
  });

  it("flags only the named account of that user for reconnect", async () => {
    await markDriveAccountForReconnect("user-2", "acct-1");
    expect(db.tables.linkedDriveAccount?.find((r) => r.id === "acct-1")?.needsReconnect).toBe(
      false,
    );
    await markDriveAccountForReconnect("user-1", "acct-1");
    expect(db.tables.linkedDriveAccount?.find((r) => r.id === "acct-1")?.needsReconnect).toBe(true);
    expect(db.tables.linkedDriveAccount?.find((r) => r.id === "acct-other")?.needsReconnect).toBe(
      false,
    );
  });
});

describe("saveRefreshedDriveTokens", () => {
  const LATER = new Date("2026-10-15T13:00:00.000Z");

  it("a rotation writes both tokens encrypted, clears the flag and stamps the refresh", async () => {
    seed({ linkedDriveAccount: [account({ needsReconnect: true, expiresAt: LATER })] });
    const wrote = await saveRefreshedDriveTokens("user-1", "acct-1", {
      accessToken: "new-at",
      refreshToken: "new-rt",
      expiresAt: GRANT.expiresAt,
      onlyIfNewer: false,
    });
    expect(wrote).toBe(true);
    const row = db.tables.linkedDriveAccount?.[0] as Row;
    expect(decryptToken(row.accessToken as string)).toBe("new-at");
    expect(decryptToken(row.refreshToken as string)).toBe("new-rt");
    expect(row.needsReconnect).toBe(false);
    expect(row.lastRefreshedAt).toBeInstanceOf(Date);
  });

  it("an optimistic write loses to a later stored expiry", async () => {
    seed({ linkedDriveAccount: [account({ expiresAt: LATER })] });
    const wrote = await saveRefreshedDriveTokens("user-1", "acct-1", {
      accessToken: "stale-at",
      expiresAt: GRANT.expiresAt,
      onlyIfNewer: true,
    });
    expect(wrote).toBe(false);
    expect(db.tables.linkedDriveAccount?.[0]?.accessToken).toBe("cipher-at");
  });

  it("never writes an empty token, and never another user's row", async () => {
    seed({ linkedDriveAccount: [account()] });
    expect(
      await saveRefreshedDriveTokens("user-1", "acct-1", {
        accessToken: "",
        expiresAt: LATER,
        onlyIfNewer: true,
      }),
    ).toBe(false);
    expect(
      await saveRefreshedDriveTokens("user-2", "acct-1", {
        accessToken: "x",
        expiresAt: LATER,
        onlyIfNewer: true,
      }),
    ).toBe(false);
    expect(db.tables.linkedDriveAccount?.[0]?.accessToken).toBe("cipher-at");
  });

  it("a rotation without an access token keeps the stored one", async () => {
    seed({ linkedDriveAccount: [account()] });
    await saveRefreshedDriveTokens("user-1", "acct-1", {
      accessToken: "",
      refreshToken: "new-rt",
      expiresAt: null,
      onlyIfNewer: false,
    });
    const row = db.tables.linkedDriveAccount?.[0] as Row;
    expect(row.accessToken).toBe("cipher-at");
    expect(decryptToken(row.refreshToken as string)).toBe("new-rt");
  });
});

describe("unlinkDriveAccount", () => {
  beforeEach(() => {
    seed({
      linkedDriveAccount: [
        account(),
        account({ id: "acct-2", email: "work@example.com" }),
        account({ id: "acct-other", userId: "user-2" }),
      ],
      driveFile: [
        driveFile("f1"),
        driveFile("f2"),
        driveFile("f3", { sourceKey: "acct-2", sourceAccountId: "acct-2" }),
        driveFile("f4", {
          userId: "user-2",
          sourceKey: "acct-other",
          sourceAccountId: "acct-other",
        }),
        driveFile("k1", {
          provider: "KLORN",
          sourceKey: "klorn",
          sourceAccountId: null,
          storageKey: "u/k1",
        }),
      ],
    });
  });

  it("deletes that account's rows and then the account, nothing else", async () => {
    expect(await unlinkDriveAccount("user-1", "GOOGLE", "acct-1")).toBe(true);
    expect(db.tables.linkedDriveAccount?.map((r) => r.id)).toEqual(["acct-2", "acct-other"]);
    expect(db.tables.driveFile?.map((r) => r.id)).toEqual(["f3", "f4", "k1"]);
    // The rows went through the writer's one connected delete, keyed by the source.
    expect(db.writes.driveFile).toEqual([
      { op: "deleteMany", where: { userId: "user-1", provider: "GOOGLE", sourceKey: "acct-1" } },
    ]);
  });

  it("another user's account id answers false and deletes nothing", async () => {
    expect(await unlinkDriveAccount("user-1", "GOOGLE", "acct-other")).toBe(false);
    expect(db.tables.linkedDriveAccount).toHaveLength(3);
    expect(db.tables.driveFile).toHaveLength(5);
    expect(db.writes.driveFile).toBeUndefined();
  });

  it("another provider's surface cannot remove the account", async () => {
    expect(await unlinkDriveAccount("user-1", "ONEDRIVE", "acct-1")).toBe(false);
    expect(db.tables.linkedDriveAccount).toHaveLength(3);
    expect(db.tables.driveFile).toHaveLength(5);
  });

  it("a second unlink of the same account answers false", async () => {
    expect(await unlinkDriveAccount("user-1", "GOOGLE", "acct-1")).toBe(true);
    expect(await unlinkDriveAccount("user-1", "GOOGLE", "acct-1")).toBe(false);
  });
});
