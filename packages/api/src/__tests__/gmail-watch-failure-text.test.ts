/**
 * The Gmail watch helpers answer a failed watch/stop call as `{ error, code }`
 * where `error` is a fixed sentence. Their callers log it (the renewal loop,
 * the self-heal) and answer it to the client (POST /api/gmail/watch/enable
 * and /disable send the result as is), so it must never carry the API's
 * message, which can quote the request.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const watch = vi.hoisted(() => vi.fn());
const stop = vi.hoisted(() => vi.fn());

vi.mock("googleapis", () => {
  class OAuth2 {
    setCredentials() {}
    on() {}
  }
  return { google: { auth: { OAuth2 }, gmail: () => ({ users: { watch, stop } }) } };
});
vi.mock("../crypto-tokens.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../crypto-tokens.js")>()),
  decryptToken: (value: string) => value,
  decryptOptional: (value: string | null) => value,
}));
vi.mock("../db.js", () => {
  const token = {
    id: "tok-1",
    userId: "user-1",
    accessToken: "at",
    refreshToken: "rt",
    expiresAt: new Date(Date.now() + 3_600_000),
  };
  const prisma = {
    userToken: { findFirst: vi.fn(async () => token), updateMany: vi.fn(async () => ({})) },
    linkedInboxAccount: {
      findFirst: vi.fn(async () => ({ ...token, id: "li-1", provider: "GOOGLE" })),
      updateMany: vi.fn(async () => ({})),
    },
  };
  return { prisma, db: prisma };
});
vi.mock("../sentry.js", () => ({ captureError: vi.fn() }));

import {
  registerGmailWatch,
  registerLinkedInboxWatch,
  stopGmailWatch,
  stopLinkedInboxWatch,
} from "../mail/gmail.js";

const apiError = (status: number) =>
  Object.assign(new Error("Request failed: CANARY-watch quoted topic"), {
    name: "GaxiosError",
    response: { status, data: { error: { message: "CANARY-watch" } } },
  });

beforeEach(() => {
  vi.clearAllMocks();
  vi.spyOn(console, "error").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});
  vi.stubEnv("GMAIL_PUBSUB_TOPIC", "projects/p/topics/t");
});

describe("Gmail watch failures", () => {
  it("registerGmailWatch answers a code and a fixed sentence", async () => {
    watch.mockRejectedValueOnce(apiError(403));
    const result = await registerGmailWatch("user-1");
    expect(JSON.stringify(result)).not.toContain("CANARY");
    expect(result).toEqual({ error: "Gmail watch failed", code: "PROVIDER_SCOPE_MISSING" });
  });

  it("registerLinkedInboxWatch answers a code and a fixed sentence", async () => {
    watch.mockRejectedValueOnce(apiError(503));
    const result = await registerLinkedInboxWatch("user-1", "li-1");
    expect(JSON.stringify(result)).not.toContain("CANARY");
    expect(result).toEqual({ error: "Linked inbox watch failed", code: "PROVIDER_UNAVAILABLE" });
  });

  it("stopGmailWatch and stopLinkedInboxWatch answer a code and a fixed sentence", async () => {
    stop.mockRejectedValueOnce(apiError(429)).mockRejectedValueOnce(apiError(500));
    const primary = await stopGmailWatch("user-1");
    const linked = await stopLinkedInboxWatch("user-1", "li-1");
    expect(JSON.stringify([primary, linked])).not.toContain("CANARY");
    expect(primary).toEqual({
      ok: false,
      error: "Gmail watch stop failed",
      code: "PROVIDER_RATE_LIMITED",
    });
    expect(linked).toEqual({
      ok: false,
      error: "Linked inbox watch stop failed",
      code: "PROVIDER_UNAVAILABLE",
    });
  });
});
