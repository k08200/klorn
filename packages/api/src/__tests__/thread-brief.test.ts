/**
 * Thread brief — the whole-thread read that finally puts the user's OWN sent
 * replies in front of the model. Focus: direction labelling, cache-by-count,
 * the cheap skips (single message, no provider), untrusted wrapping, and the
 * fail-open contract (this is an enhancement; it must never throw at a
 * surface that asked for it).
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
  thread: null as unknown[] | null,
  threadThrows: false,
  cached: null as Record<string, unknown> | null,
  providers: ["prov"] as string[],
  llmJson: JSON.stringify({
    whyNow: "They are chasing the redline you promised on Tuesday",
    asks: ["Send the redline", "Confirm the 17:00 deadline"],
    weOwe: "The redline you promised Tuesday",
    theyOwe: null,
    stance: "Apologise briefly, attach the redline, confirm the time",
  }),
  llmThrows: false,
  upserts: [] as unknown[],
  completions: [] as unknown[],
}));

vi.mock("../mail/gmail-fetch.js", () => ({
  fetchGmailThread: vi.fn(async () => {
    if (state.threadThrows) throw new Error("gmail down");
    return state.thread;
  }),
}));
vi.mock("../llm/openai.js", () => ({
  MODEL: "test-model",
  createCompletion: vi.fn(async (req: unknown) => {
    state.completions.push(req);
    if (state.llmThrows) throw new Error("provider down");
    return { choices: [{ message: { content: state.llmJson } }] };
  }),
}));
vi.mock("../llm/llm-credentials.js", () => ({ getUserLlmCredentials: vi.fn(async () => ({})) }));
vi.mock("../providers/index.js", () => ({ getProviderChain: vi.fn(() => state.providers) }));
vi.mock("../db.js", () => {
  const prisma = {
    threadBrief: {
      findUnique: vi.fn(async () => state.cached),
      upsert: vi.fn(async (args: unknown) => {
        state.upserts.push(args);
        return { id: "tb1" };
      }),
    },
    user: { findUnique: vi.fn(async () => ({ email: "me@klorn.ai" })) },
  };
  return { prisma, db: prisma };
});

import { cachedThreadBrief, getThreadBrief, threadBriefFacts } from "../mail/thread-brief.js";

function msg(from: string, body: string, day: string) {
  return {
    gmailId: `m-${day}`,
    threadId: "t1",
    from,
    to: "",
    cc: "",
    subject: "Contract review",
    snippet: body.slice(0, 40),
    body,
    htmlBody: "",
    labels: [],
    isRead: true,
    isStarred: false,
    receivedAt: new Date(`${day}T09:00:00Z`),
    attachments: [],
  };
}

beforeEach(() => {
  state.thread = null;
  state.threadThrows = false;
  state.cached = null;
  state.providers = ["prov"];
  state.llmThrows = false;
  state.upserts = [];
  state.completions = [];
});

describe("getThreadBrief", () => {
  const THREAD = [
    msg("Sarah <sarah@acme.com>", "Can you send the redline?", "2026-08-18"),
    msg("Me <me@klorn.ai>", "Yes — I'll get it to you Tuesday.", "2026-08-19"),
    msg("Sarah <sarah@acme.com>", "Any update? Legal needs it by 17:00.", "2026-08-22"),
  ];

  it("labels the user's own sent replies and returns the brief", async () => {
    state.thread = THREAD;

    const brief = await getThreadBrief("u1", "t1", { lang: "en" });

    expect(brief.whyNow).toContain("chasing the redline");
    expect(brief.asks).toEqual(["Send the redline", "Confirm the 17:00 deadline"]);
    expect(brief.weOwe).toBe("The redline you promised Tuesday");
    expect(brief.theyOwe).toBeNull();
    expect(brief.messageCount).toBe(3);
    expect(brief.fresh).toBe(true);

    // The whole point: the user's own promise reaches the model, labelled.
    const prompt = (state.completions[0] as { messages: { content: string }[] }).messages[1]
      .content;
    expect(prompt).toContain("← USER");
    expect(prompt).toContain("THEM →");
    expect(prompt).toContain("I'll get it to you Tuesday");
    // Message text is DATA.
    expect(prompt).toContain('<untrusted_content source="email:body">');

    // Cached on the message count, mirroring ContactDossier.
    const upsert = state.upserts[0] as { create: { analyzedMessageCount: number } };
    expect(upsert.create.analyzedMessageCount).toBe(3);
  });

  it("serves the cache when the thread has not grown, and regenerates when it has", async () => {
    state.thread = THREAD;
    state.cached = {
      whyNow: "cached reason",
      asks: ["cached ask"],
      weOwe: null,
      theyOwe: null,
      stance: null,
      analyzedMessageCount: 3,
      lastMessageAt: new Date("2026-08-22T09:00:00Z"),
    };

    const hit = await getThreadBrief("u1", "t1");
    expect(hit.whyNow).toBe("cached reason");
    expect(hit.fresh).toBe(false);
    expect(state.completions).toHaveLength(0);

    // A new message arrived → the cached count no longer matches.
    state.thread = [...THREAD, msg("Sarah <sarah@acme.com>", "Bumping this.", "2026-08-23")];
    const missed = await getThreadBrief("u1", "t1");
    expect(missed.fresh).toBe(true);
    expect(state.completions).toHaveLength(1);
  });

  it("skips the LLM for a single-message thread, no thread id, and no provider", async () => {
    state.thread = [THREAD[0]];
    expect((await getThreadBrief("u1", "t1")).whyNow).toBe("");

    expect((await getThreadBrief("u1", null)).whyNow).toBe("");

    state.thread = THREAD;
    state.providers = [];
    expect((await getThreadBrief("u1", "t1")).whyNow).toBe("");

    expect(state.completions).toHaveLength(0);
  });

  it("fails open to the cache when Gmail or the model is unreachable", async () => {
    state.cached = {
      whyNow: "cached reason",
      asks: [],
      weOwe: null,
      theyOwe: null,
      stance: null,
      analyzedMessageCount: 2,
      lastMessageAt: null,
    };

    state.threadThrows = true;
    expect((await getThreadBrief("u1", "t1")).whyNow).toBe("cached reason");

    state.threadThrows = false;
    state.thread = THREAD;
    state.llmThrows = true;
    expect((await getThreadBrief("u1", "t1")).whyNow).toBe("cached reason");
    expect(state.upserts).toHaveLength(0);
  });

  it("clamps each ask, not just the count", async () => {
    state.thread = THREAD;
    state.llmJson = JSON.stringify({
      whyNow: "chasing",
      // A manipulated entry must not reach downstream prompts unbounded.
      asks: ["x".repeat(5000), "b", "c", "d", "e"],
    });

    const brief = await getThreadBrief("u1", "t1");
    expect(brief.asks).toHaveLength(4);
    expect(brief.asks[0].length).toBe(300);
  });

  it("never persists a brief with no trigger", async () => {
    state.thread = THREAD;
    state.llmJson = JSON.stringify({ whyNow: "", asks: ["something"] });

    const brief = await getThreadBrief("u1", "t1");
    expect(brief.whyNow).toBe("");
    expect(state.upserts).toHaveLength(0);
  });
});

describe("cachedThreadBrief + threadBriefFacts", () => {
  it("reads cache only and renders a compact prompt block", async () => {
    state.cached = {
      whyNow: "They are chasing the redline",
      asks: ["Send the redline"],
      weOwe: "The redline",
      theyOwe: null,
      stance: "Apologise and attach it",
      analyzedMessageCount: 3,
      lastMessageAt: null,
    };

    const brief = await cachedThreadBrief("u1", "t1");
    expect(brief?.whyNow).toBe("They are chasing the redline");
    expect(state.completions).toHaveLength(0);

    const facts = threadBriefFacts(brief);
    expect(facts).toContain("Why they wrote now: They are chasing the redline");
    expect(facts).toContain("You still owe them: The redline");
    // Absent fields are omitted, never rendered as "null".
    expect(facts).not.toContain("They still owe you");

    expect(threadBriefFacts(null)).toBe("");
  });

  it("renders every ask, count- and length-clamped by the generator", async () => {
    // threadBriefFacts itself is a plain renderer: consumers wrap. Both of
    // them do (chat-conversations.ts, email-replies.ts) — this asserts the
    // renderer stays plain so a consumer never double-wraps.
    state.cached = {
      whyNow: "why",
      asks: ["a", "b"],
      weOwe: null,
      theyOwe: "their draft",
      stance: null,
      analyzedMessageCount: 2,
      lastMessageAt: null,
    };
    const facts = threadBriefFacts(await cachedThreadBrief("u1", "t1"));
    expect(facts).toContain("They are asking for: a; b");
    expect(facts).toContain("They still owe you: their draft");
    expect(facts).not.toContain("<untrusted_content");
  });
});
