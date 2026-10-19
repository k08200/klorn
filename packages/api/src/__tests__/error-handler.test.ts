import Fastify from "fastify";
import { describe, expect, it, vi } from "vitest";

vi.mock("../sentry.js", () => ({ captureError: vi.fn() }));

const { handleError } = await import("../error-handler.js");
const { DataWipeFenceError, DATA_WIPE_FENCE_MARKER } = await import(
  "../privacy/data-wipe-fence.js"
);

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
