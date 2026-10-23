/**
 * POST /api/mailbox/inbound/resend — the gate, configuration, verification and
 * routing of the Klorn mailbox's inbound webhook (step E1b of
 * docs/providers/unified-platform-plan.md). Delivery failures, forwarding and
 * the logs are in klorn-mailbox-inbound-delivery.test.ts.
 *
 * Fixture events are signed with a test secret by the Svix scheme and pass
 * through the REAL `resend.webhooks.verify`. Only the network is mocked (the
 * client's receiving.get/.forward and emails.send; `fetch` throws), plus the
 * tenant helpers and the shared store.
 */

import crypto from "node:crypto";
import rateLimit from "@fastify/rate-limit";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  addUser,
  agoIso,
  buildInboundApp,
  captureError,
  content,
  createResend,
  DOMAIN,
  db,
  deliver,
  EMAIL_ID,
  HOUR,
  logged,
  ok,
  persistGmailEmail,
  ROUTE,
  receivedEvent,
  reportsFor,
  resendSpies,
  setUpInbound,
  svixHeaders,
  tearDownInbound,
} from "./helpers/klorn-inbound-harness.js";

vi.mock("../db-tenant.js", async () =>
  (await import("./helpers/klorn-inbound-harness.js")).dbTenantModule(),
);
vi.mock("../judge/email-firewall.js", async () => ({
  persistGmailEmail: (await import("./helpers/klorn-inbound-harness.js")).persistGmailEmail,
}));
vi.mock("../sentry.js", async () => ({
  captureError: (await import("./helpers/klorn-inbound-harness.js")).captureError,
}));

import { klornMailboxEnabled } from "../config.js";
import {
  KLORN_INBOUND_BODY_LIMIT,
  KLORN_INBOUND_RATE_LIMIT,
  klornMailboxInboundRoutes,
} from "../routes/klorn-mailbox-inbound.js";

function buildApp(options: { withRateLimit?: boolean } = {}) {
  const plugins = options.withRateLimit
    ? [
        async (app: import("fastify").FastifyInstance) => {
          await app.register(rateLimit, { max: 100, timeWindow: "1 minute" });
        },
      ]
    : [];
  return buildInboundApp(
    klornMailboxInboundRoutes({ gate: klornMailboxEnabled, createResend, resendTimeoutMs: 2_000 }),
    plugins,
  );
}

beforeEach(setUpInbound);
afterEach(tearDownInbound);

describe("the dark route", () => {
  it("answers Fastify's default 404 while the flag is off, like an unregistered route", async () => {
    process.env.KLORN_MAILBOX_ENABLED = "false";
    const app = await buildApp();
    const body = JSON.stringify(receivedEvent());
    const dark = await app.inject({
      method: "POST",
      url: ROUTE,
      payload: body,
      headers: svixHeaders(body),
    });
    const missing = await app.inject({
      method: "POST",
      url: "/api/mailbox/inbound/other",
      payload: body,
      headers: svixHeaders(body),
    });

    expect(dark.statusCode).toBe(404);
    expect(missing.statusCode).toBe(404);
    expect(dark.json()).toEqual({
      message: `Route POST:${ROUTE} not found`,
      error: "Not Found",
      statusCode: 404,
    });
    expect(missing.json()).toEqual({
      message: "Route POST:/api/mailbox/inbound/other not found",
      error: "Not Found",
      statusCode: 404,
    });
    expect(resendSpies.created).not.toHaveBeenCalled();
  });

  it.each(["", "0", "off", "cohort-typo"])("stays dark for KLORN_MAILBOX_ENABLED=%j", (value) => {
    process.env.KLORN_MAILBOX_ENABLED = value;
    expect(klornMailboxEnabled()).toBe(false);
  });

  it.each([
    "true",
    "1",
    "yes",
    "on",
    " TRUE ",
    "cohort",
    " Cohort ",
  ])("is live for KLORN_MAILBOX_ENABLED=%j", (value) => {
    process.env.KLORN_MAILBOX_ENABLED = value;
    expect(klornMailboxEnabled()).toBe(true);
  });

  it("serves every recipient under `cohort`: the route is not per user (the claim, E3, is)", async () => {
    process.env.KLORN_MAILBOX_ENABLED = "cohort";
    process.env.ROLLOUT_COHORT_USER_IDS = "";
    addUser("jane", "u-jane");
    const app = await buildApp();
    const res = await deliver(app, receivedEvent());

    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ stored: 1 });
  });
});

describe("configuration", () => {
  it.each([
    ["RESEND_INBOUND_WEBHOOK_SECRET", "  "],
    ["RESEND_INBOUND_WEBHOOK_SECRET", "whsec_"],
    ["RESEND_INBOUND_WEBHOOK_SECRET", `whsec_${crypto.randomBytes(8).toString("base64")}`],
    ["RESEND_INBOUND_API_KEY", ""],
    ["KLORN_MAILBOX_DOMAIN", ""],
    ["KLORN_MAILBOX_DOMAIN", "https://klorn.ai"],
  ])("answers 503 and logs an error when %s is %j", async (key, value) => {
    process.env[key] = value;
    const app = await buildApp();
    const res = await deliver(app, receivedEvent());

    expect(res.statusCode).toBe(503);
    expect(logged.some((line) => line.includes(key))).toBe(true);
    // The error names the variable, never a value.
    expect(logged.join("\n")).not.toContain("re_test_inbound_full_access");
    expect(logged.join("\n")).not.toContain("whsec_");
    expect(resendSpies.created).not.toHaveBeenCalled();
    expect(persistGmailEmail).not.toHaveBeenCalled();
  });

  it("refuses forged signatures when the secret is the bare prefix (treated as missing)", async () => {
    process.env.RESEND_INBOUND_WEBHOOK_SECRET = "whsec_";
    const app = await buildApp();
    const body = JSON.stringify(receivedEvent());
    // Signed with an empty key, which a bare `whsec_` would accept.
    const res = await app.inject({
      method: "POST",
      url: ROUTE,
      payload: body,
      headers: svixHeaders(body, Buffer.alloc(0)),
    });
    expect(res.statusCode).toBe(503);
  });

  it("drops system mail and logs an error when the forward target is not a usable address", async () => {
    process.env.KLORN_MAILBOX_FORWARD_TO = "ops@klorn.ai";
    const app = await buildApp();
    const res = await deliver(app, receivedEvent({ to: ["postmaster@klorn.ai"] }));

    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ forwarded: 0, dropped: 1 });
    expect(resendSpies.forward).not.toHaveBeenCalled();
    expect(logged.some((line) => line.includes("KLORN_MAILBOX_FORWARD_TO"))).toBe(true);
  });

  it("sets its own rate limit above the global 100 a minute", async () => {
    expect(KLORN_INBOUND_RATE_LIMIT).toEqual({ max: 600, timeWindow: "1 minute" });
    const app = await buildApp({ withRateLimit: true });
    const statuses = new Set<number>();
    for (let i = 0; i < 120; i++) {
      const res = await app.inject({
        method: "POST",
        url: ROUTE,
        payload: "{}",
        headers: { "content-type": "application/json" },
      });
      statuses.add(res.statusCode);
    }
    expect([...statuses]).toEqual([401]);
  });

  it("refuses a body over its limit: the event is metadata only", async () => {
    expect(KLORN_INBOUND_BODY_LIMIT).toBe(256 * 1024);
    const app = await buildApp();
    const res = await deliver(
      app,
      receivedEvent({ subject: "x".repeat(KLORN_INBOUND_BODY_LIMIT) }),
    );
    expect(res.statusCode).toBe(413);
    expect(resendSpies.created).not.toHaveBeenCalled();
  });
});

describe("verification", () => {
  it("answers 401 for another secret's signature, before any Resend client exists", async () => {
    const app = await buildApp();
    const body = JSON.stringify(receivedEvent());
    const res = await app.inject({
      method: "POST",
      url: ROUTE,
      payload: body,
      headers: svixHeaders(body, crypto.randomBytes(24)),
    });
    expect(res.statusCode).toBe(401);
    expect(resendSpies.created).not.toHaveBeenCalled();
    expect(logged.join("\n")).toContain("reason=bad-signature");
  });

  it("answers 401 when the body was changed after signing", async () => {
    const app = await buildApp();
    const signedBody = JSON.stringify(receivedEvent());
    const res = await app.inject({
      method: "POST",
      url: ROUTE,
      payload: JSON.stringify(receivedEvent({ to: ["victim@klorn.ai"] })),
      headers: svixHeaders(signedBody),
    });
    expect(res.statusCode).toBe(401);
  });

  it("answers 401 without the Svix headers, and says so in the log", async () => {
    const app = await buildApp();
    const res = await app.inject({
      method: "POST",
      url: ROUTE,
      payload: JSON.stringify(receivedEvent()),
      headers: { "content-type": "application/json" },
    });
    expect(res.statusCode).toBe(401);
    expect(logged.join("\n")).toContain("reason=missing-headers");
  });

  it("answers 401 for a correctly signed but stale timestamp", async () => {
    const app = await buildApp();
    const body = JSON.stringify(receivedEvent());
    const stale = Math.floor(Date.now() / 1000) - 10 * 60;
    const res = await app.inject({
      method: "POST",
      url: ROUTE,
      payload: body,
      headers: svixHeaders(body, undefined, stale),
    });
    expect(res.statusCode).toBe(401);
    expect(logged.join("\n")).toContain("reason=stale-timestamp");
  });

  it("logs a rejection reason at most once an hour", async () => {
    const app = await buildApp();
    for (let i = 0; i < 3; i++) {
      const body = JSON.stringify(receivedEvent());
      await app.inject({
        method: "POST",
        url: ROUTE,
        payload: body,
        headers: svixHeaders(body, crypto.randomBytes(24)),
      });
    }
    expect(logged.filter((line) => line.includes("reason=bad-signature"))).toHaveLength(1);
    expect(logged.join("\n")).not.toContain("whsec_");
  });

  it("answers 204 for any other event type, and does nothing", async () => {
    const app = await buildApp();
    const res = await deliver(app, { type: "email.delivered", created_at: "x", data: {} });
    expect(res.statusCode).toBe(204);
    expect(db.systemCalls).toHaveLength(0);
    expect(resendSpies.get).not.toHaveBeenCalled();
  });
});

describe("routing", () => {
  it("stores one copy through the shared store, fetching cid-form HTML once", async () => {
    addUser("jane", "u-jane");
    const app = await buildApp();
    const res = await deliver(app, receivedEvent());

    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ stored: 1, dropped: 0, forwarded: 0 });
    expect(resendSpies.created).toHaveBeenCalledWith("re_test_inbound_full_access");
    expect(resendSpies.get).toHaveBeenCalledTimes(1);
    // Inline images as cid: references, not data: URIs that crowd out the text.
    expect(resendSpies.get).toHaveBeenCalledWith(EMAIL_ID, { html_format: "cid" });
    const [userId, raw, options] = persistGmailEmail.mock.calls[0];
    expect(userId).toBe("u-jane");
    expect(raw).toMatchObject({
      gmailId: `klorn:${EMAIL_ID}`,
      from: "Sam Sender <sender@example.com>",
      subject: "Secret merger plans",
      body: "Hello Jane, here are the plans.",
      labels: ["INBOX", "UNREAD"],
      authentication: { spf: "pass", dkim: "pass", dmarc: "pass" },
    });
    expect(options).toEqual({ userEmail: "jane@klorn.ai", linkedInboxAccountId: "lia-jane" });
  });

  it("looks the handles up once, under withSystem, selecting handle and userId only", async () => {
    addUser("jane", "u-jane");
    addUser("sam", "u-sam");
    const app = await buildApp();
    await deliver(app, receivedEvent({ to: ["jane@klorn.ai"], cc: ["sam@klorn.ai"] }));

    expect(db.systemCalls).toEqual([
      { where: { handle: { in: ["jane", "sam"] } }, select: { handle: true, userId: true } },
    ]);
    expect([...db.tenantCalls].sort()).toEqual(["u-jane", "u-sam"]);
  });

  it("gives two Klorn recipients two copies, mapping and fetching the content once", async () => {
    addUser("jane", "u-jane");
    addUser("sam", "u-sam");
    const app = await buildApp();
    const res = await deliver(
      app,
      receivedEvent({ to: ["jane@klorn.ai"], received_for: ["sam@klorn.ai"] }),
    );

    expect(res.json()).toMatchObject({ stored: 2 });
    expect(resendSpies.get).toHaveBeenCalledTimes(1);
    const users = persistGmailEmail.mock.calls.map((call) => call[0]).sort();
    expect(users).toEqual(["u-jane", "u-sam"]);
    // One row id per user; (userId, gmailId) keeps them apart.
    expect(new Set(persistGmailEmail.mock.calls.map((call) => call[1].gmailId))).toEqual(
      new Set([`klorn:${EMAIL_ID}`]),
    );
    expect(persistGmailEmail.mock.calls[0][1]).toBe(persistGmailEmail.mock.calls[1][1]);
  });

  it("deduplicates one recipient named in several fields and cases", async () => {
    addUser("jane", "u-jane");
    const app = await buildApp();
    await deliver(
      app,
      receivedEvent({
        to: ["JANE@KLORN.AI"],
        cc: ["jane@klorn.ai"],
        received_for: ["Jane@Klorn.ai"],
      }),
    );
    expect(persistGmailEmail).toHaveBeenCalledTimes(1);
  });

  it("drops unknown, tombstoned, reserved, plus-tagged and non-ASCII recipients without fetching", async () => {
    db.addresses.set("gone", null); // a deleted account's handle
    const app = await buildApp();
    const res = await deliver(
      app,
      receivedEvent({
        to: ["nobody@klorn.ai", "gone@klorn.ai", "support@klorn.ai"],
        cc: ["jane+news@klorn.ai", "Kate@klorn.ai", "friend@example.com"],
      }),
    );

    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ stored: 0, dropped: 5, forwarded: 0 });
    expect(resendSpies.get).not.toHaveBeenCalled();
    // The shape decides who is looked up, not the reserved list.
    expect(db.systemCalls[0]).toMatchObject({
      where: { handle: { in: ["nobody", "gone", "support"] } },
    });
  });

  it("still delivers to an existing owner whose handle a later reserved list names", async () => {
    addUser("support", "u-early");
    const app = await buildApp();
    const res = await deliver(app, receivedEvent({ to: ["support@klorn.ai"] }));
    expect(res.json()).toMatchObject({ stored: 1 });
  });

  it("drops and reports a live handle whose user has no KLORN row with exactly that address", async () => {
    // A generic IMAP row may carry any name, including a Klorn address.
    addUser("jane", "u-jane", { provider: "IMAP" });
    addUser("sam", "u-sam", { email: "SAM@klorn.ai" });
    const app = await buildApp();
    const res = await deliver(app, receivedEvent({ to: ["jane@klorn.ai", "sam@klorn.ai"] }));

    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ stored: 0, dropped: 2 });
    expect(resendSpies.get).not.toHaveBeenCalled();
    expect(reportsFor("mailbox-missing")).toHaveLength(1);
    expect(reportsFor("mailbox-missing")[0][1]).toEqual({
      tags: { scope: "klorn-mailbox.mailbox-missing" },
      extra: { emailId: EMAIL_ID },
    });
  });

  it("drops mail received before the recipient's data wipe, and keeps mail after it", async () => {
    addUser("jane", "u-jane");
    addUser("sam", "u-sam");
    db.wipes.set("u-jane", new Date(Date.now() + HOUR)); // after the event
    db.wipes.set("u-sam", new Date(Date.now() - HOUR)); // before the event
    const app = await buildApp();
    const res = await deliver(app, receivedEvent({ to: ["jane@klorn.ai", "sam@klorn.ai"] }));

    expect(res.json()).toMatchObject({ stored: 1, dropped: 1 });
    expect(persistGmailEmail.mock.calls.map((call) => call[0])).toEqual(["u-sam"]);
  });

  it("does not fetch when the only recipient's wipe postdates the event", async () => {
    addUser("jane", "u-jane");
    db.wipes.set("u-jane", new Date(Date.now() + HOUR));
    const app = await buildApp();
    await deliver(app, receivedEvent());
    expect(resendSpies.get).not.toHaveBeenCalled();
  });
});

describe("the self-sent comparison", () => {
  it.each([
    ["DKIM fails", { spf: "pass", dkim: "fail", dmarc: "pass" }],
    ["DMARC fails", { spf: "pass", dkim: "pass", dmarc: "none" }],
    ["no verdicts", undefined],
  ])("gets no user address when %s, so a forged own From is not the user", async (_l, auth) => {
    addUser("jane", "u-jane");
    resendSpies.get.mockResolvedValue(
      ok(content({ authentication: auth, headers: { from: "jane@klorn.ai" } })),
    );
    const app = await buildApp();
    await deliver(app, receivedEvent());
    expect(persistGmailEmail.mock.calls[0][2]).toEqual({
      userEmail: null,
      linkedInboxAccountId: "lia-jane",
    });
  });

  it("gets the Klorn address when DKIM and DMARC both pass", async () => {
    addUser("jane", "u-jane");
    const app = await buildApp();
    await deliver(app, receivedEvent({ created_at: agoIso(0) }));
    expect(persistGmailEmail.mock.calls[0][2]).toMatchObject({ userEmail: `jane@${DOMAIN}` });
    expect(captureError).not.toHaveBeenCalled();
  });
});
