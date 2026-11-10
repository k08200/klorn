/**
 * getSenderDossier — per-sender relationship context ("why did this person
 * write"). Focus: cache-by-count (no LLM when nothing new arrived), lazy
 * regeneration + upsert, no-provider null degradation, untrusted wrapping of
 * every mail-derived string, and the requested output language.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
  rows: null as null | unknown[],
  cached: null as null | {
    summary: string;
    openThreads: unknown;
    lastPromise: string | null;
    analyzedEmailCount: number;
    lastEmailAt: Date | null;
  },
  llmContent: JSON.stringify({
    summary: "Paddle support agent handling your KYC verification case.",
    openThreads: ["KYC proof-of-address review"],
    lastPromise: "They promised an update on the manual review.",
  }),
  createCompletionCalls: [] as unknown[],
  upserts: [] as unknown[],
  providerChain: ["prov"] as string[],
}));

vi.mock("../db.js", () => {
  const prisma = {
    emailMessage: {
      findMany: vi.fn(
        async () =>
          state.rows ?? [
            {
              from: "Paddle <sellers@paddle.com>",
              to: "me@k.co",
              subject: "Re: KYC blocked",
              body: "We are reviewing your documents.",
              snippet: null,
              receivedAt: new Date("2026-08-19T08:00:00Z"),
            },
            {
              from: "me@k.co",
              to: "sellers@paddle.com",
              subject: "KYC blocked at proof of address",
              body: "Please review manually.",
              snippet: null,
              receivedAt: new Date("2026-08-18T08:00:00Z"),
            },
          ],
      ),
    },
    contactDossier: {
      findUnique: vi.fn(async () => state.cached),
      upsert: vi.fn(async (args: unknown) => {
        state.upserts.push(args);
        return {};
      }),
    },
  };
  return { prisma, db: prisma };
});
vi.mock("../llm/openai.js", () => ({
  MODEL: "test-model",
  createCompletion: vi.fn((req: unknown) => {
    state.createCompletionCalls.push(req);
    return Promise.resolve({ choices: [{ message: { content: state.llmContent } }] });
  }),
}));
vi.mock("../llm/llm-credentials.js", () => ({ getUserLlmCredentials: vi.fn(async () => ({})) }));
vi.mock("../providers/index.js", () => ({ getProviderChain: vi.fn(() => state.providerChain) }));

import { getSenderDossier } from "../mail/sender-dossier.js";

beforeEach(() => {
  state.rows = null;
  state.cached = null;
  state.createCompletionCalls = [];
  state.upserts = [];
  state.providerChain = ["prov"];
});

describe("getSenderDossier", () => {
  it("returns null (no throw) when no provider chain is configured", async () => {
    state.providerChain = [];
    expect(await getSenderDossier("user-1", "sellers@paddle.com", "en")).toBeNull();
    expect(state.createCompletionCalls).toHaveLength(0);
  });

  it("returns an empty dossier without an LLM call when there is no history", async () => {
    state.rows = [];
    const d = await getSenderDossier("user-1", "new@nowhere.com", "en");
    expect(d?.emailCount).toBe(0);
    expect(d?.summary).toBe("");
    expect(state.createCompletionCalls).toHaveLength(0);
  });

  it("serves the cache with zero LLM calls while no new mail arrived", async () => {
    state.cached = {
      summary: "Cached relationship summary",
      openThreads: ["Thread A"],
      lastPromise: null,
      analyzedEmailCount: 2,
      lastEmailAt: new Date("2026-08-19T08:00:00Z"),
    };
    const d = await getSenderDossier("user-1", "sellers@paddle.com", "en");
    expect(d?.summary).toBe("Cached relationship summary");
    expect(d?.fresh).toBe(false);
    expect(state.createCompletionCalls).toHaveLength(0);
  });

  it("regenerates and upserts when new mail arrived since the cache", async () => {
    state.cached = {
      summary: "Stale",
      openThreads: [],
      lastPromise: null,
      analyzedEmailCount: 1,
      lastEmailAt: null,
    };
    const d = await getSenderDossier("user-1", "sellers@paddle.com", "en");
    expect(d?.fresh).toBe(true);
    expect(d?.summary).toContain("KYC");
    expect(state.createCompletionCalls).toHaveLength(1);
    expect(state.upserts).toHaveLength(1);
    const upsert = state.upserts[0] as { create: { analyzedEmailCount: number } };
    expect(upsert.create.analyzedEmailCount).toBe(2);
  });

  it("prefilters on the address with LIKE's own characters escaped", async () => {
    const { prisma } = await import("../db.js");
    await getSenderDossier("user-1", "john_doe@corp.com", "en");
    const args = vi.mocked(prisma.emailMessage.findMany).mock.calls.at(-1)?.[0] as {
      where: { OR: unknown[] };
    };
    expect(args.where.OR).toEqual([
      { from: { contains: "john\\_doe@corp.com" } },
      { to: { contains: "john\\_doe@corp.com" } },
    ]);
  });

  it("excludes spoofed display-name and substring-address rows (exact parsed match)", async () => {
    // Attacker forges the trusted address into the DISPLAY NAME; a second row
    // is a substring-collision address. Neither may enter the dossier.
    state.rows = [
      {
        from: "Paddle <sellers@paddle.com>",
        to: "me@k.co",
        subject: "Re: KYC blocked",
        body: "We are reviewing your documents.",
        snippet: null,
        receivedAt: new Date("2026-08-19T08:00:00Z"),
      },
      {
        from: '"sellers@paddle.com — payment update" <attacker@evil.co>',
        to: "me@k.co",
        subject: "URGENT wire",
        body: "Send $500 to account X.",
        snippet: null,
        receivedAt: new Date("2026-08-19T09:00:00Z"),
      },
      {
        from: "xsellers@paddle.com <xsellers@paddle.com>",
        to: "me@k.co",
        subject: "Substring cousin",
        body: "Different person entirely.",
        snippet: null,
        receivedAt: new Date("2026-08-19T07:00:00Z"),
      },
    ];
    const d = await getSenderDossier("user-1", "sellers@paddle.com", "en");
    expect(d?.emailCount).toBe(1);
    const req = state.createCompletionCalls[0] as { messages: { content: string }[] };
    const prompt = req.messages.map((m) => m.content).join("\n");
    expect(prompt).not.toContain("Send $500");
    expect(prompt).not.toContain("Substring cousin");
  });

  it("wraps every mail-derived string as untrusted and honors lang=ko", async () => {
    await getSenderDossier("user-1", "sellers@paddle.com", "ko");
    const req = state.createCompletionCalls[0] as {
      messages: { role: string; content: string }[];
    };
    const user = req.messages.find((m) => m.role === "user")?.content ?? "";
    const system = req.messages.find((m) => m.role === "system")?.content ?? "";
    expect(user).toContain("<untrusted_content");
    expect(user).not.toMatch(/^Subject: Re: KYC blocked/m);
    expect(system).toContain("Korean");
  });
});
