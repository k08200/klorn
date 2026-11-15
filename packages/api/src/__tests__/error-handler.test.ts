import Fastify from "fastify";
import { describe, expect, it, vi } from "vitest";

vi.mock("../sentry.js", () => ({ captureError: vi.fn() }));

const { handleError } = await import("../error-handler.js");
const { captureError } = await import("../sentry.js");
const { callText, exhaustedOverQuotingError, LLM_CANARY, NON_JSON_REPLY } = await import(
  "./helpers/canary.js"
);
const { DataWipeFenceError, DATA_WIPE_FENCE_MARKER } = await import(
  "../privacy/data-wipe-fence.js"
);
const {
  DB_CANARY,
  knownErrorQuotingSubject,
  rawQueryErrorQuotingValue,
  validationErrorQuotingText,
} = await import("./helpers/prisma-canary.js");
const { QueryTimeoutError } = await import("../db-statement-timeout.js");

/** A googleapis error as gaxios raises it: the API's words and the request it sent. */
function providerErrorQuotingEvent(): Error {
  return Object.assign(new Error(`Invalid attendee email: ${DB_CANARY}@example.com`), {
    status: 400,
    code: 400,
    config: { data: { summary: `${DB_CANARY} board meeting` } },
    response: {
      status: 400,
      data: { error: { message: `Invalid attendee email: ${DB_CANARY}@example.com` } },
    },
  });
}

/** db-statement-timeout.ts wraps the Prisma error it timed out on as `cause`. */
function timeoutWrappingValidationError(): Error {
  return new QueryTimeoutError({ cause: validationErrorQuotingText() });
}

/** Code that sets a 5xx status on an error whose message it built from content. */
function contentErrorWithStatus(statusCode: number): Error {
  return Object.assign(new Error(`upstream rejected "${DB_CANARY} Re: the subject"`), {
    statusCode,
  });
}

async function buildApp() {
  const app = Fastify();
  app.setErrorHandler(handleError);
  app.get("/boom", async () => {
    // A 5xx carrying internal infrastructure/schema detail that must never leak.
    throw new Error('ENOTFOUND internal-db-host.acme.local: relation "User" does not exist');
  });
  app.get("/client-error", async () => {
    const err = new Error("Name cannot be empty") as Error & { statusCode?: number };
    err.statusCode = 400;
    throw err;
  });
  app.post(
    "/validated",
    {
      schema: { body: { type: "object", required: ["x"], properties: { x: { type: "string" } } } },
    },
    async () => ({ ok: true }),
  );
  return app;
}

describe("handleError — global Fastify error handler", () => {
  it("replaces a 5xx message with a generic one (no internal leak)", async () => {
    const app = await buildApp();
    const res = await app.inject({ method: "GET", url: "/boom" });
    expect(res.statusCode).toBe(500);
    expect(res.json().error).toBe("Internal server error");
    const raw = JSON.stringify(res.json());
    expect(raw).not.toContain("ENOTFOUND");
    expect(raw).not.toContain("internal-db-host");
    expect(raw).not.toContain("relation");
    await app.close();
  });

  it("passes a 4xx (client) error message through unchanged", async () => {
    const app = await buildApp();
    const res = await app.inject({ method: "GET", url: "/client-error" });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe("Name cannot be empty");
    await app.close();
  });

  it("passes schema-validation (400) messages through", async () => {
    const app = await buildApp();
    const res = await app.inject({ method: "POST", url: "/validated", payload: {} });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toMatch(/x/);
    await app.close();
  });
});

describe("handleError — the data-wipe fence", () => {
  async function appThrowing(err: unknown) {
    const app = Fastify();
    app.setErrorHandler(handleError);
    app.get("/write", async () => {
      throw err;
    });
    return app;
  }

  it("answers 409 DATA_WIPE_IN_PROGRESS for the app check's rejection", async () => {
    const app = await appThrowing(new DataWipeFenceError());
    const res = await app.inject({ method: "GET", url: "/write" });
    expect(res.statusCode).toBe(409);
    expect(res.json()).toMatchObject({ code: "DATA_WIPE_IN_PROGRESS" });
    await app.close();
  });

  it("answers the same for the trigger's rejection, never echoing its text", async () => {
    class PrismaClientUnknownRequestError extends Error {}
    const app = await appThrowing(
      new PrismaClientUnknownRequestError(
        `Invalid prisma.note.create(): code: "KW001", message: "${DATA_WIPE_FENCE_MARKER}: insert into Note rejected"`,
      ),
    );
    const res = await app.inject({ method: "GET", url: "/write" });
    expect(res.statusCode).toBe(409);
    expect(res.json().code).toBe("DATA_WIPE_IN_PROGRESS");
    expect(res.body).not.toContain(DATA_WIPE_FENCE_MARKER);
    expect(res.body).not.toContain("Note");
    await app.close();
  });
});

describe("handleError — the daily cost cap", () => {
  async function appThrowing(err: unknown) {
    const app = Fastify();
    app.setErrorHandler(handleError);
    app.post("/llm", async () => {
      throw err;
    });
    return app;
  }

  it("answers 429 with the cap's own message and code — not a 500, not Sentry", async () => {
    const { DailyCostCapExceededError } = await import("../llm/openai.js");
    const { captureError } = await import("../sentry.js");
    vi.mocked(captureError).mockClear();
    const app = await appThrowing(
      new DailyCostCapExceededError("Free quota used for today.", "DAILY_COST_CAP_FREE"),
    );
    const res = await app.inject({ method: "POST", url: "/llm" });
    expect(res.statusCode).toBe(429);
    expect(res.json()).toEqual({
      error: "Free quota used for today.",
      code: "DAILY_COST_CAP_FREE",
    });
    // Expected back-pressure, not a bug: no alert.
    expect(captureError).not.toHaveBeenCalled();
    await app.close();
  });

  it("maps a name-only cap error (a test double of llm/openai.js) to DAILY_COST_CAP", async () => {
    const err = Object.assign(new Error("Quota used for today."), {
      name: "DailyCostCapExceededError",
    });
    const app = await appThrowing(err);
    const res = await app.inject({ method: "POST", url: "/llm" });
    expect(res.statusCode).toBe(429);
    expect(res.json()).toEqual({ error: "Quota used for today.", code: "DAILY_COST_CAP" });
    await app.close();
  });
});

/**
 * An LLM failure no route caught: pino and Sentry both print the message and
 * the cause chain, and a provider's message can quote the request's mail.
 */
describe("handleError — an uncaught LLM failure", () => {
  async function buildLoggedApp() {
    const lines: string[] = [];
    const app = Fastify({
      logger: { level: "error", stream: { write: (l: string) => lines.push(l) } },
    });
    app.setErrorHandler(handleError);
    app.get("/exhausted", async () => {
      throw exhaustedOverQuotingError();
    });
    app.get("/reply-parse", async () => JSON.parse(NON_JSON_REPLY));
    app.get("/boom", async () => {
      throw new Error('ENOTFOUND internal-db-host.acme.local: relation "User" does not exist');
    });
    return { app, lines };
  }

  it.each([
    "/exhausted",
    "/reply-parse",
  ])("%s: same 500, and the log and Sentry get facts only", async (url) => {
    vi.mocked(captureError).mockClear();
    const { app, lines } = await buildLoggedApp();

    const res = await app.inject({ method: "GET", url });

    expect(res.statusCode).toBe(500);
    expect(res.json()).toEqual({ error: "Internal server error" });
    expect(captureError).toHaveBeenCalledWith(
      expect.any(Error),
      expect.objectContaining({
        tags: { scope: "fastify.errorHandler" },
        extra: expect.objectContaining({ method: "GET", route: url }),
      }),
    );
    expect(lines.join("\n")).toContain("LLM failure reached the error handler");
    expect(lines.join("\n") + callText(vi.mocked(captureError))).not.toContain(LLM_CANARY);
    await app.close();
  });

  it("reports any other 5xx as facts too, never its message", async () => {
    vi.mocked(captureError).mockClear();
    const { app, lines } = await buildLoggedApp();

    await app.inject({ method: "GET", url: "/boom" });

    expect(lines.join("\n")).not.toContain("internal-db-host");
    expect(callText(vi.mocked(captureError))).not.toContain("internal-db-host");
    expect((vi.mocked(captureError).mock.calls[0]?.[0] as Error).message).toBe(
      "Unhandled failure in a route (Error)",
    );
    await app.close();
  });
});

/**
 * Every route that rethrows lands here: a Prisma error over the row being
 * written (a validation error renders the whole call, values included, even in
 * production's "minimal" format), a provider error carrying the event it sent,
 * a statement timeout wrapping the Prisma error as `cause`. pino's err
 * serializer prints the message and the cause chain, Sentry sends both, so the
 * handler reports facts only. The response stays the same generic 500.
 */
describe("handleError — a 5xx whose words could quote content", () => {
  async function appThrowing(err: unknown) {
    const lines: string[] = [];
    const app = Fastify({
      logger: { level: "info", stream: { write: (l: string) => lines.push(l) } },
    });
    app.setErrorHandler(handleError);
    app.post("/rows/:id", async () => {
      throw err;
    });
    return { app, lines };
  }

  const consoleText = (spies: Array<{ mock: { calls: unknown[][] } }>) =>
    spies.map((spy) => callText(spy)).join("\n");

  it.each([
    ["a Prisma validation error (renders the call's values)", validationErrorQuotingText],
    ["a Prisma unique violation quoting a subject", knownErrorQuotingSubject],
    ["a raw-query failure quoting the bad value", rawQueryErrorQuotingValue],
    ["a provider error carrying the event it sent", providerErrorQuotingEvent],
    ["a statement timeout wrapping a Prisma error as cause", timeoutWrappingValidationError],
    ["a 503 the code set over content", () => contentErrorWithStatus(503)],
  ])("%s: same 500/5xx body; pino, the console and Sentry never see the canary", async (_label, make) => {
    vi.mocked(captureError).mockClear();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    const thrown = make();
    const { app, lines } = await appThrowing(thrown);

    const res = await app.inject({
      method: "POST",
      url: "/rows/r-1",
      payload: { text: "the body is never logged" },
    });

    const expectedStatus = (thrown as { statusCode?: number }).statusCode ?? 500;
    expect(res.statusCode).toBe(expectedStatus);
    expect(res.json()).toEqual({ error: "Internal server error" });
    expect(captureError).toHaveBeenCalledTimes(1);
    expect(captureError).toHaveBeenCalledWith(
      expect.any(Error),
      expect.objectContaining({
        tags: { scope: "fastify.errorHandler" },
        extra: expect.objectContaining({ method: "POST", route: "/rows/:id" }),
      }),
    );
    expect(lines.join("\n")).toContain("Unhandled failure reached the error handler");
    const everything =
      lines.join("\n") + callText(vi.mocked(captureError)) + consoleText([warn, error, log]);
    expect(everything).not.toContain(DB_CANARY);
    expect(everything).not.toContain("the body is never logged");
    warn.mockRestore();
    error.mockRestore();
    log.mockRestore();
    await app.close();
  });

  it("keeps what an operator needs: class, Prisma code, model, operation, status, size", async () => {
    vi.mocked(captureError).mockClear();
    const { app, lines } = await appThrowing(knownErrorQuotingSubject());

    await app.inject({ method: "POST", url: "/rows/r-1" });

    const [reported, context] = vi.mocked(captureError).mock.calls[0] ?? [];
    expect((reported as Error).message).toBe(
      "Unhandled failure in a route (PrismaClientKnownRequestError)",
    );
    expect((context as { extra: Record<string, unknown> }).extra).toMatchObject({
      errorName: "PrismaClientKnownRequestError",
      code: "P2002",
      model: "Notification",
      operation: "create",
    });
    const line = JSON.parse(lines.find((l) => l.includes("error handler")) ?? "{}");
    expect(line.failure).toMatchObject({
      errorName: "PrismaClientKnownRequestError",
      code: "P2002",
      model: "Notification",
    });
    expect(line.err).toBeUndefined();
    await app.close();
  });

  it("still answers a 4xx with its own message and reports nothing", async () => {
    vi.mocked(captureError).mockClear();
    const { app } = await appThrowing(
      Object.assign(new Error("Title is too long"), { statusCode: 413 }),
    );

    const res = await app.inject({ method: "POST", url: "/rows/r-1" });

    expect(res.statusCode).toBe(413);
    expect(res.json()).toEqual({ error: "Title is too long" });
    expect(captureError).not.toHaveBeenCalled();
    await app.close();
  });
});
