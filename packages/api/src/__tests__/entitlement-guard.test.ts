import { afterEach, describe, expect, it, vi } from "vitest";

const findUnique = vi.hoisted(() => vi.fn());
vi.mock("../db.js", () => ({ prisma: { user: { findUnique: findUnique } } }));

const ORIGINAL = process.env.PAYWALL_ENABLED;
afterEach(() => {
  findUnique.mockReset();
  if (ORIGINAL === undefined) delete process.env.PAYWALL_ENABLED;
  else process.env.PAYWALL_ENABLED = ORIGINAL;
});

function makeReply() {
  const reply = {
    statusCode: 0,
    payload: undefined as unknown,
    code(c: number) {
      this.statusCode = c;
      return this;
    },
    send(p: unknown) {
      this.payload = p;
      return this;
    },
  };
  return reply;
}

describe("requireEntitled", () => {
  it("is a zero-DB no-op when the paywall is OFF (pre-launch)", async () => {
    process.env.PAYWALL_ENABLED = "";
    vi.resetModules();
    const { requireEntitled } = await import("../entitlement-guard.js");
    const reply = makeReply();
    await requireEntitled({ userId: "u1" } as never, reply as never);
    expect(reply.statusCode).toBe(0); // never touched reply
    expect(findUnique).not.toHaveBeenCalled(); // never queried the DB
  });

  it("403s a non-entitled (FREE) user when the paywall is ON", async () => {
    process.env.PAYWALL_ENABLED = "true";
    vi.resetModules();
    findUnique.mockResolvedValue({ plan: "FREE", role: "USER" });
    const { requireEntitled } = await import("../entitlement-guard.js");
    const reply = makeReply();
    await requireEntitled({ userId: "u1" } as never, reply as never);
    expect(reply.statusCode).toBe(403);
    expect((reply.payload as { code: string }).code).toBe("ENTITLEMENT_REQUIRED");
  });

  it("allows a paid (PRO) user when the paywall is ON", async () => {
    process.env.PAYWALL_ENABLED = "true";
    vi.resetModules();
    findUnique.mockResolvedValue({ plan: "PRO", role: "USER" });
    const { requireEntitled } = await import("../entitlement-guard.js");
    const reply = makeReply();
    await requireEntitled({ userId: "u1" } as never, reply as never);
    expect(reply.statusCode).toBe(0);
  });

  it("allows an ADMIN on FREE (comped) when the paywall is ON", async () => {
    process.env.PAYWALL_ENABLED = "true";
    vi.resetModules();
    findUnique.mockResolvedValue({ plan: "FREE", role: "ADMIN" });
    const { requireEntitled } = await import("../entitlement-guard.js");
    const reply = makeReply();
    await requireEntitled({ userId: "u1" } as never, reply as never);
    expect(reply.statusCode).toBe(0);
  });

  it("401s when no authenticated userId is present and the paywall is ON", async () => {
    process.env.PAYWALL_ENABLED = "true";
    vi.resetModules();
    const { requireEntitled } = await import("../entitlement-guard.js");
    const reply = makeReply();
    await requireEntitled({} as never, reply as never);
    expect(reply.statusCode).toBe(401);
  });
});
