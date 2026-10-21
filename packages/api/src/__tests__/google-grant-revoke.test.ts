import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const prisma = vi.hoisted(() => ({
  userToken: { findMany: vi.fn(), count: vi.fn(), updateMany: vi.fn() },
  linkedInboxAccount: { findMany: vi.fn(), count: vi.fn() },
  linkedCalendarAccount: { findMany: vi.fn(), count: vi.fn() },
}));
vi.mock("../db.js", () => ({ prisma, db: prisma }));
const drive = vi.hoisted(() => ({
  googleDriveGrantsOf: vi.fn(),
  countGoogleDriveGrantsFor: vi.fn(),
}));
vi.mock("../drive/linked-drive-accounts.js", () => drive);
vi.mock("../crypto-tokens.js", () => ({
  decryptOptional: (value: string | null | undefined) => {
    if (value === "corrupt") throw new Error("bad cipher");
    return value ? value.replace(/^enc:/, "") : null;
  },
}));
const getProfile = vi.hoisted(() => vi.fn());
vi.mock("googleapis", () => ({
  google: { gmail: () => ({ users: { getProfile } }) },
}));
vi.mock("../mail/gmail.js", () => ({
  getOAuth2Client: () => ({ setCredentials: vi.fn() }),
}));
const captureError = vi.hoisted(() => vi.fn());
vi.mock("../sentry.js", () => ({ captureError }));

import { readFileSync } from "node:fs";
import {
  backfillPrimaryGoogleAddresses,
  collectGoogleGrants,
  GOOGLE_REVOKE_URL,
  type HeldGoogleGrant,
  MAX_UNKNOWN_ADDRESSES,
  REVOKE_RETRY_DELAYS_MS,
  rememberPrimaryGoogleAddress,
  removeAndRevokeGoogle,
  revokeGoogleGrants,
  revokeGoogleGrantsInBackground,
} from "../auth/google-grant-revoke.js";
import { runAsNewWork, workStartedAt } from "../work-context.js";

const fetchMock = vi.fn();

function grant(overrides: Partial<HeldGoogleGrant>): HeldGoogleGrant {
  return {
    source: "inbox",
    rowId: "row-1",
    email: "a@x.com",
    refreshToken: "refresh-1",
    accessToken: "access-1",
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  for (const model of [prisma.userToken, prisma.linkedInboxAccount, prisma.linkedCalendarAccount]) {
    model.count.mockResolvedValue(0);
    model.findMany.mockResolvedValue([]);
  }
  prisma.userToken.updateMany.mockResolvedValue({ count: 1 });
  drive.countGoogleDriveGrantsFor.mockResolvedValue(0);
  drive.googleDriveGrantsOf.mockResolvedValue([]);
  fetchMock.mockResolvedValue(new Response(null, { status: 200 }));
  vi.stubGlobal("fetch", fetchMock);
  vi.spyOn(console, "warn").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("revokeGoogleGrants", () => {
  it("revokes a grant no other row holds, sending the refresh token to Google", async () => {
    await expect(revokeGoogleGrants("u1", [grant({})])).resolves.toEqual([
      { source: "inbox", outcome: "revoked" },
    ]);
    const [url, init] = fetchMock.mock.calls[0] ?? [];
    expect(url).toBe(GOOGLE_REVOKE_URL);
    expect((init as RequestInit).method).toBe("POST");
    expect(String((init as RequestInit).body)).toBe("token=refresh-1");
  });

  it("leaves a grant alone when another Klorn account holds the same Google account", async () => {
    prisma.linkedInboxAccount.count.mockResolvedValue(1);
    await expect(revokeGoogleGrants("u1", [grant({})])).resolves.toEqual([
      { source: "inbox", outcome: "shared" },
    ]);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("counts only rows other than those being removed, this user's included", async () => {
    // Unlinking only a Drive account: the user's own primary Gmail grant for
    // the same address stays, so the shared grant must not be revoked.
    prisma.userToken.count.mockResolvedValue(1);
    const removed = [grant({ source: "drive", rowId: "drive-1" })];
    await expect(revokeGoogleGrants("u1", removed)).resolves.toEqual([
      { source: "drive", outcome: "shared" },
    ]);
    expect(drive.countGoogleDriveGrantsFor).toHaveBeenCalledWith("a@x.com", ["drive-1"]);
    // Case-insensitive: older linked rows were not always lowercased, and a
    // wider match only ever means not revoking.
    expect(prisma.linkedInboxAccount.count).toHaveBeenCalledWith({
      where: {
        provider: "GOOGLE",
        email: { equals: "a@x.com", mode: "insensitive" },
        id: { notIn: [] },
      },
    });
  });

  it("reads another primary grant's unknown address and stores it", async () => {
    prisma.userToken.findMany.mockResolvedValue([
      { id: "tok-9", accessToken: "enc:a9", refreshToken: "enc:r9" },
    ]);
    getProfile.mockResolvedValue({ data: { emailAddress: "A@X.com" } });
    await expect(revokeGoogleGrants("u1", [grant({})])).resolves.toEqual([
      { source: "inbox", outcome: "shared" },
    ]);
    // Only onto the tokens it was read with.
    expect(prisma.userToken.updateMany).toHaveBeenCalledWith({
      where: { id: "tok-9", googleEmail: null, accessToken: "enc:a9" },
      data: { googleEmail: "a@x.com", googleEmailCheckedAt: expect.any(Date) },
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("does not revoke when an unknown address could not be read", async () => {
    prisma.userToken.findMany.mockResolvedValue([
      { id: "tok-9", accessToken: "enc:a9", refreshToken: "enc:r9" },
    ]);
    getProfile.mockRejectedValue(new Error("socket hang up"));
    await expect(revokeGoogleGrants("u1", [grant({})])).resolves.toEqual([
      { source: "inbox", outcome: "unknown-account" },
    ]);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("ignores another grant Google already refuses: it cannot be harmed", async () => {
    prisma.userToken.findMany.mockResolvedValue([
      { id: "tok-9", accessToken: "enc:a9", refreshToken: "enc:r9" },
    ]);
    getProfile.mockRejectedValue(
      Object.assign(new Error("invalid_grant"), { response: { status: 400 } }),
    );
    await expect(revokeGoogleGrants("u1", [grant({})])).resolves.toEqual([
      { source: "inbox", outcome: "revoked" },
    ]);
    // Marked, so no later check looks it up again.
    expect(prisma.userToken.updateMany).toHaveBeenCalledWith({
      where: { id: "tok-9", googleEmail: null, accessToken: "enc:a9" },
      data: { googleEmail: "", googleEmailCheckedAt: expect.any(Date) },
    });
  });

  it("gives up on a lookup that hangs, token refresh included, after 15 s", async () => {
    vi.useFakeTimers();
    try {
      prisma.userToken.findMany.mockResolvedValue([
        { id: "tok-9", accessToken: "enc:a9", refreshToken: "enc:r9" },
      ]);
      getProfile.mockImplementation(() => new Promise(() => {}));
      const pending = revokeGoogleGrants("u1", [grant({})]);
      await vi.advanceTimersByTimeAsync(15_000);
      await expect(pending).resolves.toEqual([{ source: "inbox", outcome: "unknown-account" }]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("counts again after the lookups, so a grant linked meanwhile is still seen", async () => {
    prisma.linkedInboxAccount.count.mockResolvedValueOnce(0).mockResolvedValueOnce(1);
    prisma.userToken.findMany.mockResolvedValue([
      { id: "tok-9", accessToken: "enc:a9", refreshToken: "enc:r9" },
    ]);
    getProfile.mockResolvedValue({ data: { emailAddress: "someone@else.com" } });
    await expect(revokeGoogleGrants("u1", [grant({})])).resolves.toEqual([
      { source: "inbox", outcome: "shared" },
    ]);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("does not revoke when there are more unknown addresses than it may check", async () => {
    prisma.userToken.findMany.mockResolvedValue(
      Array.from({ length: MAX_UNKNOWN_ADDRESSES + 1 }, (_, i) => ({
        id: `tok-${i}`,
        accessToken: null,
        refreshToken: null,
      })),
    );
    await expect(revokeGoogleGrants("u1", [grant({})])).resolves.toEqual([
      { source: "inbox", outcome: "unknown-account" },
    ]);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("reads the user's own primary address when the row does not store it", async () => {
    getProfile.mockResolvedValue({ data: { emailAddress: "me@x.com" } });
    await revokeGoogleGrants("u1", [grant({ source: "primary", email: null })]);
    expect(prisma.userToken.count).toHaveBeenCalledWith({
      where: {
        provider: "google",
        googleEmail: { equals: "me@x.com", mode: "insensitive" },
        id: { notIn: ["row-1"] },
      },
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("reports a dead grant as already invalid, with no revoke call", async () => {
    getProfile.mockRejectedValue(
      Object.assign(new Error("Unauthorized"), { response: { status: 401 } }),
    );
    await expect(
      revokeGoogleGrants("u1", [grant({ source: "primary", email: null })]),
    ).resolves.toEqual([{ source: "primary", outcome: "already-invalid" }]);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("reads Google's answers: invalid_token is already invalid, anything else failed", async () => {
    fetchMock
      .mockResolvedValueOnce(Response.json({ error: "invalid_token" }, { status: 400 }))
      .mockResolvedValueOnce(new Response("oops", { status: 503 }));
    const results = await revokeGoogleGrants("u1", [
      grant({ rowId: "a" }),
      grant({ rowId: "b", source: "calendar", refreshToken: "refresh-2" }),
    ]);
    expect(results).toEqual([
      { source: "inbox", outcome: "already-invalid" },
      { source: "calendar", outcome: "failed" },
    ]);
    expect(captureError).toHaveBeenCalledWith(expect.any(Error), {
      tags: { scope: "google.revoke", userId: "u1" },
      extra: { summary: "calendar:failed" },
    });
  });

  it("treats another live row whose cipher will not decrypt as unknown, not dead", async () => {
    prisma.userToken.findMany.mockResolvedValue([
      { id: "tok-9", accessToken: "corrupt", refreshToken: "corrupt" },
    ]);
    await expect(revokeGoogleGrants("u1", [grant({})])).resolves.toEqual([
      { source: "inbox", outcome: "unknown-account" },
    ]);
    expect(getProfile).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("treats a Workspace re-authentication demand as unknown, not dead", async () => {
    prisma.userToken.findMany.mockResolvedValue([
      { id: "tok-9", accessToken: "enc:a9", refreshToken: "enc:r9" },
    ]);
    getProfile.mockRejectedValue(new Error("invalid_grant: invalid_rapt"));
    await expect(revokeGoogleGrants("u1", [grant({})])).resolves.toEqual([
      { source: "inbox", outcome: "unknown-account" },
    ]);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("checks an address once and revokes each of its tokens", async () => {
    const results = await revokeGoogleGrants("u1", [
      grant({ source: "primary", rowId: "p1", refreshToken: "refresh-p" }),
      grant({ source: "calendar", rowId: "c1", refreshToken: "refresh-c" }),
    ]);
    expect(results.map((r) => r.outcome)).toEqual(["revoked", "revoked"]);
    // One address: counted before the lookups and once more after them.
    expect(prisma.linkedInboxAccount.count).toHaveBeenCalledTimes(2);
    expect(fetchMock.mock.calls.map(([, init]) => String((init as RequestInit).body))).toEqual([
      "token=refresh-p",
      "token=refresh-c",
    ]);
  });

  it("never throws, even when the database does", async () => {
    prisma.linkedInboxAccount.count.mockRejectedValue(new Error("pool exhausted"));
    await expect(revokeGoogleGrants("u1", [grant({})])).resolves.toEqual([]);
    expect(captureError).toHaveBeenCalled();
  });
});

describe("revokeGoogleGrantsInBackground (retries)", () => {
  const DELAYS = [1_000, 2_000] as const;

  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  const revokeCalls = () => fetchMock.mock.calls.length;

  it("retries a revoke Google failed, and stops once it went through", async () => {
    fetchMock
      .mockResolvedValueOnce(new Response("oops", { status: 503 }))
      .mockResolvedValue(new Response(null, { status: 200 }));
    revokeGoogleGrantsInBackground("u1", [grant({})], DELAYS);
    await vi.advanceTimersByTimeAsync(0);
    expect(revokeCalls()).toBe(1);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(revokeCalls()).toBe(2);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(revokeCalls()).toBe(2);
    expect(captureError).not.toHaveBeenCalled();
  });

  it("checks the holders again before a retry: a grant linked meanwhile is left alone", async () => {
    fetchMock.mockResolvedValue(new Response("oops", { status: 503 }));
    revokeGoogleGrantsInBackground("u1", [grant({})], DELAYS);
    await vi.advanceTimersByTimeAsync(0);
    expect(revokeCalls()).toBe(1);
    // The same Google account is linked again before the retry.
    prisma.linkedInboxAccount.count.mockResolvedValue(1);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(revokeCalls()).toBe(1);
    expect(captureError).not.toHaveBeenCalled();
  });

  it("gives up after the last delay and reports what is still unrevoked, once", async () => {
    fetchMock.mockResolvedValue(new Response("oops", { status: 503 }));
    revokeGoogleGrantsInBackground("u1", [grant({})], DELAYS);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(revokeCalls()).toBe(DELAYS.length + 1);
    expect(captureError).toHaveBeenCalledTimes(1);
    expect(captureError).toHaveBeenCalledWith(expect.any(Error), {
      tags: { scope: "google.revoke", userId: "u1" },
      extra: { summary: "inbox:failed" },
    });
  });

  it("retries a grant whose account could not be settled", async () => {
    prisma.userToken.findMany.mockResolvedValue([
      { id: "tok-9", accessToken: "enc:a9", refreshToken: "enc:r9" },
    ]);
    getProfile
      .mockRejectedValueOnce(new Error("socket hang up"))
      .mockResolvedValue({ data: { emailAddress: "someone@else.com" } });
    revokeGoogleGrantsInBackground("u1", [grant({})], DELAYS);
    await vi.advanceTimersByTimeAsync(0);
    expect(revokeCalls()).toBe(0);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(revokeCalls()).toBe(1);
  });

  it("retries the grants a pass never reached because the database failed", async () => {
    prisma.linkedInboxAccount.count.mockRejectedValueOnce(new Error("pool exhausted"));
    revokeGoogleGrantsInBackground("u1", [grant({})], DELAYS);
    await vi.advanceTimersByTimeAsync(0);
    expect(revokeCalls()).toBe(0);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(revokeCalls()).toBe(1);
  });

  it("does not retry a grant that is settled: revoked, already invalid or shared", async () => {
    fetchMock.mockResolvedValueOnce(Response.json({ error: "invalid_token" }, { status: 400 }));
    revokeGoogleGrantsInBackground("u1", [grant({})], DELAYS);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(revokeCalls()).toBe(1);
  });

  it("runs a retry as new work, not as part of the request that started it", async () => {
    const startedAt: number[] = [];
    fetchMock.mockImplementation(async () => {
      startedAt.push(workStartedAt().getTime());
      return new Response("oops", { status: 503 });
    });
    runAsNewWork(() => revokeGoogleGrantsInBackground("u1", [grant({})], [1_000]));
    await vi.advanceTimersByTimeAsync(1_000);
    expect(startedAt).toHaveLength(2);
    expect((startedAt[1] ?? 0) - (startedAt[0] ?? 0)).toBe(1_000);
  });

  it("does nothing for no grants", async () => {
    revokeGoogleGrantsInBackground("u1", [], DELAYS);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(revokeCalls()).toBe(0);
    expect(prisma.linkedInboxAccount.count).not.toHaveBeenCalled();
  });

  it("retries for about an hour by default", () => {
    const total = REVOKE_RETRY_DELAYS_MS.reduce((sum, ms) => sum + ms, 0);
    expect(REVOKE_RETRY_DELAYS_MS.length).toBeGreaterThanOrEqual(3);
    expect(total).toBeGreaterThanOrEqual(60 * 60_000);
    expect(total).toBeLessThanOrEqual(2 * 60 * 60_000);
  });
});

describe("collectGoogleGrants", () => {
  it("reads only the selected rows, Google ones only, decrypting the tokens", async () => {
    prisma.linkedInboxAccount.findMany.mockResolvedValue([
      { id: "in-1", email: "A@X.com", accessToken: "enc:a", refreshToken: "corrupt" },
    ]);
    const grants = await collectGoogleGrants("u1", { inboxIds: ["in-1"] });
    expect(prisma.linkedInboxAccount.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { userId: "u1", provider: "GOOGLE", id: { in: ["in-1"] } },
      }),
    );
    expect(prisma.userToken.findMany).not.toHaveBeenCalled();
    expect(grants).toEqual([
      { source: "inbox", rowId: "in-1", email: "a@x.com", accessToken: "a", refreshToken: null },
    ]);
  });

  it("reads every kind of Google grant when nothing is selected", async () => {
    await collectGoogleGrants("u1");
    expect(prisma.userToken.findMany).toHaveBeenCalled();
    expect(prisma.linkedInboxAccount.findMany).toHaveBeenCalled();
    expect(prisma.linkedCalendarAccount.findMany).toHaveBeenCalled();
    expect(drive.googleDriveGrantsOf).toHaveBeenCalledWith("u1", undefined);
  });
});

describe("removeAndRevokeGoogle", () => {
  beforeEach(() => {
    prisma.linkedInboxAccount.findMany.mockResolvedValue([
      { id: "in-1", email: "a@x.com", accessToken: "enc:a", refreshToken: "enc:r" },
    ]);
  });

  it("reads the grants first, removes, then revokes them", async () => {
    const order: string[] = [];
    prisma.linkedInboxAccount.findMany.mockImplementation(async () => {
      order.push("collect");
      return [{ id: "in-1", email: "a@x.com", accessToken: "enc:a", refreshToken: "enc:r" }];
    });
    fetchMock.mockImplementation(async () => {
      order.push("revoke");
      return new Response(null, { status: 200 });
    });
    const result = await removeAndRevokeGoogle(
      "u1",
      { inboxIds: ["in-1"] },
      async () => {
        order.push("remove");
        return { count: 1 };
      },
      (r) => r.count > 0,
    );
    expect(result).toEqual({ count: 1 });
    await vi.waitFor(() => expect(order).toEqual(["collect", "remove", "revoke"]));
  });

  it("revokes nothing when nothing was removed", async () => {
    await removeAndRevokeGoogle(
      "u1",
      { inboxIds: ["in-1"] },
      async () => ({ count: 0 }),
      (r) => r.count > 0,
    );
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("still removes when the grants could not be read", async () => {
    prisma.linkedInboxAccount.findMany.mockRejectedValue(new Error("pool exhausted"));
    const remove = vi.fn(async () => true);
    await expect(
      removeAndRevokeGoogle("u1", { inboxIds: ["in-1"] }, remove, (r) => r),
    ).resolves.toBe(true);
    expect(remove).toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe("every Google disconnect revokes at Google", () => {
  const source = (path: string) => readFileSync(new URL(path, import.meta.url), "utf8");

  it("routes the primary disconnect, the inbox, calendar and drive unlinks through it", () => {
    const auth = source("../routes/auth.ts");
    const primary = auth.slice(auth.indexOf('app.delete("/google",'));
    expect(primary.slice(0, primary.indexOf("\n  });"))).toContain("removeAndRevokeGoogle(");
    const inbox = auth.slice(auth.indexOf('app.delete("/google/linked-inboxes/:id",'));
    expect(inbox.slice(0, inbox.indexOf("\n  });"))).toContain("removeAndRevokeGoogle(");
    expect(source("../pim/linked-calendar-unlink.ts")).toMatch(
      /if \(accountProvider === "GOOGLE"\) \{\s*return removeAndRevokeGoogle\(/,
    );
    expect(source("../routes/google-drive-link.ts")).toContain("removeAndRevokeGoogle(");
  });

  it("forgets the primary grant's address when a reconnect replaces its tokens", () => {
    // A reconnect may bring a different Google account; a stale address would
    // let another user's revoke miss this grant and cut it.
    const finish = source("../routes/google-link-finish.ts");
    const upsert = finish.slice(finish.indexOf("prisma.userToken.upsert({"));
    const update = upsert.slice(upsert.indexOf("update: {"), upsert.indexOf("update: {") + 700);
    expect(update).toContain("googleEmail: null,");
    expect(finish).toMatch(
      /void rememberPrimaryGoogleAddress\(user\.id, tokens, savedToken\.accessToken\);/,
    );
  });
});

describe("the address of a primary grant", () => {
  it("is stored at connect onto that grant's tokens only", async () => {
    getProfile.mockResolvedValue({ data: { emailAddress: "Me@X.com" } });
    await rememberPrimaryGoogleAddress(
      "u1",
      { refresh_token: "r", access_token: "a" },
      "enc:cipher",
    );
    expect(prisma.userToken.updateMany).toHaveBeenCalledWith({
      where: { userId: "u1", provider: "google", googleEmail: null, accessToken: "enc:cipher" },
      data: { googleEmail: "me@x.com" },
    });
  });

  it("is filled in for older grants by the backfill, skipping rows it cannot read", async () => {
    prisma.userToken.findMany.mockResolvedValue([
      { id: "t1", accessToken: "enc:a1", refreshToken: "enc:r1" },
      { id: "t2", accessToken: "corrupt", refreshToken: null },
    ]);
    getProfile.mockResolvedValue({ data: { emailAddress: "one@x.com" } });
    await expect(backfillPrimaryGoogleAddresses()).resolves.toEqual({ filled: 1 });
    expect(getProfile).toHaveBeenCalledTimes(1);
    // The unreadable row is stamped checked, so it moves to the back of the order.
    expect(prisma.userToken.updateMany).toHaveBeenCalledWith({
      where: { id: "t2", googleEmail: null, accessToken: "corrupt" },
      data: { googleEmailCheckedAt: expect.any(Date) },
    });
    expect(prisma.userToken.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        orderBy: [{ googleEmailCheckedAt: { sort: "asc", nulls: "first" } }, { createdAt: "asc" }],
      }),
    );
  });
});

describe("removeAndRevokeGoogle does not hold the caller", () => {
  it("returns once the removal is done, while the revoke is still waiting on Google", async () => {
    prisma.linkedInboxAccount.findMany.mockResolvedValue([
      { id: "in-1", email: "a@x.com", accessToken: "enc:a", refreshToken: "enc:r" },
    ]);
    fetchMock.mockImplementation(() => new Promise(() => {}));
    const result = await removeAndRevokeGoogle(
      "u1",
      { inboxIds: ["in-1"] },
      async () => ({ count: 1 }),
      (r) => r.count > 0,
    );
    expect(result).toEqual({ count: 1 });
  });
});
