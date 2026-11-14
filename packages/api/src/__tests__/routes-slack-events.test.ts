/**
 * POST /api/slack/events/:hookId (docs/providers/slack.md §12): dark while
 * SLACK_ENABLED is off, signature verified over the raw bytes before any
 * parsing, stale timestamps / bad signatures / missing headers refused,
 * oversize bodies capped, url_verification answered, kept messages stored
 * once per event_id. Real signing, envelope and filter; the store is faked.
 */

import Fastify, { type FastifyInstance } from "fastify";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { encryptToken } from "../crypto-tokens.js";

const store = vi.hoisted(() => ({
  hooks: new Map<string, Record<string, unknown>>(),
  seenEvents: new Set<string>(),
  findSlackHook: vi.fn(),
  touchSlackHook: vi.fn(async () => {}),
  ingestSlackMessage: vi.fn(),
  markSlackConversationAnswered: vi.fn(async () => 1),
  deleteSlackMessageCopy: vi.fn(async () => 1),
}));
vi.mock("../slack/connection-store.js", () => ({
  findSlackHook: store.findSlackHook,
  touchSlackHook: store.touchSlackHook,
}));
vi.mock("../slack/episodes.js", () => ({
  ingestSlackMessage: store.ingestSlackMessage,
  markSlackConversationAnswered: store.markSlackConversationAnswered,
  deleteSlackMessageCopy: store.deleteSlackMessageCopy,
}));
vi.mock("../sentry.js", () => ({ captureError: vi.fn() }));

import { SLACK_EVENTS_BODY_LIMIT, slackEventsRoutes } from "../routes/slack-events.js";
import { signSlackRequest } from "../slack/signature.js";

const SECRET = "8f742231b10e8888abcd99eeeeee85a5";
const HOOK = "0123456789abcdef0123456789abcdef";
const URL_PATH = `/api/slack/events/${HOOK}`;

let app: FastifyInstance;

const hookRow = (over: Record<string, unknown> = {}) => ({
  id: "conn-1",
  userId: "user-1",
  teamId: "T0001",
  slackUserId: "UME",
  optInChannelIds: [],
  signingSecretCipher: encryptToken(SECRET),
  lastEventAt: null,
  ...over,
});

const dm = (over: Record<string, unknown> = {}, eventId = "Ev0ABCDEF12") =>
  JSON.stringify({
    type: "event_callback",
    team_id: "T0001",
    api_app_id: "A0001",
    event_id: eventId,
    event_time: 1_763_100_000,
    authorizations: [{ team_id: "T0001", user_id: "UME", is_bot: false }],
    event: {
      type: "message",
      channel: "D0DM",
      channel_type: "im",
      user: "UOTHER",
      text: "can you send the contract today?",
      ts: "1763100000.000100",
      ...over,
    },
  });

function signedHeaders(body: string, opts: { secret?: string; ageSeconds?: number } = {}) {
  const ts = String(Math.floor(Date.now() / 1000) - (opts.ageSeconds ?? 0));
  return {
    "content-type": "application/json",
    "x-slack-request-timestamp": ts,
    "x-slack-signature": signSlackRequest(Buffer.from(body), ts, opts.secret ?? SECRET),
  };
}

const post = (body: string, headers: Record<string, string>, url = URL_PATH) =>
  app.inject({ method: "POST", url, payload: body, headers });

beforeEach(async () => {
  vi.clearAllMocks();
  store.hooks.clear();
  store.seenEvents.clear();
  store.hooks.set(HOOK, hookRow());
  store.findSlackHook.mockImplementation(async (id: string) => store.hooks.get(id) ?? null);
  store.ingestSlackMessage.mockImplementation(async (input: { eventId: string }) => {
    if (store.seenEvents.has(input.eventId)) return "duplicate";
    store.seenEvents.add(input.eventId);
    return "stored";
  });
  process.env.SLACK_ENABLED = "true";
  delete process.env.ROLLOUT_COHORT_USER_IDS;
  app = Fastify();
  // Mirrors index.ts: the global JSON parser the Slack plugin must override.
  app.addContentTypeParser("application/json", { parseAs: "string" }, (_req, body, done) => {
    done(null, JSON.parse((body as string) || "{}"));
  });
  await app.register(slackEventsRoutes, { prefix: "/api/slack" });
  await app.ready();
});

afterEach(async () => {
  await app.close();
  delete process.env.SLACK_ENABLED;
  delete process.env.ROLLOUT_COHORT_USER_IDS;
});

describe("gating", () => {
  it("answers Fastify's default 404 while SLACK_ENABLED is off, even to a signed request", async () => {
    delete process.env.SLACK_ENABLED;
    const body = dm();
    const res = await post(body, signedHeaders(body));
    expect(res.statusCode).toBe(404);
    expect(res.json()).toEqual({
      message: `Route POST:${URL_PATH} not found`,
      error: "Not Found",
      statusCode: 404,
    });
    expect(store.findSlackHook).not.toHaveBeenCalled();
  });

  it("has no bare /api/slack/events route", async () => {
    const res = await post("{}", { "content-type": "application/json" }, "/api/slack/events");
    expect(res.statusCode).toBe(404);
  });

  it("an unknown or malformed hook is the same 404; a malformed one never reaches the database", async () => {
    const body = dm();
    const unknown = await post(body, signedHeaders(body), `/api/slack/events/${"f".repeat(32)}`);
    expect(unknown.statusCode).toBe(404);
    store.findSlackHook.mockClear();
    const malformed = await post(body, signedHeaders(body), "/api/slack/events/..%2F..%2Fadmin");
    expect(malformed.statusCode).toBe(404);
    expect(store.findSlackHook).not.toHaveBeenCalled();
  });

  it("in cohort mode only the cohort's hooks answer", async () => {
    process.env.SLACK_ENABLED = "cohort";
    process.env.ROLLOUT_COHORT_USER_IDS = "someone-else";
    const body = dm();
    expect((await post(body, signedHeaders(body))).statusCode).toBe(404);
    process.env.ROLLOUT_COHORT_USER_IDS = "user-1";
    expect((await post(body, signedHeaders(body))).statusCode).toBe(200);
  });

  it("a hook without a signing secret yet answers 401 and stores nothing", async () => {
    store.hooks.set(HOOK, hookRow({ signingSecretCipher: null }));
    const body = dm();
    const res = await post(body, signedHeaders(body));
    expect(res.statusCode).toBe(401);
    expect(store.ingestSlackMessage).not.toHaveBeenCalled();
  });
});

describe("signature verification", () => {
  it("rejects a bad signature", async () => {
    const body = dm();
    const res = await post(
      body,
      signedHeaders(body, { secret: "not-the-secret-not-the-secret-00" }),
    );
    expect(res.statusCode).toBe(401);
    expect(res.json()).toEqual({ error: "Invalid Slack signature" });
    expect(store.ingestSlackMessage).not.toHaveBeenCalled();
    expect(store.touchSlackHook).not.toHaveBeenCalled();
  });

  it("rejects a stale timestamp even when correctly signed", async () => {
    const body = dm();
    const res = await post(body, signedHeaders(body, { ageSeconds: 301 }));
    expect(res.statusCode).toBe(401);
    expect(store.ingestSlackMessage).not.toHaveBeenCalled();
  });

  it.each([
    ["no headers", {}],
    ["no signature", { "x-slack-request-timestamp": String(Math.floor(Date.now() / 1000)) }],
    ["no timestamp", { "x-slack-signature": "v0=00" }],
  ])("rejects a request with %s", async (_label, headers) => {
    const res = await post(dm(), { "content-type": "application/json", ...headers });
    expect(res.statusCode).toBe(401);
    expect(store.ingestSlackMessage).not.toHaveBeenCalled();
  });

  it("verifies before parsing: unparseable JSON with a bad signature is 401, not a parse error", async () => {
    const res = await post("{not json", {
      "content-type": "application/json",
      "x-slack-request-timestamp": String(Math.floor(Date.now() / 1000)),
      "x-slack-signature": "v0=deadbeef",
    });
    expect(res.statusCode).toBe(401);
  });

  it("a signed but unusable body is 400 with X-Slack-No-Retry", async () => {
    const body = "{not json";
    const res = await post(body, signedHeaders(body));
    expect(res.statusCode).toBe(400);
    expect(res.headers["x-slack-no-retry"]).toBe("1");
    expect(res.body).not.toContain("not json");
  });

  it("caps the body: past 256 KiB is 413 and never reaches the lookup", async () => {
    const body = dm({ text: "x".repeat(SLACK_EVENTS_BODY_LIMIT) });
    const res = await post(body, signedHeaders(body));
    expect(res.statusCode).toBe(413);
    expect(store.findSlackHook).not.toHaveBeenCalled();
  });
});

describe("verified events", () => {
  it("answers url_verification with its challenge and marks the hook verified", async () => {
    const body = JSON.stringify({ token: "x", type: "url_verification", challenge: "3eZbrw1aBm2" });
    const res = await post(body, signedHeaders(body));
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ challenge: "3eZbrw1aBm2" });
    expect(store.touchSlackHook).toHaveBeenCalledWith("conn-1");
  });

  it("stores a DM to the user under the hook's own connection and user", async () => {
    const body = dm();
    const res = await post(body, signedHeaders(body));
    expect(res.statusCode).toBe(200);
    expect(store.ingestSlackMessage).toHaveBeenCalledWith({
      connectionId: "conn-1",
      userId: "user-1",
      eventId: "Ev0ABCDEF12",
      channel: "D0DM",
      channelType: "im",
      threadTs: null,
      ts: "1763100000.000100",
      senderId: "UOTHER",
      text: "can you send the contract today?",
      mentionsUser: false,
    });
  });

  it("a replayed event_id (Slack retry or an attacker's replay) is acknowledged once and stored once", async () => {
    const body = dm();
    const first = await post(body, signedHeaders(body));
    const replay = await post(body, { ...signedHeaders(body), "x-slack-retry-num": "1" });
    expect(first.statusCode).toBe(200);
    expect(replay.statusCode).toBe(200);
    expect(store.seenEvents.size).toBe(1);
    const results = await Promise.all(
      store.ingestSlackMessage.mock.results.map((r) => r.value as Promise<string>),
    );
    expect(results).toEqual(["stored", "duplicate"]);
  });

  it("the user's own message closes the open episode instead of being stored", async () => {
    const body = dm({ user: "UME" });
    expect((await post(body, signedHeaders(body))).statusCode).toBe(200);
    expect(store.ingestSlackMessage).not.toHaveBeenCalled();
    expect(store.markSlackConversationAnswered).toHaveBeenCalledWith({
      connectionId: "conn-1",
      channel: "D0DM",
      threadTs: null,
    });
  });

  it("drops another team's event without storing it", async () => {
    const body = dm().replace('"team_id":"T0001","api_app_id"', '"team_id":"T9999","api_app_id"');
    expect((await post(body, signedHeaders(body))).statusCode).toBe(200);
    expect(store.ingestSlackMessage).not.toHaveBeenCalled();
  });

  it("a storage failure is a generic 500 so Slack retries, with no secret or text in it", async () => {
    store.ingestSlackMessage.mockRejectedValueOnce(new Error(`db down ${SECRET}`));
    const body = dm();
    const res = await post(body, signedHeaders(body));
    expect(res.statusCode).toBe(500);
    expect(res.body).not.toContain(SECRET);
    expect(res.body).not.toContain("contract");
  });
});
