import Fastify from "fastify";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

interface EscalationRow {
  id: string;
  userId: string;
  notificationId: string;
  gatherToken: string;
  title: string;
  status: string;
  acknowledgedAt: Date | null;
}

const escalations: EscalationRow[] = [];

const validateRequest = vi.fn(
  (_authToken: string, signature: string, _url: string, _params: Record<string, string>) =>
    signature === "valid-signature",
);

vi.mock("twilio", () => {
  const factory = Object.assign(
    vi.fn(() => ({ calls: { create: vi.fn() } })),
    {
      validateRequest: (...args: unknown[]) =>
        validateRequest(...(args as [string, string, string, Record<string, string>])),
    },
  );
  return { default: factory };
});

vi.mock("../db.js", () => ({
  prisma: {
    phoneEscalation: {
      findUnique: vi.fn(async (args: unknown) => {
        const a = args as { where: { gatherToken?: string; id?: string } };
        if (a.where.gatherToken) {
          return escalations.find((e) => e.gatherToken === a.where.gatherToken) ?? null;
        }
        return escalations.find((e) => e.id === a.where.id) ?? null;
      }),
      update: vi.fn(async (args: unknown) => {
        const a = args as { where: { id: string }; data: Partial<EscalationRow> };
        const row = escalations.find((e) => e.id === a.where.id);
        if (!row) throw new Error("Record not found");
        Object.assign(row, a.data);
        return row;
      }),
    },
  },
}));

const ENV_KEYS = ["TWILIO_AUTH_TOKEN", "PUBLIC_URL", "RENDER_EXTERNAL_URL"] as const;
const originalEnv: Record<string, string | undefined> = {};

async function buildApp() {
  const { phoneRoutes } = await import("../routes/phone.js");
  const app = Fastify();
  await app.register(phoneRoutes, { prefix: "/api/phone" });
  return app;
}

function seedEscalation(overrides: Partial<EscalationRow> = {}): EscalationRow {
  const row: EscalationRow = {
    id: "esc-1",
    userId: "u1",
    notificationId: "n1",
    gatherToken: "tok-1",
    title: "Server is down",
    status: "PLACED",
    acknowledgedAt: null,
    ...overrides,
  };
  escalations.push(row);
  return row;
}

const FORM_HEADERS = {
  "content-type": "application/x-www-form-urlencoded",
  "x-twilio-signature": "valid-signature",
};

beforeEach(() => {
  for (const key of ENV_KEYS) originalEnv[key] = process.env[key];
  process.env.TWILIO_AUTH_TOKEN = "token";
  process.env.PUBLIC_URL = "https://api.example.com";
  delete process.env.RENDER_EXTERNAL_URL;
  escalations.length = 0;
  validateRequest.mockClear();
  vi.resetModules();
});

afterEach(() => {
  for (const key of ENV_KEYS) {
    if (originalEnv[key] === undefined) delete process.env[key];
    else process.env[key] = originalEnv[key];
  }
});

describe("POST /api/phone/gather — signature validation (CASA baseline)", () => {
  it("rejects requests without X-Twilio-Signature", async () => {
    seedEscalation();
    const app = await buildApp();
    const res = await app.inject({
      method: "POST",
      url: "/api/phone/gather?token=tok-1",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: "Digits=2",
    });
    expect(res.statusCode).toBe(403);
    await app.close();
  });

  it("rejects requests with an invalid signature", async () => {
    seedEscalation();
    const app = await buildApp();
    const res = await app.inject({
      method: "POST",
      url: "/api/phone/gather?token=tok-1",
      headers: { ...FORM_HEADERS, "x-twilio-signature": "forged" },
      body: "Digits=2",
    });
    expect(res.statusCode).toBe(403);
    expect(escalations[0]?.status).toBe("PLACED");
    await app.close();
  });

  it("fails closed when TWILIO_AUTH_TOKEN is unset", async () => {
    delete process.env.TWILIO_AUTH_TOKEN;
    seedEscalation();
    const app = await buildApp();
    const res = await app.inject({
      method: "POST",
      url: "/api/phone/gather?token=tok-1",
      headers: FORM_HEADERS,
      body: "Digits=2",
    });
    expect(res.statusCode).toBe(403);
    await app.close();
  });

  it("validates against the full public URL including the query string", async () => {
    seedEscalation();
    const app = await buildApp();
    await app.inject({
      method: "POST",
      url: "/api/phone/gather?token=tok-1",
      headers: FORM_HEADERS,
      body: "Digits=2",
    });
    expect(validateRequest).toHaveBeenCalledWith(
      "token",
      "valid-signature",
      "https://api.example.com/api/phone/gather?token=tok-1",
      expect.objectContaining({ Digits: "2" }),
    );
    await app.close();
  });
});

describe("POST /api/phone/gather — digit handling", () => {
  it("returns 404 for an unknown token", async () => {
    const app = await buildApp();
    const res = await app.inject({
      method: "POST",
      url: "/api/phone/gather?token=nope",
      headers: FORM_HEADERS,
      body: "Digits=2",
    });
    expect(res.statusCode).toBe(404);
    await app.close();
  });

  it("Digits=2 marks the escalation ACKNOWLEDGED and says goodbye", async () => {
    seedEscalation();
    const app = await buildApp();
    const res = await app.inject({
      method: "POST",
      url: "/api/phone/gather?token=tok-1",
      headers: FORM_HEADERS,
      body: "Digits=2",
    });
    expect(res.statusCode).toBe(200);
    expect(res.headers["content-type"]).toContain("text/xml");
    expect(res.body).toContain("Acknowledged. Goodbye.");
    expect(escalations[0]?.status).toBe("ACKNOWLEDGED");
    expect(escalations[0]?.acknowledgedAt).toBeInstanceOf(Date);
    await app.close();
  });

  it("Digits=1 re-says the stored title and gathers again", async () => {
    seedEscalation({ title: "Server is down" });
    const app = await buildApp();
    const res = await app.inject({
      method: "POST",
      url: "/api/phone/gather?token=tok-1",
      headers: FORM_HEADERS,
      body: "Digits=1",
    });
    expect(res.statusCode).toBe(200);
    expect(res.body).toContain("Server is down");
    expect(res.body).toContain("<Gather");
    expect(res.body).toContain("token=tok-1");
    expect(escalations[0]?.status).toBe("ANSWERED");
    await app.close();
  });

  it("any other digit says goodbye without acknowledging", async () => {
    seedEscalation();
    const app = await buildApp();
    const res = await app.inject({
      method: "POST",
      url: "/api/phone/gather?token=tok-1",
      headers: FORM_HEADERS,
      body: "Digits=7",
    });
    expect(res.statusCode).toBe(200);
    expect(res.body).toContain("Goodbye.");
    expect(escalations[0]?.status).toBe("ANSWERED");
    await app.close();
  });
});

describe("POST /api/phone/status — terminal call status", () => {
  it("marks PLACED escalations FAILED on no-answer", async () => {
    seedEscalation();
    const app = await buildApp();
    const res = await app.inject({
      method: "POST",
      url: "/api/phone/status?token=tok-1",
      headers: FORM_HEADERS,
      body: "CallStatus=no-answer",
    });
    expect(res.statusCode).toBe(200);
    expect(escalations[0]?.status).toBe("FAILED");
    await app.close();
  });

  it("does not downgrade an ACKNOWLEDGED escalation", async () => {
    seedEscalation({ status: "ACKNOWLEDGED" });
    const app = await buildApp();
    await app.inject({
      method: "POST",
      url: "/api/phone/status?token=tok-1",
      headers: FORM_HEADERS,
      body: "CallStatus=completed",
    });
    expect(escalations[0]?.status).toBe("ACKNOWLEDGED");
    await app.close();
  });

  it("rejects forged status callbacks", async () => {
    seedEscalation();
    const app = await buildApp();
    const res = await app.inject({
      method: "POST",
      url: "/api/phone/status?token=tok-1",
      headers: { ...FORM_HEADERS, "x-twilio-signature": "forged" },
      body: "CallStatus=no-answer",
    });
    expect(res.statusCode).toBe(403);
    expect(escalations[0]?.status).toBe("PLACED");
    await app.close();
  });
});
