/**
 * /api/slack connection routes (docs/providers/slack.md §5): dark while
 * SLACK_ENABLED is off (default 404, even unauthenticated), cohort-gated,
 * scoped to the session user (no route can read or change another user's
 * connection), and no response or error ever carries a secret.
 */

import Fastify, { type FastifyInstance } from "fastify";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const auth = vi.hoisted(() => ({ userId: "user-a", authed: true }));
vi.mock("../auth.js", () => ({
  requireAuth: async (
    _request: unknown,
    reply: { code(n: number): { send(b: unknown): void } },
  ) => {
    if (!auth.authed) reply.code(401).send({ error: "Authentication required" });
  },
  getUserId: () => auth.userId,
}));

const store = vi.hoisted(() => {
  const rows = new Map<string, Record<string, unknown>>();
  const status = (userId: string) => {
    const row = rows.get(userId);
    if (!row) return { state: "none" };
    return {
      state: row.credentialsSetAt ? "connected" : "pending",
      requestUrl: `https://api.klorn.ai/api/slack/events/${row.hookId}`,
      teamId: row.teamId ?? null,
      workspaceUrl: row.workspaceUrl ?? null,
      optInChannelIds: row.optInChannelIds ?? [],
      credentialsSetAt: row.credentialsSetAt ?? null,
      lastEventAt: null,
    };
  };
  return {
    rows,
    status,
    getSlackConnectionStatus: vi.fn(async (userId: string) => status(userId)),
    startSlackConnection: vi.fn(async (userId: string) => {
      if (!rows.has(userId)) rows.set(userId, { hookId: `${userId}-hook`.padEnd(32, "0") });
      return status(userId);
    }),
    saveSlackCredentials: vi.fn(async (userId: string, creds: Record<string, unknown>) => {
      const row = rows.get(userId);
      if (!row) return "not-started";
      rows.set(userId, { ...row, ...creds, credentialsSetAt: "2026-11-14T00:00:00.000Z" });
      return "saved";
    }),
    setSlackOptInChannels: vi.fn(async (userId: string, ids: string[]) => {
      const row = rows.get(userId);
      if (!row) return false;
      rows.set(userId, { ...row, optInChannelIds: ids });
      return true;
    }),
    disconnectSlack: vi.fn(async (userId: string) => {
      rows.delete(userId);
    }),
  };
});
vi.mock("../slack/connection-store.js", () => ({
  getSlackConnectionStatus: store.getSlackConnectionStatus,
  startSlackConnection: store.startSlackConnection,
  saveSlackCredentials: store.saveSlackCredentials,
  setSlackOptInChannels: store.setSlackOptInChannels,
  disconnectSlack: store.disconnectSlack,
}));

const slack = vi.hoisted(() => ({ slackAuthTest: vi.fn() }));
vi.mock("../slack/auth-test.js", () => ({ slackAuthTest: slack.slackAuthTest }));

import { slackConnectionRoutes } from "../routes/slack-connection.js";

const SECRET = "8f742231b10e8888abcd99eeeeee85a5";
const TOKEN = "xoxp-1111-2222-3333-abcdef";

let app: FastifyInstance;

const call = (method: "GET" | "POST" | "PUT" | "DELETE", url: string, payload?: unknown) =>
  app.inject({ method, url: `/api/slack${url}`, ...(payload === undefined ? {} : { payload }) });

beforeEach(async () => {
  vi.clearAllMocks();
  store.rows.clear();
  auth.userId = "user-a";
  auth.authed = true;
  process.env.SLACK_ENABLED = "true";
  delete process.env.ROLLOUT_COHORT_USER_IDS;
  slack.slackAuthTest.mockResolvedValue({
    ok: true,
    teamId: "T0001",
    slackUserId: "U0001",
    workspaceUrl: "https://acme.slack.com/",
    scopes: ["im:history"],
  });
  app = Fastify();
  await app.register(slackConnectionRoutes, { prefix: "/api/slack" });
  await app.ready();
});

afterEach(async () => {
  await app.close();
  delete process.env.SLACK_ENABLED;
  delete process.env.ROLLOUT_COHORT_USER_IDS;
});

describe("gating", () => {
  it.each([
    ["GET", "/connection"],
    ["POST", "/connection"],
    ["GET", "/manifest"],
    ["PUT", "/connection/credentials"],
    ["PUT", "/connection/channels"],
    ["DELETE", "/connection"],
  ] as const)("%s %s is the default 404 while off, authenticated or not", async (method, url) => {
    delete process.env.SLACK_ENABLED;
    for (const authed of [true, false]) {
      auth.authed = authed;
      const res = await call(method, url, method === "PUT" ? {} : undefined);
      expect(res.statusCode).toBe(404);
      expect(res.json()).toMatchObject({ error: "Not Found", statusCode: 404 });
    }
    expect(store.getSlackConnectionStatus).not.toHaveBeenCalled();
  });

  it("requires a session when on", async () => {
    auth.authed = false;
    expect((await call("GET", "/connection")).statusCode).toBe(401);
  });

  it("cohort mode answers 404 outside the cohort and 200 inside it", async () => {
    process.env.SLACK_ENABLED = "cohort";
    process.env.ROLLOUT_COHORT_USER_IDS = "user-b";
    expect((await call("GET", "/connection")).statusCode).toBe(404);
    process.env.ROLLOUT_COHORT_USER_IDS = "user-a";
    expect((await call("GET", "/connection")).statusCode).toBe(200);
  });
});

describe("setup flow", () => {
  it("start → manifest → credentials → channels → status, never echoing a secret", async () => {
    expect((await call("GET", "/connection")).json()).toEqual({ state: "none" });
    expect((await call("GET", "/manifest")).statusCode).toBe(409);

    const started = await call("POST", "/connection");
    expect(started.json()).toMatchObject({ state: "pending" });

    const manifest = await call("GET", "/manifest");
    expect(manifest.statusCode).toBe(200);
    expect(manifest.headers["content-type"]).toContain("text/yaml");
    expect(manifest.body).toContain(`request_url: ${started.json().requestUrl}`);

    const connected = await call("PUT", "/connection/credentials", {
      signingSecret: ` ${SECRET} `,
      userToken: TOKEN,
    });
    expect(connected.statusCode).toBe(200);
    expect(connected.json()).toMatchObject({ state: "connected", teamId: "T0001" });
    expect(connected.body).not.toContain(SECRET);
    expect(connected.body).not.toContain(TOKEN);
    expect(slack.slackAuthTest).toHaveBeenCalledWith(TOKEN);
    expect(store.saveSlackCredentials).toHaveBeenCalledWith("user-a", {
      signingSecret: SECRET,
      teamId: "T0001",
      slackUserId: "U0001",
      workspaceUrl: "https://acme.slack.com/",
    });

    const channels = await call("PUT", "/connection/channels", {
      channelIds: ["C0123456789", "C0123456789", "G0123456789"],
    });
    expect(channels.json().optInChannelIds).toEqual(["C0123456789", "G0123456789"]);
    expect((await call("GET", "/connection")).body).not.toContain(SECRET);
  });

  it.each([
    [{ signingSecret: "short", userToken: TOKEN }, "invalid-signing-secret"],
    [{ signingSecret: `${SECRET}!`, userToken: TOKEN }, "invalid-signing-secret"],
    [{ signingSecret: SECRET, userToken: "xoxb-1-2-bot" }, "bot-token"],
    [{ signingSecret: SECRET, userToken: "Bearer nope" }, "invalid-user-token"],
    [{ signingSecret: SECRET, userToken: `xoxp-${"a".repeat(300)}` }, "invalid-user-token"],
    [{}, "invalid-signing-secret"],
  ])("refuses malformed credentials before calling Slack (%j → %s)", async (payload, code) => {
    await call("POST", "/connection");
    const res = await call("PUT", "/connection/credentials", payload);
    expect(res.statusCode).toBe(400);
    expect(res.json().code).toBe(code);
    expect(slack.slackAuthTest).not.toHaveBeenCalled();
    expect(res.body).not.toContain("xoxb-1-2-bot");
  });

  it("relays Slack's refusal and the offending scopes, nothing else", async () => {
    await call("POST", "/connection");
    slack.slackAuthTest.mockResolvedValueOnce({
      ok: false,
      code: "extra-scopes",
      scopes: ["chat:write"],
    });
    const res = await call("PUT", "/connection/credentials", {
      signingSecret: SECRET,
      userToken: TOKEN,
    });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toEqual({
      error: "The token has scopes Klorn must not hold.",
      code: "extra-scopes",
      scopes: ["chat:write"],
    });
    expect(store.saveSlackCredentials).not.toHaveBeenCalled();
  });

  it("refuses to hand out a manifest when the server has no public URL", async () => {
    await call("POST", "/connection");
    store.getSlackConnectionStatus.mockImplementationOnce(async (userId: string) => ({
      ...(store.status(userId) as Record<string, unknown>),
      requestUrl: null,
    }));
    const res = await call("GET", "/manifest");
    expect(res.statusCode).toBe(409);
    expect(res.json().code).toBe("public-url-missing");
  });

  it("credentials before setup started are refused", async () => {
    const res = await call("PUT", "/connection/credentials", {
      signingSecret: SECRET,
      userToken: TOKEN,
    });
    expect(res.statusCode).toBe(409);
  });

  it.each([
    [{ channelIds: ["general"] }],
    [{ channelIds: ["c0123456789"] }],
    [{ channelIds: ["D0123456789"] }],
    [{ channelIds: Array.from({ length: 51 }, (_, i) => `C${String(i).padStart(10, "0")}`) }],
    [{ channelIds: "C0123456789" }],
  ])("refuses an opt-in list that is not channel ids (%#)", async (payload) => {
    await call("POST", "/connection");
    const res = await call("PUT", "/connection/channels", payload);
    expect(res.statusCode).toBe(400);
    expect(res.json().code).toBe("invalid-channels");
  });

  it("disconnect deletes the session user's connection and answers 204", async () => {
    await call("POST", "/connection");
    const res = await call("DELETE", "/connection");
    expect(res.statusCode).toBe(204);
    expect(store.disconnectSlack).toHaveBeenCalledWith("user-a");
    expect((await call("GET", "/connection")).json()).toEqual({ state: "none" });
  });
});

describe("data scope (IDOR)", () => {
  it("every route reads and writes only the session user's row", async () => {
    auth.userId = "user-a";
    await call("POST", "/connection");
    await call("PUT", "/connection/credentials", { signingSecret: SECRET, userToken: TOKEN });

    auth.userId = "user-b";
    expect((await call("GET", "/connection")).json()).toEqual({ state: "none" });
    expect((await call("GET", "/manifest")).statusCode).toBe(409);
    expect(
      (await call("PUT", "/connection/channels", { channelIds: ["C0123456789"] })).statusCode,
    ).toBe(409);
    await call("DELETE", "/connection");

    const calledWith = [
      ...store.getSlackConnectionStatus.mock.calls,
      ...store.setSlackOptInChannels.mock.calls,
      ...store.disconnectSlack.mock.calls,
    ]
      .slice(-4)
      .map((args) => args[0]);
    expect(new Set(calledWith)).toEqual(new Set(["user-b"]));

    auth.userId = "user-a";
    expect((await call("GET", "/connection")).json()).toMatchObject({
      state: "connected",
      teamId: "T0001",
    });
  });

  it("ignores any user id smuggled in the body", async () => {
    await call("POST", "/connection");
    await call("PUT", "/connection/channels", { channelIds: ["C0123456789"], userId: "user-b" });
    expect(store.setSlackOptInChannels).toHaveBeenCalledWith("user-a", ["C0123456789"]);
  });
});
