/**
 * POST /api/mailbox/inbound/resend — what delivery does when something fails,
 * how system mail is noticed, and what reaches an operator (step E1b of
 * docs/providers/unified-platform-plan.md).
 *
 * The rule under test: a 2xx means every copy is stored or deliberately dropped,
 * and no drop that could hide a systemic fault is silent (a rate-limited Sentry
 * event, `klorn-mailbox.<scope>`, with the email id, a status or an error class
 * only). A transient failure answers 503, so Resend retries, until the event is
 * old enough that Resend is about to give up.
 */

import { Prisma } from "@prisma/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  addUser,
  agoIso,
  buildInboundApp,
  captureError,
  content,
  createResend,
  db,
  deliver,
  EMAIL_ID,
  FORWARD_TO,
  HOUR,
  logged,
  MINUTE,
  ok,
  persistGmailEmail,
  receivedEvent,
  reportsFor,
  resendError,
  resendSpies,
  setUpInbound,
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
import { DataWipeFenceError } from "../privacy/data-wipe-fence.js";
import { klornMailboxInboundRoutes } from "../routes/klorn-mailbox-inbound.js";

function buildApp(
  options: { timeoutMs?: number; deadlineMs?: number; noticesPerHour?: number } = {},
) {
  return buildInboundApp(
    klornMailboxInboundRoutes({
      gate: klornMailboxEnabled,
      createResend,
      resendTimeoutMs: options.timeoutMs ?? 2_000,
      deadlineMs: options.deadlineMs,
      noticesPerHour: options.noticesPerHour,
    }),
  );
}

const clientVersion = Prisma.prismaVersion.client;
const known = (code: string) =>
  new Prisma.PrismaClientKnownRequestError("x", { code, clientVersion });
const pgError = (sqlState: string) =>
  new Prisma.PrismaClientUnknownRequestError(
    `Error occurred during query execution:\nConnectorError(ConnectorError { user_facing_error: None, kind: QueryError(PostgresError { code: "${sqlState}", message: "refused", severity: "ERROR" }) })`,
    { clientVersion },
  );

beforeEach(setUpInbound);
afterEach(tearDownInbound);

describe("idempotency", () => {
  it("answers a replay of a stored message without fetching or rewriting it", async () => {
    addUser("jane", "u-jane");
    db.existing.add(`u-jane|klorn:${EMAIL_ID}`);
    const app = await buildApp();
    const res = await deliver(app, receivedEvent());

    expect(res.json()).toMatchObject({ stored: 1, dropped: 0 });
    expect(resendSpies.get).not.toHaveBeenCalled();
    expect(persistGmailEmail).not.toHaveBeenCalled();
  });

  it("counts a concurrent duplicate (P2002) as stored, without a report", async () => {
    addUser("jane", "u-jane");
    persistGmailEmail.mockRejectedValue(known("P2002"));
    const app = await buildApp();
    const res = await deliver(app, receivedEvent());
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ stored: 1 });
    expect(captureError).not.toHaveBeenCalled();
  });
});

describe("store failures", () => {
  it("answers 503 while a recipient's data wipe is running, without a report", async () => {
    addUser("jane", "u-jane");
    persistGmailEmail.mockRejectedValue(new DataWipeFenceError());
    const app = await buildApp();
    const res = await deliver(app, receivedEvent());
    expect(res.statusCode).toBe(503);
    expect(captureError).not.toHaveBeenCalled();
  });

  it.each([
    ["a validation error", () => new Prisma.PrismaClientValidationError("bad", { clientVersion })],
    ["a null constraint (P2011)", () => known("P2011")],
    ["a missing value (P2012)", () => known("P2012")],
    ["an input error (P2019)", () => known("P2019")],
  ])("treats %s as Klorn's bug: 503 and a report", async (_label, error) => {
    addUser("jane", "u-jane");
    persistGmailEmail.mockRejectedValue(error());
    const app = await buildApp();
    const res = await deliver(app, receivedEvent());
    expect(res.statusCode).toBe(503);
    expect(reportsFor("store-bug")).toHaveLength(1);
  });

  it.each([
    ["an invalid byte sequence (22021)", () => pgError("22021")],
    ["an index row too large (54000)", () => pgError("54000")],
    ["a value too long (P2000)", () => known("P2000")],
  ])("drops a copy Postgres refuses for good (%s), and reports it", async (_label, error) => {
    addUser("jane", "u-jane");
    persistGmailEmail.mockRejectedValue(error());
    const app = await buildApp();
    const res = await deliver(app, receivedEvent());
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ stored: 0, dropped: 1 });
    expect(reportsFor("store-refused")).toHaveLength(1);
    expect(reportsFor("store-refused")[0][1].extra).toMatchObject({ emailId: EMAIL_ID });
  });

  it("reports a refused store at most once an hour", async () => {
    addUser("jane", "u-jane");
    persistGmailEmail.mockRejectedValue(pgError("22021"));
    const app = await buildApp();
    await deliver(app, receivedEvent());
    await deliver(app, receivedEvent());
    expect(persistGmailEmail).toHaveBeenCalledTimes(2);
    expect(reportsFor("store-refused")).toHaveLength(1);
  });

  it("answers 503 for an unknown store error and reports its class only", async () => {
    addUser("jane", "u-jane");
    persistGmailEmail.mockRejectedValue(new Error("connection reset for jane@klorn.ai"));
    const app = await buildApp();
    const res = await deliver(app, receivedEvent());
    expect(res.statusCode).toBe(503);
    const [reported, context] = reportsFor("store-unknown")[0];
    expect(String(reported)).not.toContain("@");
    expect(context.extra).toEqual({ emailId: EMAIL_ID, kind: "Error" });
  });

  it("stores the others when one recipient fails, and notices system mail once per key", async () => {
    addUser("jane", "u-jane");
    addUser("sam", "u-sam");
    persistGmailEmail.mockImplementation(async (userId: string) => {
      if (userId === "u-sam") throw new DataWipeFenceError();
      return { emailId: "row", isNew: true };
    });
    const app = await buildApp();
    const event = receivedEvent({ to: ["jane@klorn.ai", "sam@klorn.ai", "postmaster@klorn.ai"] });
    const first = await deliver(app, event);
    expect(first.statusCode).toBe(503);
    expect(first.json()).toMatchObject({ stored: 1, notified: 1 });

    // Resend retries: jane's copy exists now, sam's wipe is over.
    db.existing.add(`u-jane|klorn:${EMAIL_ID}`);
    persistGmailEmail.mockResolvedValue({ emailId: "row", isNew: true });
    const second = await deliver(app, event);
    expect(second.statusCode).toBe(200);
    expect(second.json()).toMatchObject({ stored: 2, notified: 1 });
    expect(persistGmailEmail.mock.calls.map((call) => call[0])).toEqual([
      "u-jane",
      "u-sam",
      "u-sam",
    ]);
    const keys = resendSpies.send.mock.calls.map((call) => call[1].idempotencyKey);
    expect(keys).toEqual([
      `klorn-notice:${EMAIL_ID}:postmaster`,
      `klorn-notice:${EMAIL_ID}:postmaster`,
    ]);
  });
});

describe("Resend failures", () => {
  it.each([
    ["a 5xx", resendError(500, "internal_server_error")],
    ["a 429", resendError(429, "rate_limit_exceeded")],
    ["a 408", resendError(408)],
    ["no status (network)", resendError(null)],
  ])("answers 503 without a report for %s", async (_label, response) => {
    addUser("jane", "u-jane");
    resendSpies.get.mockResolvedValue(response);
    const app = await buildApp();
    const res = await deliver(app, receivedEvent());
    expect(res.statusCode).toBe(503);
    expect(captureError).not.toHaveBeenCalled();
  });

  it.each([
    401, 403,
  ])("answers 503 and reports a key that cannot read received mail (%i)", async (status) => {
    addUser("jane", "u-jane");
    resendSpies.get.mockResolvedValue(resendError(status, "restricted_api_key"));
    const app = await buildApp();
    await deliver(app, receivedEvent());
    const res = await deliver(app, receivedEvent());
    expect(res.statusCode).toBe(503);
    expect(reportsFor("resend-auth")).toHaveLength(1);
    expect(reportsFor("resend-auth")[0][1].extra).toEqual({ status });
  });

  it.each([
    "daily_quota_exceeded",
    "monthly_quota_exceeded",
  ])("answers 503 and reports Resend's %s", async (name) => {
    addUser("jane", "u-jane");
    resendSpies.get.mockResolvedValue(resendError(422, name));
    const app = await buildApp();
    const res = await deliver(app, receivedEvent());
    expect(res.statusCode).toBe(503);
    expect(reportsFor("resend-account")[0][1].extra).toEqual({ status: 422, kind: name });
  });

  it("answers 503 while a young message is not found yet (eventual consistency)", async () => {
    addUser("jane", "u-jane");
    resendSpies.get.mockResolvedValue(resendError(404, "not_found"));
    const app = await buildApp();
    const res = await deliver(app, receivedEvent({ created_at: agoIso(2 * MINUTE) }));
    expect(res.statusCode).toBe(503);
    expect(captureError).not.toHaveBeenCalled();
  });

  it("drops and reports a message Resend still does not have after ten minutes", async () => {
    addUser("jane", "u-jane");
    resendSpies.get.mockResolvedValue(resendError(404, "not_found"));
    const app = await buildApp();
    const res = await deliver(app, receivedEvent({ created_at: agoIso(11 * MINUTE) }));
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ dropped: 1 });
    expect(reportsFor("resend-missing")[0][1].extra).toEqual({ emailId: EMAIL_ID, status: 404 });
  });

  it.each([400, 410, 422])("drops and reports another 4xx (%i) as permanent", async (status) => {
    addUser("jane", "u-jane");
    resendSpies.get.mockResolvedValue(resendError(status, "validation_error"));
    const app = await buildApp();
    const res = await deliver(app, receivedEvent());
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ dropped: 1 });
    expect(reportsFor("resend-refused")).toHaveLength(1);
  });

  it("answers 503 when Resend does not answer in time, without a report", async () => {
    addUser("jane", "u-jane");
    resendSpies.get.mockImplementation(() => new Promise(() => {}));
    const app = await buildApp({ timeoutMs: 20 });
    const res = await deliver(app, receivedEvent());
    expect(res.statusCode).toBe(503);
    expect(persistGmailEmail).not.toHaveBeenCalled();
    expect(captureError).not.toHaveBeenCalled();
  });

  it("answers 503 and reports the error class when the client throws (a bug, not the network)", async () => {
    addUser("jane", "u-jane");
    resendSpies.get.mockRejectedValue(new TypeError("Cannot read properties of undefined"));
    const app = await buildApp();
    const res = await deliver(app, receivedEvent());
    expect(res.statusCode).toBe(503);
    expect(reportsFor("unexpected")[0][1].extra).toEqual({ emailId: EMAIL_ID, kind: "TypeError" });
  });

  it("answers 503 once the request's overall deadline passes", async () => {
    addUser("jane", "u-jane");
    resendSpies.get.mockImplementation(() => new Promise(() => {}));
    const app = await buildApp({ timeoutMs: 10_000, deadlineMs: 50 });
    const started = Date.now();
    const res = await deliver(app, receivedEvent());
    expect(res.statusCode).toBe(503);
    expect(Date.now() - started).toBeLessThan(5_000);
  });

  it("starts no lookup once the request's deadline has passed", async () => {
    addUser("jane", "u-jane");
    const app = await buildApp({ deadlineMs: 0 });
    const res = await deliver(app, receivedEvent());
    expect(res.statusCode).toBe(503);
    expect(db.systemCalls).toHaveLength(0);
    expect(resendSpies.get).not.toHaveBeenCalled();
  });

  it("frees delivery slots held by hung lookups once the deadline passes", async () => {
    addUser("jane", "u-jane");
    db.hangLookups = true;
    const app = await buildApp({ deadlineMs: 50 });
    const hung = await Promise.all(
      ["id-1", "id-2", "id-3", "id-4"].map((id) => deliver(app, receivedEvent({ email_id: id }))),
    );
    expect(hung.map((res) => res.statusCode)).toEqual([503, 503, 503, 503]);

    db.hangLookups = false;
    const res = await deliver(app, receivedEvent({ email_id: "id-5" }));
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ stored: 1 });
  });

  it("gives up on an event older than 26 h instead of answering 503, and reports it", async () => {
    addUser("jane", "u-jane");
    resendSpies.get.mockResolvedValue(resendError(500));
    const app = await buildApp();
    const res = await deliver(app, receivedEvent({ created_at: agoIso(27 * HOUR) }));
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ dropped: 1 });
    expect(reportsFor("give-up")[0][1].extra).toEqual({
      emailId: EMAIL_ID,
      kind: "resend-get-500",
    });
  });
});

describe("oversized address headers", () => {
  it("store the message with no sender and no list, and report once an hour", async () => {
    addUser("jane", "u-jane");
    resendSpies.get.mockResolvedValue(
      ok(
        content({
          headers: { from: `${"x".repeat(300_000)} <jane@klorn.ai>`, to: "y,".repeat(200_000) },
        }),
      ),
    );
    const app = await buildApp();
    const res = await deliver(app, receivedEvent());
    await deliver(app, receivedEvent({ email_id: "id-2" }));

    expect(res.json()).toMatchObject({ stored: 1 });
    const raw = persistGmailEmail.mock.calls[0][1];
    expect(raw.from).toBe("");
    expect(raw.to).toBe("");
    expect(reportsFor("header-oversize")).toHaveLength(1);
    expect(reportsFor("header-oversize")[0][1].extra).toEqual({
      emailId: EMAIL_ID,
      kind: "from,to",
    });
  });
});

describe("a signed event of an unexpected shape", () => {
  it("falls back to the envelope's created_at and reports the schema drift", async () => {
    addUser("jane", "u-jane");
    const envelopeAt = agoIso(3 * MINUTE);
    const app = await buildApp();
    const res = await deliver(
      app,
      receivedEvent({ created_at: "not a date" }, { created_at: envelopeAt }),
    );
    expect(res.json()).toMatchObject({ stored: 1 });
    expect(persistGmailEmail.mock.calls[0][1].receivedAt.toISOString()).toBe(envelopeAt);
    expect(reportsFor("event-schema")).toHaveLength(1);
  });

  it("falls back to now when neither date parses", async () => {
    addUser("jane", "u-jane");
    const app = await buildApp();
    const before = Date.now();
    await deliver(app, receivedEvent({ created_at: undefined }, { created_at: 7 }));
    expect(persistGmailEmail.mock.calls[0][1].receivedAt.getTime()).toBeGreaterThanOrEqual(before);
  });

  it("drops and reports an event whose email_id is not an id, without calling Resend", async () => {
    addUser("jane", "u-jane");
    const app = await buildApp();
    const res = await deliver(app, receivedEvent({ email_id: "../../api-keys" }));
    expect(res.statusCode).toBe(200);
    expect(resendSpies.get).not.toHaveBeenCalled();
    expect(reportsFor("event-schema")).toHaveLength(1);
    expect(JSON.stringify(reportsFor("event-schema")[0])).not.toContain("api-keys");
  });
});

describe("system addresses", () => {
  const notice = (handle: string, emailId = EMAIL_ID) => ({
    from: `${handle}@klorn.ai`,
    to: FORWARD_TO,
    subject: `Mail to ${handle}@klorn.ai — Resend email ${emailId}`,
    text: expect.stringContaining("Receiving"),
    // No auto-reply or vacation answer may come back to the system address.
    headers: {
      "Auto-Submitted": "auto-generated",
      "X-Auto-Response-Suppress": "All",
      Precedence: "bulk",
    },
  });

  it("sends postmaster@ a fixed notice, never the content, and fetches nothing", async () => {
    const app = await buildApp();
    const res = await deliver(
      app,
      receivedEvent({ to: ["POSTMASTER@klorn.ai"], from: "Ops <ops@evil.example>" }),
    );

    expect(res.json()).toMatchObject({ stored: 0, dropped: 0, notified: 1 });
    expect(resendSpies.send).toHaveBeenCalledTimes(1);
    const [payload, requestOptions] = resendSpies.send.mock.calls[0];
    expect(payload).toEqual(notice("postmaster"));
    expect(requestOptions).toEqual({ idempotencyKey: `klorn-notice:${EMAIL_ID}:postmaster` });
    // No sender-controlled field reaches the operator.
    const sent = JSON.stringify(payload);
    expect(sent).not.toContain("Secret merger plans");
    expect(sent).not.toContain("evil.example");
    expect(resendSpies.get).not.toHaveBeenCalled();
    expect(resendSpies.forward).not.toHaveBeenCalled();
    expect(db.systemCalls).toHaveLength(0);
  });

  it("notices abuse@ alongside a user's copy, fetching the content once for the user", async () => {
    addUser("jane", "u-jane");
    const app = await buildApp();
    const res = await deliver(app, receivedEvent({ to: ["abuse@klorn.ai", "jane@klorn.ai"] }));
    expect(res.json()).toMatchObject({ stored: 1, notified: 1 });
    expect(resendSpies.get).toHaveBeenCalledTimes(1);
    expect(resendSpies.send.mock.calls[0][0]).toEqual(notice("abuse"));
    expect(resendSpies.forward).not.toHaveBeenCalled();
  });

  it("sends at most the hourly budget of notices, then drops, counts and reports", async () => {
    const app = await buildApp({ noticesPerHour: 2 });
    const bodies = [];
    for (const id of ["id-1", "id-2", "id-3"]) {
      const res = await deliver(app, receivedEvent({ email_id: id, to: ["postmaster@klorn.ai"] }));
      bodies.push(res.json());
    }
    expect(resendSpies.send).toHaveBeenCalledTimes(2);
    expect(bodies[2]).toMatchObject({ notified: 0, dropped: 1 });
    expect(reportsFor("notice-limit")).toHaveLength(1);
  });

  it("lets Resend's retry of one event reuse its token instead of draining the budget", async () => {
    resendSpies.send.mockResolvedValueOnce(resendError(502));
    const app = await buildApp({ noticesPerHour: 1 });
    const event = receivedEvent({ to: ["postmaster@klorn.ai"] });
    expect((await deliver(app, event)).statusCode).toBe(503);
    expect((await deliver(app, event)).json()).toMatchObject({ notified: 1 });
    const other = await deliver(
      app,
      receivedEvent({ email_id: "id-2", to: ["postmaster@klorn.ai"] }),
    );
    expect(other.json()).toMatchObject({ notified: 0, dropped: 1 });
    expect(resendSpies.send).toHaveBeenCalledTimes(2);
  });

  it("sends one notice at a time across concurrent deliveries", async () => {
    let active = 0;
    let peak = 0;
    resendSpies.send.mockImplementation(async () => {
      active += 1;
      peak = Math.max(peak, active);
      await new Promise((resolve) => setTimeout(resolve, 20));
      active -= 1;
      return ok({ id: "send" });
    });
    const app = await buildApp();
    await Promise.all(
      ["id-1", "id-2", "id-3"].map((id) =>
        deliver(app, receivedEvent({ email_id: id, to: ["postmaster@klorn.ai"] })),
      ),
    );
    expect(resendSpies.send).toHaveBeenCalledTimes(3);
    expect(peak).toBe(1);
  });

  it("answers 503 when the notice fails transiently", async () => {
    resendSpies.send.mockResolvedValue(resendError(502));
    const app = await buildApp();
    const res = await deliver(app, receivedEvent({ to: ["postmaster@klorn.ai"] }));
    expect(res.statusCode).toBe(503);
  });

  it.each([400, 422])("drops and reports a notice Resend refuses (%i)", async (status) => {
    resendSpies.send.mockResolvedValue(resendError(status, "validation_error"));
    const app = await buildApp();
    const res = await deliver(app, receivedEvent({ to: ["abuse@klorn.ai"] }));
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ notified: 0, dropped: 1 });
    expect(reportsFor("resend-refused")).toHaveLength(1);
  });

  it.each([
    ["daily_quota_exceeded", 429],
    ["invalid_from_address", 422],
  ])("answers 503 and reports a notice refused for %s", async (name, status) => {
    resendSpies.send.mockResolvedValue(resendError(status, name));
    const app = await buildApp();
    const res = await deliver(app, receivedEvent({ to: ["abuse@klorn.ai"] }));
    expect(res.statusCode).toBe(503);
    expect(reportsFor("resend-account")).toHaveLength(1);
  });

  it("drops a system address and counts it when no notice target is set", async () => {
    delete process.env.KLORN_MAILBOX_FORWARD_TO;
    const app = await buildApp();
    const res = await deliver(app, receivedEvent({ to: ["postmaster@klorn.ai"] }));
    expect(res.json()).toMatchObject({ notified: 0, dropped: 1 });
    expect(resendSpies.get).not.toHaveBeenCalled();
    expect(resendSpies.send).not.toHaveBeenCalled();
  });
});

describe("events that name nothing at the domain", () => {
  it("are dropped and reported as a domain mismatch, at most once an hour", async () => {
    const app = await buildApp();
    const res = await deliver(app, receivedEvent({ to: ["jane@klorn.example"], cc: [] }));
    await deliver(app, receivedEvent({ to: ["sam@other.example"] }));
    expect(res.json()).toMatchObject({ stored: 0, dropped: 1 });
    expect(reportsFor("domain-mismatch")).toHaveLength(1);
    expect(reportsFor("domain-mismatch")[0][1].extra).toEqual({ emailId: EMAIL_ID });
    expect(db.systemCalls).toHaveLength(0);
  });
});

describe("logs", () => {
  it("carry the email_id and counts, never an address, subject or body", async () => {
    addUser("jane", "u-jane");
    addUser("sam", "u-sam");
    db.addresses.set("gone", null);
    persistGmailEmail.mockImplementation(async (userId: string) => {
      if (userId === "u-sam") throw new Error("boom for sam@klorn.ai: Secret merger plans");
      return { emailId: "row", isNew: true };
    });
    const app = await buildApp();
    await deliver(
      app,
      receivedEvent({
        to: ["jane@klorn.ai", "sam@klorn.ai", "gone@klorn.ai", "postmaster@klorn.ai"],
        cc: ["friend@example.com"],
      }),
    );

    const all = logged.join("\n");
    expect(all).toContain(EMAIL_ID);
    expect(all).not.toContain("@");
    expect(all).not.toMatch(/jane|sam\b|gone|postmaster|friend/i);
    expect(all).not.toContain("Secret merger plans");
    expect(all).not.toContain("Hello Jane");
    const reported = JSON.stringify(captureError.mock.calls.map(([e, c]) => [String(e), c]));
    expect(reported).not.toContain("@");
    expect(reported).not.toContain("Secret merger plans");
  });
});
