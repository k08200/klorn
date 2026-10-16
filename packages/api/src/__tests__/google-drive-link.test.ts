/**
 * D5b: completing a Google Drive link (drive/providers/google-auth.ts), the
 * linked account's OAuth client, and the connector's `connect`
 * (drive/providers/google.ts). Over the strict fake database; Google is never
 * called: the token exchange and the userinfo read are faked.
 *
 * The callback cases, in the plan's order (D5 "Grant"):
 *   - the flag is off: `failed`, and the code is never exchanged;
 *   - `verified_email` is required;
 *   - the returned `scope` must include drive.file, else `scope-missing` and
 *     nothing is stored;
 *   - no refresh token: `failed`;
 *   - entitlement is checked again;
 *   - at most 5 accounts (a re-link is always allowed);
 *   - the address is stored normalised.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createFakeDb, type FakeDb, type Row } from "./helpers/fake-db.js";

const dbHolder = vi.hoisted(() => ({ current: null as unknown }));

type TokensListener = (tokens: Record<string, unknown>) => Promise<void> | void;

const google = vi.hoisted(() => {
  const clients: Array<{
    credentials: Record<string, unknown> | null;
    listeners: TokensListener[];
  }> = [];
  return {
    clients,
    getToken: vi.fn(),
    getGoogleUserInfo: vi.fn(),
    captureError: vi.fn(),
  };
});

vi.mock("../db.js", async () => {
  const { fakePrismaClient } = await import("./helpers/fake-db.js");
  const prisma = fakePrismaClient(() => dbHolder.current as FakeDb);
  return { prisma, db: prisma, INTERACTIVE_TX_OPTIONS: { maxWait: 10_000, timeout: 15_000 } };
});
vi.mock("../mail/gmail.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../mail/gmail.js")>();
  return {
    ...actual,
    getGoogleUserInfo: google.getGoogleUserInfo,
    getOAuth2Client: () => {
      const client = {
        credentials: null as Record<string, unknown> | null,
        listeners: [] as TokensListener[],
        getToken: google.getToken,
        setCredentials(credentials: Record<string, unknown>) {
          client.credentials = credentials;
        },
        on(event: string, listener: TokensListener) {
          if (event === "tokens") client.listeners.push(listener);
        },
      };
      google.clients.push(client);
      return client;
    },
  };
});
vi.mock("../sentry.js", () => ({ captureError: google.captureError }));

const DRIVE_FILE = "https://www.googleapis.com/auth/drive.file";
const GRANTED = `openid https://www.googleapis.com/auth/userinfo.email ${DRIVE_FILE}`;

let db: FakeDb;

function seed(tables: Record<string, Row[]>): void {
  db = createFakeDb({
    user: [{ id: "user-1", email: "owner@example.com", plan: "PRO", role: "USER" }],
    linkedDriveAccount: [],
    ...tables,
  });
  dbHolder.current = db;
}

function driveAccount(over: Row = {}): Row {
  return {
    id: "acct-1",
    userId: "user-1",
    provider: "GOOGLE",
    email: "me@example.com",
    accessToken: "x",
    refreshToken: "y",
    grantedScopes: GRANTED,
    ...over,
  };
}

async function load() {
  vi.resetModules();
  const auth = await import("../drive/providers/google-auth.js");
  const { googleDriveActions } = await import("../drive/providers/google.js");
  const crypto = await import("../crypto-tokens.js");
  return { ...auth, googleDriveActions, crypto };
}

beforeEach(() => {
  vi.clearAllMocks();
  google.clients.length = 0;
  vi.stubEnv("DRIVE_ENABLED", "true");
  vi.stubEnv("GOOGLE_DRIVE_ENABLED", "true");
  vi.stubEnv("PAYWALL_ENABLED", "true");
  seed({});
  google.getToken.mockResolvedValue({
    tokens: {
      access_token: "ya29.access",
      refresh_token: "1//refresh",
      expiry_date: Date.parse("2026-10-15T12:00:00.000Z"),
      scope: GRANTED,
    },
  });
  google.getGoogleUserInfo.mockResolvedValue({
    email: "  Me@Example.COM ",
    verified_email: true,
    name: "Me",
    picture: "",
  });
  vi.spyOn(console, "error").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.resetModules();
});

const accounts = () => db.tables.linkedDriveAccount ?? [];

describe("completeGoogleDriveLink", () => {
  it("stores the account, its encrypted tokens, scopes and normalised address", async () => {
    const { completeGoogleDriveLink, crypto } = await load();
    expect(await completeGoogleDriveLink({ code: "abc", userId: "user-1" })).toBe("success");
    expect(google.getToken).toHaveBeenCalledWith("abc");
    expect(google.getGoogleUserInfo).toHaveBeenCalledWith("ya29.access");
    expect(accounts()).toHaveLength(1);
    const row = accounts()[0] as Row;
    expect(row).toMatchObject({
      userId: "user-1",
      provider: "GOOGLE",
      email: "me@example.com",
      grantedScopes: GRANTED,
      expiresAt: new Date("2026-10-15T12:00:00.000Z"),
    });
    expect(crypto.decryptToken(row.accessToken as string)).toBe("ya29.access");
    expect(crypto.decryptToken(row.refreshToken as string)).toBe("1//refresh");
  });

  it.each([
    ["DRIVE_ENABLED"],
    ["GOOGLE_DRIVE_ENABLED"],
  ])("with %s off: failed, and the code is never exchanged", async (flag) => {
    vi.stubEnv(flag, "false");
    const { completeGoogleDriveLink } = await load();
    expect(await completeGoogleDriveLink({ code: "abc", userId: "user-1" })).toBe("failed");
    expect(google.getToken).not.toHaveBeenCalled();
    expect(google.getGoogleUserInfo).not.toHaveBeenCalled();
    expect(db.writes.linkedDriveAccount).toBeUndefined();
  });

  it("an unverified address: unverified, nothing stored", async () => {
    google.getGoogleUserInfo.mockResolvedValue({ email: "me@example.com", verified_email: false });
    const { completeGoogleDriveLink } = await load();
    expect(await completeGoogleDriveLink({ code: "abc", userId: "user-1" })).toBe("unverified");
    expect(db.writes.linkedDriveAccount).toBeUndefined();
  });

  it.each([
    ["unticked at consent", "openid https://www.googleapis.com/auth/userinfo.email"],
    ["a look-alike", `openid ${DRIVE_FILE}.readonly`],
    ["absent", undefined],
  ])("drive.file %s: scope-missing, nothing stored, no userinfo read", async (_name, scope) => {
    google.getToken.mockResolvedValue({
      tokens: { access_token: "ya29.access", refresh_token: "1//refresh", scope },
    });
    const { completeGoogleDriveLink } = await load();
    expect(await completeGoogleDriveLink({ code: "abc", userId: "user-1" })).toBe("scope-missing");
    expect(google.getGoogleUserInfo).not.toHaveBeenCalled();
    expect(db.writes.linkedDriveAccount).toBeUndefined();
  });

  it("no refresh token: failed, nothing stored", async () => {
    google.getToken.mockResolvedValue({ tokens: { access_token: "ya29.access", scope: GRANTED } });
    const { completeGoogleDriveLink } = await load();
    expect(await completeGoogleDriveLink({ code: "abc", userId: "user-1" })).toBe("failed");
    expect(db.writes.linkedDriveAccount).toBeUndefined();
  });

  it("no access token: failed, nothing stored", async () => {
    google.getToken.mockResolvedValue({ tokens: { refresh_token: "1//r", scope: GRANTED } });
    const { completeGoogleDriveLink } = await load();
    expect(await completeGoogleDriveLink({ code: "abc", userId: "user-1" })).toBe("failed");
    expect(db.writes.linkedDriveAccount).toBeUndefined();
  });

  it("a user who lost the plan during the OAuth window: failed, nothing stored", async () => {
    seed({ user: [{ id: "user-1", email: "owner@example.com", plan: "FREE", role: "USER" }] });
    const { completeGoogleDriveLink } = await load();
    expect(await completeGoogleDriveLink({ code: "abc", userId: "user-1" })).toBe("failed");
    expect(db.writes.linkedDriveAccount).toBeUndefined();
  });

  it("a user who no longer exists: failed", async () => {
    seed({ user: [] });
    const { completeGoogleDriveLink } = await load();
    expect(await completeGoogleDriveLink({ code: "abc", userId: "user-1" })).toBe("failed");
    expect(db.writes.linkedDriveAccount).toBeUndefined();
  });

  it("a sixth account: limit, nothing stored", async () => {
    seed({
      linkedDriveAccount: [1, 2, 3, 4, 5].map((n) =>
        driveAccount({ id: `acct-${n}`, email: `a${n}@example.com` }),
      ),
    });
    const { completeGoogleDriveLink } = await load();
    expect(await completeGoogleDriveLink({ code: "abc", userId: "user-1" })).toBe("limit");
    expect(db.writes.linkedDriveAccount).toBeUndefined();
  });

  it("a re-link at the cap is allowed and updates the row in place", async () => {
    seed({
      linkedDriveAccount: [
        driveAccount({ id: "acct-1", email: "me@example.com", needsReconnect: true }),
        ...[2, 3, 4, 5].map((n) => driveAccount({ id: `acct-${n}`, email: `a${n}@example.com` })),
      ],
    });
    const { completeGoogleDriveLink } = await load();
    expect(await completeGoogleDriveLink({ code: "abc", userId: "user-1" })).toBe("success");
    expect(accounts()).toHaveLength(5);
    expect(accounts().find((r) => r.id === "acct-1")?.needsReconnect).toBe(false);
  });

  it("another user's accounts do not count toward the cap", async () => {
    seed({
      linkedDriveAccount: [1, 2, 3, 4, 5].map((n) =>
        driveAccount({ id: `acct-${n}`, userId: "user-2", email: `a${n}@example.com` }),
      ),
      user: [
        { id: "user-1", email: "owner@example.com", plan: "PRO", role: "USER" },
        { id: "user-2", email: "two@example.com", plan: "PRO", role: "USER" },
      ],
    });
    const { completeGoogleDriveLink } = await load();
    expect(await completeGoogleDriveLink({ code: "abc", userId: "user-1" })).toBe("success");
  });

  it("a failed exchange: failed, reported without the library's message on the wire", async () => {
    google.getToken.mockRejectedValue(new Error("invalid_grant"));
    const { completeGoogleDriveLink } = await load();
    expect(await completeGoogleDriveLink({ code: "abc", userId: "user-1" })).toBe("failed");
    expect(google.captureError).toHaveBeenCalledTimes(1);
    expect(db.writes.linkedDriveAccount).toBeUndefined();
  });

  it("a grant carrying more than asked (a Gmail scope) is stored, warned about and reported, scope names only", async () => {
    const GMAIL = "https://www.googleapis.com/auth/gmail.readonly";
    google.getToken.mockResolvedValue({
      tokens: {
        access_token: "ya29.access",
        refresh_token: "1//refresh",
        scope: `${GRANTED} ${GMAIL}`,
      },
    });
    const { completeGoogleDriveLink } = await load();
    expect(await completeGoogleDriveLink({ code: "abc", userId: "user-1" })).toBe("success");
    expect(accounts()).toHaveLength(1);
    expect(console.warn).toHaveBeenCalledWith(expect.stringContaining(GMAIL));
    expect(google.captureError).toHaveBeenCalledTimes(1);
    const [, context] = google.captureError.mock.calls[0] as [unknown, Record<string, unknown>];
    expect(context).toEqual({
      tags: { scope: "drive.google.extra_scopes" },
      extra: { userId: "user-1", unexpectedScopes: [GMAIL] },
    });
    expect(JSON.stringify(google.captureError.mock.calls)).not.toMatch(/ya29|1\/\/refresh/);
  });

  it("the expected scopes, `email` alias included, report nothing", async () => {
    google.getToken.mockResolvedValue({
      tokens: {
        access_token: "ya29.access",
        refresh_token: "1//r",
        scope: `openid email ${DRIVE_FILE}`,
      },
    });
    const { completeGoogleDriveLink, unexpectedGrantScopes } = await load();
    expect(await completeGoogleDriveLink({ code: "abc", userId: "user-1" })).toBe("success");
    expect(google.captureError).not.toHaveBeenCalled();
    expect(unexpectedGrantScopes(GRANTED)).toEqual([]);
    expect(unexpectedGrantScopes(undefined)).toEqual([]);
  });

  it("lands the client on /files with the outcome, as a relative path", async () => {
    const { driveLinkPath } = await load();
    expect(driveLinkPath("scope-missing")).toBe("/files?drive=scope-missing");
  });
});

describe("buildLinkedDriveClient", () => {
  async function stored(over: Row = {}) {
    const loaded = await load();
    const row = {
      id: "acct-1",
      email: "me@example.com",
      accessToken: loaded.crypto.encryptToken("at-plain"),
      refreshToken: loaded.crypto.encryptToken("rt-plain"),
      expiresAt: new Date("2026-10-15T12:00:00.000Z"),
      needsReconnect: false,
      ...over,
    };
    seed({ linkedDriveAccount: [driveAccount({ ...row })] });
    return { ...loaded, row };
  }

  it("decrypts the pair into a client tagged with the account", async () => {
    const { buildLinkedDriveClient, row } = await stored();
    const linked = buildLinkedDriveClient("user-1", row);
    expect(linked).toMatchObject({ id: "acct-1", email: "me@example.com" });
    expect(google.clients[0]?.credentials).toEqual({
      access_token: "at-plain",
      refresh_token: "rt-plain",
      expiry_date: Date.parse("2026-10-15T12:00:00.000Z"),
    });
  });

  it.each([
    ["an undecryptable token", { accessToken: "v2:nope:bad:bad:bad" }],
    ["an empty refresh token", { refreshToken: "" }],
  ])("%s: null, and the account is flagged for reconnect", async (_name, over) => {
    const { buildLinkedDriveClient, row } = await stored(over);
    expect(buildLinkedDriveClient("user-1", row)).toBeNull();
    await vi.waitFor(() => expect(accounts()[0]?.needsReconnect).toBe(true));
  });

  it("a refreshed token is saved encrypted, scoped to (id, userId)", async () => {
    const { buildLinkedDriveClient, row, crypto } = await stored();
    buildLinkedDriveClient("user-1", row);
    const listener = google.clients[0]?.listeners[0];
    await listener?.({ access_token: "at-2", expiry_date: Date.parse("2026-10-15T13:00:00.000Z") });
    const saved = accounts()[0] as Row;
    expect(crypto.decryptToken(saved.accessToken as string)).toBe("at-2");
    expect(saved.expiresAt).toEqual(new Date("2026-10-15T13:00:00.000Z"));
    const write = db.writes.linkedDriveAccount?.at(-1);
    expect(write?.op).toBe("updateMany");
    expect(write?.where).toMatchObject({ id: "acct-1", userId: "user-1" });
  });

  it("a stale refresh never overwrites a later token", async () => {
    const { buildLinkedDriveClient, row } = await stored();
    buildLinkedDriveClient("user-1", row);
    const before = accounts()[0]?.accessToken;
    await google.clients[0]?.listeners[0]?.({
      access_token: "old",
      expiry_date: Date.parse("2026-10-15T11:00:00.000Z"),
    });
    expect(accounts()[0]?.accessToken).toBe(before);
  });

  it("a rotated refresh token is saved", async () => {
    const { buildLinkedDriveClient, row, crypto } = await stored();
    buildLinkedDriveClient("user-1", row);
    await google.clients[0]?.listeners[0]?.({ access_token: "at-3", refresh_token: "rt-3" });
    expect(crypto.decryptToken(accounts()[0]?.refreshToken as string)).toBe("rt-3");
  });

  it("a refresh that cannot be saved is reported, with no token in it", async () => {
    const { buildLinkedDriveClient, row } = await stored();
    db = createFakeDb(
      { linkedDriveAccount: [driveAccount({ ...row })] },
      {
        beforeUpdateMany: () => {
          throw new Error("database unavailable");
        },
      },
    );
    dbHolder.current = db;
    buildLinkedDriveClient("user-1", row);
    await google.clients[0]?.listeners[0]?.({ access_token: "at-4", refresh_token: "rt-4" });
    expect(google.captureError).toHaveBeenCalledTimes(1);
    const [err, context] = google.captureError.mock.calls[0] as [Error, Record<string, unknown>];
    expect(err.message).toBe("database unavailable");
    expect(context).toEqual({
      tags: { scope: "drive.google.refresh_persist" },
      extra: { userId: "user-1", accountId: "acct-1" },
    });
    expect(JSON.stringify(google.captureError.mock.calls)).not.toMatch(
      /at-4|rt-4|at-plain|rt-plain/,
    );
  });
});

describe("handleDriveGrantFailure", () => {
  it("a revoked grant flags the account and keeps its rows", async () => {
    seed({
      linkedDriveAccount: [driveAccount()],
      driveFile: [
        {
          id: "f1",
          userId: "user-1",
          provider: "GOOGLE",
          sourceKey: "acct-1",
          sourceAccountId: "acct-1",
          externalId: "e1",
          name: "a.pdf",
          modifiedAt: new Date(),
        },
      ],
    });
    const { handleDriveGrantFailure } = await load();
    const err = Object.assign(new Error("invalid_grant"), {
      response: { data: { error: "invalid_grant" } },
    });
    expect(await handleDriveGrantFailure("user-1", "acct-1", err)).toBe(true);
    expect(accounts()[0]?.needsReconnect).toBe(true);
    expect(db.tables.driveFile).toHaveLength(1);
  });

  it("any other failure is not the account's condition: nothing flagged", async () => {
    seed({ linkedDriveAccount: [driveAccount()] });
    const { handleDriveGrantFailure } = await load();
    expect(await handleDriveGrantFailure("user-1", "acct-1", new Error("request expired"))).toBe(
      false,
    );
    expect(accounts()[0]?.needsReconnect).toBe(false);
  });

  it("never flags another user's account", async () => {
    seed({ linkedDriveAccount: [driveAccount()] });
    const { handleDriveGrantFailure } = await load();
    await handleDriveGrantFailure("user-2", "acct-1", { status: 401 });
    expect(accounts()[0]?.needsReconnect).toBe(false);
  });
});

describe("googleDriveActions.connect", () => {
  async function withAccount(over: Row = {}) {
    const loaded = await load();
    seed({
      linkedDriveAccount: [
        driveAccount({
          accessToken: loaded.crypto.encryptToken("at"),
          refreshToken: loaded.crypto.encryptToken("rt"),
          ...over,
        }),
      ],
    });
    return loaded;
  }

  it("answers a GOOGLE session for an owned account that needs no reconnect", async () => {
    const { googleDriveActions } = await withAccount();
    const session = await googleDriveActions.connect({ userId: "user-1", sourceKey: "acct-1" });
    expect(session).not.toBeNull();
    expect(session && "provider" in session ? session.provider : null).toBe("GOOGLE");
  });

  it("answers null for another user's account id", async () => {
    const { googleDriveActions } = await withAccount();
    expect(await googleDriveActions.connect({ userId: "user-2", sourceKey: "acct-1" })).toBeNull();
  });

  it("answers null for an unknown id, and for the Klorn drive's key", async () => {
    const { googleDriveActions } = await withAccount();
    expect(await googleDriveActions.connect({ userId: "user-1", sourceKey: "nope" })).toBeNull();
    expect(await googleDriveActions.connect({ userId: "user-1", sourceKey: "klorn" })).toBeNull();
  });

  it("answers null for an account flagged for reconnect, without decrypting it", async () => {
    const { googleDriveActions } = await withAccount({ needsReconnect: true });
    expect(await googleDriveActions.connect({ userId: "user-1", sourceKey: "acct-1" })).toBeNull();
    expect(google.clients).toHaveLength(0);
  });

  it("answers null for another provider's account", async () => {
    const { googleDriveActions } = await withAccount({ provider: "ONEDRIVE" });
    expect(await googleDriveActions.connect({ userId: "user-1", sourceKey: "acct-1" })).toBeNull();
  });

  it("the session's summary read of an id that is not a Drive id answers null and calls no Google API", async () => {
    // The reads (getMetadata, list, search, fetchForSummary) are pinned in
    // google-drive-files.test.ts, over a mocked googleapis.
    const { googleDriveActions } = await withAccount();
    const session = await googleDriveActions.connect({ userId: "user-1", sourceKey: "acct-1" });
    if (!session || "unsupported" in session) throw new Error("expected a session");
    expect(
      await session.fetchForSummary("file-1", { maxBytes: 10, mimeType: "text/plain" }),
    ).toBeNull();
    expect(google.getToken).not.toHaveBeenCalled();
  });
});
