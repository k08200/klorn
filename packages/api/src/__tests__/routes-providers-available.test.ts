/**
 * GET /api/providers/available (productization plan P8, ONBOARDING_V2): the
 * provider grid's source of truth. Pinned here: the route is dark while the
 * flag is off, needs a session when on, lists a provider only while its
 * connector is on, and words `readOnly` the way the action dispatcher behaves.
 */

import Fastify from "fastify";
import { afterEach, describe, expect, it, vi } from "vitest";

// The session check reads the device row; the route itself reads no table.
vi.mock("../db.js", () => {
  const prisma = {
    user: { findUnique: vi.fn(async () => ({ id: "user-1", plan: "FREE", role: "USER" })) },
    device: {
      findUnique: vi.fn(async () => ({ id: "device-1" })),
      update: vi.fn(async () => ({})),
    },
  };
  return { prisma, db: prisma };
});
vi.mock("../sentry.js", () => ({ captureError: vi.fn() }));

import { signToken } from "../auth.js";
import {
  availableProviders,
  type ProviderFacts,
  providersAvailableRoutes,
} from "../routes/providers-available.js";

const ALL_OFF: ProviderFacts = {
  multiInboxSync: false,
  outlookInbox: false,
  outlookConfigured: false,
  outlookCalendar: false,
  icloudInbox: false,
  genericImap: false,
  caldavCalendar: false,
  imapActions: false,
  imapMoveActions: false,
  imapSend: false,
};

const names = (facts: Partial<ProviderFacts>) =>
  availableProviders({ ...ALL_OFF, ...facts }).map((p) => p.provider);

const find = (facts: Partial<ProviderFacts>, provider: string) =>
  availableProviders({ ...ALL_OFF, ...facts }).find((p) => p.provider === provider);

describe("availableProviders", () => {
  it("lists only Google and Naver when every connector flag is off", () => {
    expect(names({})).toEqual(["GOOGLE", "NAVER"]);
  });

  it("lists every provider, in display order, when every connector is on", () => {
    expect(
      names({ outlookInbox: true, outlookConfigured: true, icloudInbox: true, genericImap: true }),
    ).toEqual(["GOOGLE", "OUTLOOK", "NAVER", "ICLOUD", "IMAP"]);
  });

  it("leaves Outlook out while its app registration is missing", () => {
    expect(names({ outlookInbox: true, outlookConfigured: false })).not.toContain("OUTLOOK");
    expect(names({ outlookInbox: false, outlookConfigured: true })).not.toContain("OUTLOOK");
  });

  it("reports Google's calendar always and a second Google account only with multi-inbox sync", () => {
    expect(find({}, "GOOGLE")).toMatchObject({ calendar: true, additionalAccounts: false });
    expect(find({ multiInboxSync: true }, "GOOGLE")?.additionalAccounts).toBe(true);
  });

  it("reports the Outlook calendar only while its flag is on", () => {
    const on = { outlookInbox: true, outlookConfigured: true };
    expect(find(on, "OUTLOOK")?.calendar).toBe(false);
    expect(find({ ...on, outlookCalendar: true }, "OUTLOOK")?.calendar).toBe(true);
  });

  it("reports the CalDAV calendar for Naver and iCloud, never for generic IMAP", () => {
    const facts = { icloudInbox: true, genericImap: true, caldavCalendar: true };
    expect(find(facts, "NAVER")?.calendar).toBe(true);
    expect(find(facts, "ICLOUD")?.calendar).toBe(true);
    expect(find(facts, "IMAP")?.calendar).toBe(false);
  });

  it("calls Naver and iCloud read-only until any IMAP write flag is on", () => {
    const base = { icloudInbox: true };
    expect(find(base, "NAVER")?.readOnly).toBe(true);
    expect(find(base, "ICLOUD")?.readOnly).toBe(true);
    for (const flag of ["imapActions", "imapMoveActions", "imapSend"] as const) {
      expect(find({ ...base, [flag]: true }, "NAVER")?.readOnly).toBe(false);
      expect(find({ ...base, [flag]: true }, "ICLOUD")?.readOnly).toBe(false);
    }
  });

  it("does not count send for generic IMAP, which never sends", () => {
    const base = { genericImap: true };
    expect(find({ ...base, imapSend: true }, "IMAP")?.readOnly).toBe(true);
    expect(find({ ...base, imapActions: true }, "IMAP")?.readOnly).toBe(false);
    expect(find({ ...base, imapMoveActions: true }, "IMAP")?.readOnly).toBe(false);
  });

  it("never calls Google or Outlook read-only", () => {
    const facts = { outlookInbox: true, outlookConfigured: true };
    expect(find(facts, "GOOGLE")?.readOnly).toBe(false);
    expect(find(facts, "OUTLOOK")?.readOnly).toBe(false);
  });
});

describe("GET /api/providers/available", () => {
  const FLAGS = [
    "ONBOARDING_V2",
    "OUTLOOK_INBOX_ENABLED",
    "ICLOUD_INBOX_ENABLED",
    "MS_CLIENT_ID",
    "MS_CLIENT_SECRET",
  ] as const;

  afterEach(() => {
    for (const flag of FLAGS) delete process.env[flag];
  });

  async function buildApp() {
    const app = Fastify();
    await app.register(providersAvailableRoutes, { prefix: "/api/providers" });
    return app;
  }

  const auth = () => ({
    authorization: `Bearer ${signToken({ userId: "user-1", email: "u@example.com" })}`,
  });

  it("answers Fastify's default 404 while ONBOARDING_V2 is off, even with a session", async () => {
    const app = await buildApp();
    const res = await app.inject({
      method: "GET",
      url: "/api/providers/available",
      headers: auth(),
    });
    const unknown = await app.inject({ method: "GET", url: "/api/providers/nope" });
    expect(res.statusCode).toBe(404);
    expect(res.json()).toEqual({
      message: "Route GET:/api/providers/available not found",
      error: "Not Found",
      statusCode: 404,
    });
    expect(Object.keys(res.json())).toEqual(Object.keys(unknown.json()));
    await app.close();
  });

  it("requires a session when the flag is on", async () => {
    process.env.ONBOARDING_V2 = "true";
    const app = await buildApp();
    const res = await app.inject({ method: "GET", url: "/api/providers/available" });
    expect(res.statusCode).toBe(401);
    await app.close();
  });

  it("follows the connector flags at request time and carries no value", async () => {
    process.env.ONBOARDING_V2 = "true";
    const app = await buildApp();
    const read = async () =>
      (
        await app.inject({ method: "GET", url: "/api/providers/available", headers: auth() })
      ).json() as { providers: Array<Record<string, unknown>> };

    expect((await read()).providers.map((p) => p.provider)).toEqual(["GOOGLE", "NAVER"]);

    process.env.OUTLOOK_INBOX_ENABLED = "true";
    process.env.ICLOUD_INBOX_ENABLED = "true";
    process.env.MS_CLIENT_ID = "client-id-value";
    process.env.MS_CLIENT_SECRET = "client-secret-value";
    const body = await read();
    expect(body.providers.map((p) => p.provider)).toEqual(["GOOGLE", "OUTLOOK", "NAVER", "ICLOUD"]);
    for (const provider of body.providers) {
      expect(Object.keys(provider).sort()).toEqual([
        "additionalAccounts",
        "calendar",
        "provider",
        "readOnly",
      ]);
    }
    expect(JSON.stringify(body)).not.toContain("client-");
    await app.close();
  });
});
