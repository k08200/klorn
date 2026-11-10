import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
  findFirst: vi.fn(async () => null as null | Record<string, string | null>),
}));

vi.mock("../db.js", () => ({ prisma: { contact: { findFirst: h.findFirst } } }));
vi.mock("../notify/push.js", () => ({ sendPushNotification: vi.fn(async () => undefined) }));
vi.mock("../notify/sms.js", () => ({ sendSms: vi.fn(async () => undefined) }));
vi.mock("../websocket.js", () => ({ pushNotification: vi.fn() }));
vi.mock("../sentry.js", () => ({ captureError: vi.fn() }));

import { getContactContext } from "../agentcore/proactive-actions.js";

const lookedUp = () => (h.findFirst.mock.calls.at(-1) as unknown as [{ where: unknown }])[0].where;

describe("getContactContext", () => {
  beforeEach(() => {
    h.findFirst.mockReset();
    h.findFirst.mockResolvedValue(null);
  });

  it("looks the sender up by the whole address, ignoring case", async () => {
    await getContactContext("u1", '"The CEO" <CEO@evil.com>');
    expect(lookedUp()).toEqual({
      userId: "u1",
      email: { equals: "CEO@evil.com", mode: "insensitive" },
    });
  });

  it("does not turn an empty local part into a match-everything filter", async () => {
    await getContactContext("u1", "<@evil.com>");
    expect(lookedUp()).toEqual({
      userId: "u1",
      email: { equals: "@evil.com", mode: "insensitive" },
    });
  });

  it("describes a known contact and is empty for an unknown one", async () => {
    h.findFirst.mockResolvedValueOnce({ name: "Ana", company: "Acme", role: "CFO", tags: null });
    expect(await getContactContext("u1", "ana@acme.com")).toBe(" (Acme, CFO)");
    expect(await getContactContext("u1", "nobody@acme.com")).toBe("");
  });
});
