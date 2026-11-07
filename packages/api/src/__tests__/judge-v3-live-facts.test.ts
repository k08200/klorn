/**
 * The live facts path (attention engine v3 with JUDGE_V3_POLICY on): the facts
 * call is part of the judge for that user. Unlike the shadow it waits for its
 * slot, uses reserved budget and the user's credentials, stores the row before
 * answering, and on a deadline answers "timeout" while the call finishes and
 * stores in the background. It never throws.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const captureError = vi.hoisted(() => vi.fn());
vi.mock("../sentry.js", () => ({ captureError }));

import { extractFactsForDecision, type LiveFactsDeps } from "../judge/v3/live-facts.js";
import type { ShadowMail } from "../judge/v3/shadow.js";

const mail: ShadowMail = {
  emailId: "e1",
  threadId: "t1",
  from: "Sarah <sarah@partner.io>",
  to: "me@acme.com",
  cc: null,
  subject: "Contract",
  snippet: "Could you confirm by Tuesday 6pm?",
  body: "Could you confirm by Tuesday 6pm?",
  labels: ["INBOX"],
  receivedAt: new Date("2026-10-30T00:12:00Z"),
  hasListUnsubscribe: false,
  listId: null,
  precedence: null,
  autoSubmitted: null,
  dateHeader: null,
  hasCalendarInvite: null,
  senderAuthenticated: true,
};

const extraction = { source: "llm", facts: {}, usage: null } as never;
const rel = { sentCount: 1 } as never;

function deps(over: Partial<LiveFactsDeps> = {}): LiveFactsDeps {
  return {
    userContext: vi.fn(async () => ({ userAddresses: ["me@acme.com"], timeZone: "Asia/Seoul" })),
    repliedAfter: vi.fn(async () => false),
    extract: vi.fn(async () => extraction),
    relationship: vi.fn(async () => rel),
    save: vi.fn(async () => undefined),
    now: () => new Date("2026-10-30T00:12:03Z"),
    ...over,
  };
}

const opts = { v2Tier: "QUEUE" as const, deadlineMs: 20_000 };

afterEach(() => {
  vi.useRealTimers();
});

describe("extractFactsForDecision", () => {
  it("extracts with reserved budget, waiting (no noWait), with the user's credentials", async () => {
    const d = deps();
    const credentials = { anthropicApiKey: "user-key" } as never;
    await extractFactsForDecision("u1", mail, { ...opts, credentials }, d);
    const [, o] = (d.extract as ReturnType<typeof vi.fn>).mock.calls[0] as [
      unknown,
      Record<string, unknown>,
    ];
    expect(o).toMatchObject({ userId: "u1", reserved: true, credentials });
    expect(o.noWait).toBeUndefined();
  });

  it("stores the row (v2 lane frozen) before answering ok, and returns the facts and relationship", async () => {
    const d = deps();
    const r = await extractFactsForDecision("u1", mail, opts, d);
    expect(r).toEqual({ status: "ok", extraction, relationship: rel });
    expect(d.save).toHaveBeenCalledWith(
      expect.objectContaining({
        userId: "u1",
        source: "EMAIL",
        sourceId: "e1",
        v2Tier: "QUEUE",
        extraction,
        relationship: rel,
      }),
    );
    expect(d.relationship).toHaveBeenCalledWith("u1", mail.from, ["me@acme.com"], true, "e1");
  });

  it("answers timeout at the deadline, then still finishes and stores in the background", async () => {
    vi.useFakeTimers();
    let release: () => void = () => {};
    const d = deps({
      extract: vi.fn(
        () =>
          new Promise((r) => {
            release = () => r(extraction);
          }),
      ) as never,
    });
    const pending = extractFactsForDecision("u1", mail, { ...opts, deadlineMs: 1000 }, d);
    await vi.advanceTimersByTimeAsync(1000);
    expect(await pending).toEqual({ status: "timeout" });
    expect(d.save).not.toHaveBeenCalled();
    release();
    await vi.waitFor(() => expect(d.save).toHaveBeenCalledTimes(1));
  });

  it("maps budget refusals to budget, anything else to error, and never throws", async () => {
    for (const name of ["DailyCostCapExceededError", "UserRateLimitedError"]) {
      const err = Object.assign(new Error("x"), { name });
      const r = await extractFactsForDecision(
        "u1",
        mail,
        opts,
        deps({
          extract: vi.fn(async () => {
            throw err;
          }),
        }),
      );
      expect(r).toEqual({ status: "budget" });
    }
    const boom = await extractFactsForDecision(
      "u1",
      mail,
      opts,
      deps({
        save: vi.fn(async () => {
          throw new Error("db down");
        }),
      }),
    );
    expect(boom).toEqual({ status: "error" });
    const syncThrow = await extractFactsForDecision(
      "u1",
      mail,
      opts,
      deps({
        userContext: vi.fn(() => {
          throw new Error("sync");
        }) as never,
      }),
    );
    expect(syncThrow).toEqual({ status: "error" });
  });

  it("a no-LLM extraction is still ok (source none); the caller decides the lane", async () => {
    const none = { source: "none", facts: null, usage: null } as never;
    const r = await extractFactsForDecision(
      "u1",
      mail,
      opts,
      deps({ extract: vi.fn(async () => none) }),
    );
    expect(r).toMatchObject({ status: "ok", extraction: none });
  });
});

describe("extractFactsForDecision: deadline hygiene", () => {
  it("clears its timer once answered", async () => {
    vi.useFakeTimers();
    await extractFactsForDecision("u1", mail, opts, deps());
    expect(vi.getTimerCount()).toBe(0);
  });

  it("marks the work abandoned at the deadline, so the extractor won't retry", async () => {
    vi.useFakeTimers();
    let seen: (() => boolean) | undefined;
    let release: () => void = () => {};
    const d = deps({
      extract: vi.fn((_i: unknown, o: { abandoned?: () => boolean }) => {
        seen = o.abandoned;
        return new Promise((r) => {
          release = () => r(extraction);
        });
      }) as never,
    });
    const pending = extractFactsForDecision("u1", mail, { ...opts, deadlineMs: 500 }, d);
    await vi.advanceTimersByTimeAsync(500);
    expect(await pending).toEqual({ status: "timeout" });
    expect(seen?.()).toBe(true);
    release();
  });

  it("a failure after the deadline is contained (no unhandled rejection) and logs the name only", async () => {
    vi.useFakeTimers();
    captureError.mockClear();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    let fail: () => void = () => {};
    const d = deps({
      extract: vi.fn(
        () =>
          new Promise((_r, rej) => {
            fail = () =>
              rej(Object.assign(new Error("echo: secret mail text"), { name: "ProviderError" }));
          }),
      ) as never,
    });
    const pending = extractFactsForDecision("u1", mail, { ...opts, deadlineMs: 100 }, d);
    await vi.advanceTimersByTimeAsync(100);
    expect(await pending).toEqual({ status: "timeout" });
    fail();
    await vi.waitFor(() => expect(captureError).toHaveBeenCalled());
    const sent = (captureError.mock.calls[0] as unknown as [Error])[0];
    expect(sent.message).toContain("ProviderError");
    expect(sent.message).not.toContain("secret mail text");
    expect(JSON.stringify(warn.mock.calls)).not.toContain("secret mail text");
    warn.mockRestore();
  });
});
