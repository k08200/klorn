import Fastify from "fastify";
import { beforeEach, describe, expect, it, vi } from "vitest";

// Stub mail senders — the route fires both non-blocking and swallows errors,
// but we want to assert who gets mailed on which path.
const sendWaitlistAdminAlertSpy = vi.fn(async () => true);
const sendWaitlistConfirmationEmailSpy = vi.fn(async () => true);
vi.mock("../mail/email.js", () => ({
  sendWaitlistAdminAlert: (...args: unknown[]) => sendWaitlistAdminAlertSpy(...args),
  sendWaitlistConfirmationEmail: (...args: unknown[]) => sendWaitlistConfirmationEmailSpy(...args),
}));

// In-memory waitlist store.
type StoredWaitlist = {
  id: string;
  email: string;
  name?: string | null;
  useCase?: string | null;
  status: string;
};
const waitlistByEmail = new Map<string, StoredWaitlist>();
let nextId = 1;

vi.mock("../db.js", () => {
  const prisma = {
    waitlist: {
      findUnique: vi.fn(async ({ where }: { where: { email?: string } }) => {
        if (!where.email) return null;
        return waitlistByEmail.get(where.email) ?? null;
      }),
      create: vi.fn(
        async ({ data }: { data: { email: string; name?: string; useCase?: string } }) => {
          const entry: StoredWaitlist = {
            id: `wl-${nextId++}`,
            email: data.email,
            name: data.name ?? null,
            useCase: data.useCase ?? null,
            status: "PENDING",
          };
          waitlistByEmail.set(data.email, entry);
          return entry;
        },
      ),
      update: vi.fn(
        async ({
          where,
          data,
        }: {
          where: { email: string };
          data: { name?: string; useCase?: string };
        }) => {
          const existing = waitlistByEmail.get(where.email);
          if (!existing) throw new Error("Not found");
          const updated = { ...existing, ...data };
          waitlistByEmail.set(where.email, updated);
          return updated;
        },
      ),
    },
  };
  return { prisma, db: prisma };
});

async function buildApp() {
  const { waitlistRoutes } = await import("../routes/waitlist.js");
  const app = Fastify();
  await app.register(waitlistRoutes, { prefix: "/api/waitlist" });
  return app;
}

/** Let fire-and-forget promises (and their .catch handlers) settle. */
async function flushAsync() {
  await new Promise((resolve) => setImmediate(resolve));
}

beforeEach(() => {
  waitlistByEmail.clear();
  nextId = 1;
  sendWaitlistAdminAlertSpy.mockClear();
  sendWaitlistAdminAlertSpy.mockResolvedValue(true);
  sendWaitlistConfirmationEmailSpy.mockClear();
  sendWaitlistConfirmationEmailSpy.mockResolvedValue(true);
});

describe("POST /api/waitlist", () => {
  it("sends a confirmation email to the applicant on a new signup", async () => {
    const app = await buildApp();
    const res = await app.inject({
      method: "POST",
      url: "/api/waitlist",
      payload: { email: "New.Applicant@Example.com", name: "Yong" },
    });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ ok: true, alreadyOnList: false });
    expect(sendWaitlistConfirmationEmailSpy).toHaveBeenCalledTimes(1);
    expect(sendWaitlistConfirmationEmailSpy).toHaveBeenCalledWith(
      "new.applicant@example.com",
      "Yong",
    );
  });

  it("sends the admin alert alongside the applicant confirmation", async () => {
    const app = await buildApp();
    await app.inject({
      method: "POST",
      url: "/api/waitlist",
      payload: { email: "both@example.com" },
    });

    expect(sendWaitlistAdminAlertSpy).toHaveBeenCalledTimes(1);
    expect(sendWaitlistConfirmationEmailSpy).toHaveBeenCalledTimes(1);
  });

  it("does not re-send the confirmation on a duplicate signup", async () => {
    const app = await buildApp();
    await app.inject({
      method: "POST",
      url: "/api/waitlist",
      payload: { email: "dupe@example.com" },
    });
    sendWaitlistAdminAlertSpy.mockClear();
    sendWaitlistConfirmationEmailSpy.mockClear();

    const res = await app.inject({
      method: "POST",
      url: "/api/waitlist",
      payload: { email: "dupe@example.com", useCase: "still interested" },
    });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ ok: true, alreadyOnList: true });
    // Admin still sees the follow-up interest; the applicant is not spammed.
    expect(sendWaitlistAdminAlertSpy).toHaveBeenCalledTimes(1);
    expect(sendWaitlistConfirmationEmailSpy).not.toHaveBeenCalled();
  });

  it("still returns success when the confirmation email fails", async () => {
    sendWaitlistConfirmationEmailSpy.mockRejectedValue(new Error("smtp down"));
    const app = await buildApp();

    const res = await app.inject({
      method: "POST",
      url: "/api/waitlist",
      payload: { email: "unlucky@example.com" },
    });
    await flushAsync();

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ ok: true, alreadyOnList: false });
    expect(waitlistByEmail.has("unlucky@example.com")).toBe(true);
  });

  it("confirmation failure does not block the admin alert (and vice versa)", async () => {
    sendWaitlistConfirmationEmailSpy.mockRejectedValue(new Error("smtp down"));
    sendWaitlistAdminAlertSpy.mockRejectedValue(new Error("also down"));
    const app = await buildApp();

    const res = await app.inject({
      method: "POST",
      url: "/api/waitlist",
      payload: { email: "parallel@example.com" },
    });
    await flushAsync();

    expect(res.statusCode).toBe(200);
    expect(sendWaitlistAdminAlertSpy).toHaveBeenCalledTimes(1);
    expect(sendWaitlistConfirmationEmailSpy).toHaveBeenCalledTimes(1);
  });
});
