/**
 * Running one admitted MCP write call — per-user cap, audit ordering, and the
 * per-tool success predicate that decides whether a row settles to ok or error.
 * The cap is per USER (never per key), a sliding window, in-process (so per
 * instance, like the team_availability precedent in tool-executor.ts).
 */

import crypto from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const create = vi.hoisted(() => vi.fn());
const update = vi.hoisted(() => vi.fn());
const captureError = vi.hoisted(() => vi.fn());
const executeToolCall = vi.hoisted(() => vi.fn());
const executeSetTier = vi.hoisted(() => vi.fn());
const executeCreateDraft = vi.hoisted(() => vi.fn());

vi.mock("../db.js", () => {
  const prisma = { mcpWriteAudit: { create, update } };
  return { prisma, db: prisma };
});
vi.mock("../sentry.js", () => ({ captureError }));
vi.mock("../agentcore/tool-executor.js", () => ({ executeToolCall }));
vi.mock("../mcp/set-tier.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../mcp/set-tier.js")>()),
  executeSetTier,
}));
vi.mock("../mcp/create-draft.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../mcp/create-draft.js")>()),
  executeCreateDraft,
}));

import {
  consumeMcpWriteBudget,
  isWriteSuccess,
  MCP_CREATE_DRAFT_CAP_PER_WINDOW,
  MCP_WRITE_CAP_PER_WINDOW,
  MCP_WRITE_WINDOW_MS,
  runMcpWriteCall,
  trackedWriteBudgetUsers,
} from "../mcp/write-call.js";

const sha256 = (text: string) => crypto.createHash("sha256").update(text).digest("hex");

let seq = 0;
/** A fresh user per test: the window lives in module state by design. */
const freshUser = () => `write-call-user-${++seq}`;
const callFor = (userId: string) => ({
  userId,
  apiKeyId: `k-${userId}`,
  name: "mark_read",
  args: { email_id: "g-1" },
});

beforeEach(() => {
  create.mockReset();
  update.mockReset();
  captureError.mockReset();
  executeToolCall.mockReset();
  executeSetTier.mockReset();
  executeCreateDraft.mockReset();
  create.mockResolvedValue({ id: "audit-1" });
  update.mockResolvedValue({});
  executeToolCall.mockResolvedValue(JSON.stringify({ success: true }));
  executeSetTier.mockResolvedValue(JSON.stringify({ success: true, tier: "PUSH" }));
  executeCreateDraft.mockResolvedValue(
    JSON.stringify({ success: true, draft_id: "d-1", provider: "GOOGLE", to: "a@b.co" }),
  );
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-09-30T10:00:00.000Z"));
  vi.stubEnv("MCP_WRITE_TOOLS_ENABLED", "true");
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
});

describe("consumeMcpWriteBudget", () => {
  it("proposes 30 writes per minute", () => {
    expect(MCP_WRITE_CAP_PER_WINDOW).toBe(30);
    expect(MCP_WRITE_WINDOW_MS).toBe(60_000);
  });

  it("allows exactly the cap, then refuses", () => {
    const userId = freshUser();
    for (let i = 0; i < MCP_WRITE_CAP_PER_WINDOW; i++) {
      expect(consumeMcpWriteBudget(userId), `call ${i + 1}`).toBe(true);
    }
    expect(consumeMcpWriteBudget(userId)).toBe(false);
    expect(consumeMcpWriteBudget(userId)).toBe(false);
  });

  it("a refused call does not extend the window (refusals are not recorded)", () => {
    const userId = freshUser();
    for (let i = 0; i < MCP_WRITE_CAP_PER_WINDOW; i++) consumeMcpWriteBudget(userId);
    vi.advanceTimersByTime(MCP_WRITE_WINDOW_MS - 1);
    expect(consumeMcpWriteBudget(userId)).toBe(false);
    vi.advanceTimersByTime(1);
    expect(consumeMcpWriteBudget(userId)).toBe(true);
  });

  it("slides: only calls older than the window free up budget", () => {
    const userId = freshUser();
    for (let i = 0; i < 10; i++) consumeMcpWriteBudget(userId);
    vi.advanceTimersByTime(30_000);
    for (let i = 0; i < MCP_WRITE_CAP_PER_WINDOW - 10; i++) consumeMcpWriteBudget(userId);
    expect(consumeMcpWriteBudget(userId)).toBe(false);
    // The first 10 age out; the later 20 still count.
    vi.advanceTimersByTime(MCP_WRITE_WINDOW_MS - 30_000);
    for (let i = 0; i < 10; i++) expect(consumeMcpWriteBudget(userId)).toBe(true);
    expect(consumeMcpWriteBudget(userId)).toBe(false);
  });

  it("keeps users independent", () => {
    const a = freshUser();
    const b = freshUser();
    for (let i = 0; i < MCP_WRITE_CAP_PER_WINDOW; i++) consumeMcpWriteBudget(a);
    expect(consumeMcpWriteBudget(a)).toBe(false);
    expect(consumeMcpWriteBudget(b)).toBe(true);
  });

  it("forgets idle users, so the map does not grow with every user that ever wrote", () => {
    for (let i = 0; i < 5; i++) consumeMcpWriteBudget(freshUser());
    expect(trackedWriteBudgetUsers()).toBeGreaterThanOrEqual(5);
    vi.advanceTimersByTime(MCP_WRITE_WINDOW_MS * 2);
    const active = freshUser();
    consumeMcpWriteBudget(active);
    expect(trackedWriteBudgetUsers()).toBe(1);
    // The remaining user still has an intact window.
    for (let i = 1; i < MCP_WRITE_CAP_PER_WINDOW; i++) consumeMcpWriteBudget(active);
    expect(consumeMcpWriteBudget(active)).toBe(false);
  });
});

describe("isWriteSuccess (mark_read: the parsed result must have success === true)", () => {
  const cases: [string, string, boolean][] = [
    ["success:true", JSON.stringify({ success: true }), true],
    ["success:true with extras", JSON.stringify({ success: true, messageId: "m" }), true],
    ["success:false", JSON.stringify({ success: false }), false],
    ["success as a string", JSON.stringify({ success: "true" }), false],
    ["success as 1", JSON.stringify({ success: 1 }), false],
    ["in-band failure", JSON.stringify({ error: "Gmail not connected." }), false],
    ["numeric error", JSON.stringify({ error: 1 }), false],
    ["unsupported provider", JSON.stringify({ unsupported: true, error: "no" }), false],
    ["the old ok shape", JSON.stringify({ ok: true }), false],
    ["a JSON array", JSON.stringify([{ success: true }]), false],
    ["JSON null", "null", false],
    ["a bare true", "true", false],
    ["non-JSON text", "Gmail said no", false],
    ["truncated JSON", '{"success":tr', false],
    ["empty string", "", false],
  ];
  for (const [label, text, expected] of cases) {
    it(`${label} -> ${expected}`, () => {
      expect(isWriteSuccess("mark_read", text)).toBe(expected);
    });
  }

  it("fails closed for a write tool with no predicate", () => {
    expect(isWriteSuccess("some_future_tool", JSON.stringify({ success: true }))).toBe(false);
  });
});

describe("runMcpWriteCall", () => {
  it("audits as attempted before executing, then settles ok when the predicate holds", async () => {
    const order: string[] = [];
    create.mockImplementationOnce(async () => {
      order.push("insert");
      return { id: "audit-7" };
    });
    executeToolCall.mockImplementationOnce(async () => {
      order.push("execute");
      return JSON.stringify({ success: true });
    });
    update.mockImplementationOnce(async () => {
      order.push("settle");
      return {};
    });
    const result = await runMcpWriteCall(callFor(freshUser()));
    expect(order).toEqual(["insert", "execute", "settle"]);
    expect(result).toEqual({
      content: [{ type: "text", text: JSON.stringify({ success: true }) }],
    });
    expect(update).toHaveBeenCalledWith({
      where: { id: "audit-7" },
      data: { outcome: "ok", reason: null },
    });
  });

  it("settles error/tool_error when the result is not a success, and passes it through", async () => {
    for (const text of [
      JSON.stringify({ error: "Gmail not connected." }),
      JSON.stringify({ unsupported: true, error: "no" }),
      "not json",
    ]) {
      update.mockClear();
      executeToolCall.mockResolvedValueOnce(text);
      const result = await runMcpWriteCall(callFor(freshUser()));
      expect(result).toEqual({ content: [{ type: "text", text }] });
      expect(update).toHaveBeenCalledWith({
        where: { id: "audit-1" },
        data: { outcome: "error", reason: "tool_error" },
      });
    }
  });

  it("settles error/exception when execution throws, and answers in-band", async () => {
    executeToolCall.mockRejectedValueOnce(new Error("boom"));
    const result = await runMcpWriteCall(callFor(freshUser()));
    expect(result).toEqual({
      content: [{ type: "text", text: JSON.stringify({ error: "boom" }) }],
      isError: true,
    });
    expect(update).toHaveBeenCalledWith({
      where: { id: "audit-1" },
      data: { outcome: "error", reason: "exception" },
    });
  });

  it("a settle failure never changes the response, on the success, failure and throw paths", async () => {
    update.mockRejectedValue(new Error("db down"));
    const ok = await runMcpWriteCall(callFor(freshUser()));
    expect(ok).toEqual({ content: [{ type: "text", text: JSON.stringify({ success: true }) }] });

    const failure = JSON.stringify({ error: "nope" });
    executeToolCall.mockResolvedValueOnce(failure);
    const bad = await runMcpWriteCall(callFor(freshUser()));
    expect(bad).toEqual({ content: [{ type: "text", text: failure }] });

    executeToolCall.mockRejectedValueOnce(new Error("boom"));
    const thrown = await runMcpWriteCall(callFor(freshUser()));
    expect(thrown.isError).toBe(true);
    expect(JSON.parse(thrown.content[0]?.text ?? "{}").error).toBe("boom");
  });

  it("refuses without executing when the audit insert fails, reporting user and key", async () => {
    create.mockRejectedValueOnce(new Error("db down"));
    const call = callFor(freshUser());
    const result = await runMcpWriteCall(call);
    expect(result.isError).toBe(true);
    expect(JSON.parse(result.content[0]?.text ?? "{}").error).toMatch(/audit/i);
    expect(executeToolCall).not.toHaveBeenCalled();
    expect(captureError.mock.calls[0]?.[1]).toMatchObject({
      extra: { userId: call.userId, apiKeyId: call.apiKeyId, tool: "mark_read" },
    });
  });

  it("answers RATE_LIMITED over the cap and executes nothing further", async () => {
    const userId = freshUser();
    for (let i = 0; i < MCP_WRITE_CAP_PER_WINDOW; i++) await runMcpWriteCall(callFor(userId));
    executeToolCall.mockClear();
    const over = await runMcpWriteCall(callFor(userId));
    expect(over.isError).toBe(true);
    expect(JSON.parse(over.content[0]?.text ?? "{}")).toMatchObject({ code: "RATE_LIMITED" });
    expect(executeToolCall).not.toHaveBeenCalled();
  });
});

describe("runMcpWriteCall — set_tier", () => {
  const tierCall = (userId: string, apiKeyId = `k-${userId}`) => ({
    userId,
    apiKeyId,
    name: "set_tier",
    args: { email_id: "g-1", tier: "PUSH" },
  });

  it("runs set_tier through its own executor with the caller and key, never the shared tool executor", async () => {
    const call = tierCall(freshUser());
    await runMcpWriteCall(call);
    expect(executeSetTier).toHaveBeenCalledWith(
      { userId: call.userId, apiKeyId: call.apiKeyId },
      call.args,
    );
    expect(executeToolCall).not.toHaveBeenCalled();
  });

  it("audits as attempted before the change, then settles ok on a success result", async () => {
    const order: string[] = [];
    create.mockImplementationOnce(async () => {
      order.push("insert");
      return { id: "audit-9" };
    });
    executeSetTier.mockImplementationOnce(async () => {
      order.push("execute");
      return JSON.stringify({ success: true, tier: "PUSH" });
    });
    update.mockImplementationOnce(async () => {
      order.push("settle");
      return {};
    });
    await runMcpWriteCall(tierCall(freshUser()));
    expect(order).toEqual(["insert", "execute", "settle"]);
    expect(update).toHaveBeenCalledWith({
      where: { id: "audit-9" },
      data: { outcome: "ok", reason: null },
    });
    expect(create.mock.calls[0]?.[0].data).toMatchObject({ tool: "set_tier", targetId: "g-1" });
  });

  it("records the previous and the new lane on the audit row when the lane changed, so a revert is possible later", async () => {
    executeSetTier.mockResolvedValueOnce(
      JSON.stringify({
        success: true,
        email_id: "g-1",
        previous_tier: "QUEUE",
        tier: "PUSH",
        changed: true,
      }),
    );
    await runMcpWriteCall(tierCall(freshUser()));
    expect(update).toHaveBeenCalledWith({
      where: { id: "audit-1" },
      data: { outcome: "ok", reason: null, tierFrom: "QUEUE", tierTo: "PUSH" },
    });
  });

  it("records no lanes for a no-op, a refusal or any other write tool", async () => {
    executeSetTier.mockResolvedValueOnce(
      JSON.stringify({ success: true, previous_tier: "PUSH", tier: "PUSH", changed: false }),
    );
    await runMcpWriteCall(tierCall(freshUser()));
    expect(update).toHaveBeenLastCalledWith({
      where: { id: "audit-1" },
      data: { outcome: "ok", reason: null },
    });
    executeSetTier.mockResolvedValueOnce(JSON.stringify({ error: "x", code: "NOT_FOUND" }));
    await runMcpWriteCall(tierCall(freshUser()));
    expect(update.mock.lastCall?.[0].data).not.toHaveProperty("tierFrom");
    executeToolCall.mockResolvedValueOnce(
      JSON.stringify({ success: true, previous_tier: "QUEUE", tier: "PUSH", changed: true }),
    );
    await runMcpWriteCall(callFor(freshUser()));
    expect(update.mock.lastCall?.[0].data).not.toHaveProperty("tierFrom");
  });

  it("settles error/tool_error for a refusal, and passes the explicit result through", async () => {
    const refusal = JSON.stringify({ error: "moved by hand", code: "MANUAL_OVERRIDE" });
    executeSetTier.mockResolvedValueOnce(refusal);
    const result = await runMcpWriteCall(tierCall(freshUser()));
    expect(result).toEqual({ content: [{ type: "text", text: refusal }] });
    expect(update).toHaveBeenCalledWith({
      where: { id: "audit-1" },
      data: { outcome: "error", reason: "tool_error" },
    });
  });

  it("settles error/exception when the executor throws", async () => {
    executeSetTier.mockRejectedValueOnce(new Error("boom"));
    const result = await runMcpWriteCall(tierCall(freshUser()));
    expect(result.isError).toBe(true);
    expect(update).toHaveBeenCalledWith({
      where: { id: "audit-1" },
      data: { outcome: "error", reason: "exception" },
    });
  });

  it("shares the per-user cap with mark_read: the 31st write of either kind is refused", async () => {
    const userId = freshUser();
    for (let i = 0; i < MCP_WRITE_CAP_PER_WINDOW - 1; i++) await runMcpWriteCall(callFor(userId));
    await runMcpWriteCall(tierCall(userId));
    executeSetTier.mockClear();
    const over = await runMcpWriteCall(tierCall(userId, "another-key"));
    expect(JSON.parse(over.content[0]?.text ?? "{}")).toMatchObject({ code: "RATE_LIMITED" });
    expect(executeSetTier).not.toHaveBeenCalled();
  });

  it("does not run, and leaves no change, when the audit insert fails", async () => {
    create.mockRejectedValueOnce(new Error("db down"));
    const result = await runMcpWriteCall(tierCall(freshUser()));
    expect(result.isError).toBe(true);
    expect(executeSetTier).not.toHaveBeenCalled();
  });
});

describe("isWriteSuccess for create_draft", () => {
  const cases: [string, string, boolean][] = [
    [
      "a created draft",
      JSON.stringify({ success: true, draft_id: "d-1", provider: "GOOGLE", to: "a@b.co" }),
      true,
    ],
    ["an unsupported provider", JSON.stringify({ unsupported: true, error: "no" }), false],
    ["an in-band error", JSON.stringify({ error: "Gmail not connected." }), false],
    ["a coded refusal", JSON.stringify({ error: "x", code: "NOT_FOUND" }), false],
    ["success as a string", JSON.stringify({ success: "true" }), false],
    ["an array", JSON.stringify([{ success: true }]), false],
    ["non-JSON", "drafted!", false],
  ];
  for (const [label, text, expected] of cases) {
    it(`${label} -> ${expected}`, () => {
      expect(isWriteSuccess("create_draft", text)).toBe(expected);
    });
  }
});

describe("runMcpWriteCall — create_draft", () => {
  const draftCall = (userId: string, apiKeyId = `k-${userId}`) => ({
    userId,
    apiKeyId,
    name: "create_draft",
    args: { email_id: "g-1", body: "Thursday works." },
  });

  it("runs create_draft through its own executor with the caller alone, never the shared tool executor", async () => {
    const call = draftCall(freshUser());
    await runMcpWriteCall(call);
    expect(executeCreateDraft).toHaveBeenCalledWith({ userId: call.userId }, call.args);
    expect(executeToolCall).not.toHaveBeenCalled();
    expect(executeSetTier).not.toHaveBeenCalled();
  });

  it("audits as attempted before the draft is made, then settles ok with the draft id and the recipient hash (and no lanes)", async () => {
    const order: string[] = [];
    create.mockImplementationOnce(async () => {
      order.push("insert");
      return { id: "audit-5" };
    });
    executeCreateDraft.mockImplementationOnce(async () => {
      order.push("execute");
      return JSON.stringify({ success: true, draft_id: "d-1", provider: "GOOGLE", to: "a@b.co" });
    });
    update.mockImplementationOnce(async () => {
      order.push("settle");
      return {};
    });
    await runMcpWriteCall(draftCall(freshUser()));
    expect(order).toEqual(["insert", "execute", "settle"]);
    expect(create.mock.calls[0]?.[0].data).toMatchObject({
      tool: "create_draft",
      targetId: "g-1",
      outcome: "attempted",
    });
    expect(update).toHaveBeenCalledWith({
      where: { id: "audit-5" },
      data: {
        outcome: "ok",
        reason: null,
        draftId: "d-1",
        recipientHash: sha256("a@b.co"),
      },
    });
  });

  it("inserts the SHA-256 of the body with the attempted row, so a long draft is identified by its content, never stored", async () => {
    const body = "Thursday works. ".repeat(1000); // 16,000 characters: over the 4 KB args-hash limit
    expect(body.length).toBeGreaterThan(15_000);
    await runMcpWriteCall({ ...draftCall(freshUser()), args: { email_id: "g-1", body } });
    const data = create.mock.calls[0]?.[0].data;
    expect(data.bodyHash).toBe(sha256(body));
    expect(JSON.stringify(data)).not.toContain("Thursday works.");
  });

  it("two different long bodies differ in bodyHash even though the args hash only marks them oversize", async () => {
    const a = "a".repeat(15_000);
    const b = "b".repeat(15_000);
    await runMcpWriteCall({ ...draftCall(freshUser()), args: { email_id: "g-1", body: a } });
    await runMcpWriteCall({ ...draftCall(freshUser()), args: { email_id: "g-1", body: b } });
    const [first, second] = create.mock.calls.map((c) => c[0].data);
    expect(first.bodyHash).not.toBe(second.bodyHash);
  });

  it("records the recipient hash over the LOWERCASED address, so it can be recomputed from the sender", async () => {
    executeCreateDraft.mockResolvedValueOnce(
      JSON.stringify({
        success: true,
        draft_id: "d-2",
        provider: "GOOGLE",
        to: "Alice@Example.COM",
      }),
    );
    await runMcpWriteCall(draftCall(freshUser()));
    expect(update.mock.calls.at(-1)?.[0].data.recipientHash).toBe(sha256("alice@example.com"));
  });

  it("records no draft id when the provider's id is not id-shaped, and none at all for a non-success", async () => {
    executeCreateDraft.mockResolvedValueOnce(
      JSON.stringify({ success: true, draft_id: "bad id\n", provider: "GOOGLE", to: "a@b.co" }),
    );
    await runMcpWriteCall(draftCall(freshUser()));
    expect(update.mock.calls.at(-1)?.[0].data).toMatchObject({ draftId: null });
    executeCreateDraft.mockResolvedValueOnce(JSON.stringify({ unsupported: true, error: "no" }));
    await runMcpWriteCall(draftCall(freshUser()));
    expect(update.mock.calls.at(-1)?.[0].data).toEqual({ outcome: "error", reason: "tool_error" });
  });

  it("other write tools carry no body hash on their audit row", async () => {
    await runMcpWriteCall(callFor(freshUser()));
    await runMcpWriteCall({
      ...callFor(freshUser()),
      name: "set_tier",
      args: { email_id: "g-1", tier: "PUSH" },
    });
    for (const call of create.mock.calls) {
      expect(Object.keys(call[0].data)).not.toContain("bodyHash");
    }
  });

  it("settles error/tool_error for an unsupported provider and passes that result through unchanged", async () => {
    const unsupported = JSON.stringify({ unsupported: true, error: "no drafts here" });
    executeCreateDraft.mockResolvedValueOnce(unsupported);
    const result = await runMcpWriteCall(draftCall(freshUser()));
    expect(result).toEqual({ content: [{ type: "text", text: unsupported }] });
    expect(update).toHaveBeenCalledWith({
      where: { id: "audit-1" },
      data: { outcome: "error", reason: "tool_error" },
    });
  });

  it("settles error/tool_error for a coded refusal", async () => {
    executeCreateDraft.mockResolvedValueOnce(
      JSON.stringify({ error: "x", code: "INVALID_ARGUMENT" }),
    );
    await runMcpWriteCall(draftCall(freshUser()));
    expect(update).toHaveBeenCalledWith({
      where: { id: "audit-1" },
      data: { outcome: "error", reason: "tool_error" },
    });
  });

  it("settles error/exception when the executor throws", async () => {
    executeCreateDraft.mockRejectedValueOnce(new Error("boom"));
    const result = await runMcpWriteCall(draftCall(freshUser()));
    expect(result.isError).toBe(true);
    expect(update).toHaveBeenCalledWith({
      where: { id: "audit-1" },
      data: { outcome: "error", reason: "exception" },
    });
  });

  it("shares the per-user cap with the other write tools: the 31st write of any kind is refused", async () => {
    const userId = freshUser();
    for (let i = 0; i < MCP_WRITE_CAP_PER_WINDOW - 1; i++) await runMcpWriteCall(callFor(userId));
    await runMcpWriteCall(draftCall(userId));
    executeCreateDraft.mockClear();
    const over = await runMcpWriteCall(draftCall(userId, "another-key"));
    expect(JSON.parse(over.content[0]?.text ?? "{}")).toMatchObject({ code: "RATE_LIMITED" });
    expect(executeCreateDraft).not.toHaveBeenCalled();
  });

  it("does not run, and makes no draft, when the audit insert fails", async () => {
    create.mockRejectedValueOnce(new Error("db down"));
    const result = await runMcpWriteCall(draftCall(freshUser()));
    expect(result.isError).toBe(true);
    expect(executeCreateDraft).not.toHaveBeenCalled();
  });
});

describe("create_draft has its own, lower cap on top of the shared write cap", () => {
  const draftCall = (userId: string, apiKeyId = `k-${userId}`) => ({
    userId,
    apiKeyId,
    name: "create_draft",
    args: { email_id: "g-1", body: "Thursday works." },
  });

  it("proposes 10 drafts per minute, below the shared 30", () => {
    expect(MCP_CREATE_DRAFT_CAP_PER_WINDOW).toBe(10);
    expect(MCP_CREATE_DRAFT_CAP_PER_WINDOW).toBeLessThan(MCP_WRITE_CAP_PER_WINDOW);
  });

  it("allows exactly the draft cap, then refuses with RATE_LIMITED and audits why, without running the tool", async () => {
    const userId = freshUser();
    for (let i = 0; i < MCP_CREATE_DRAFT_CAP_PER_WINDOW; i++) {
      const ok = await runMcpWriteCall(draftCall(userId));
      expect(ok.isError, `draft ${i + 1}`).toBeUndefined();
    }
    executeCreateDraft.mockClear();
    create.mockClear();
    const over = await runMcpWriteCall(draftCall(userId));
    expect(over.isError).toBe(true);
    expect(JSON.parse(over.content[0]?.text ?? "{}")).toMatchObject({ code: "RATE_LIMITED" });
    expect(executeCreateDraft).not.toHaveBeenCalled();
    await vi.waitFor(() => expect(create).toHaveBeenCalledTimes(1));
    expect(create.mock.calls[0]?.[0].data).toMatchObject({
      tool: "create_draft",
      outcome: "refused",
      reason: "rate_limited",
    });
  });

  it("is per user and shared across keys", async () => {
    const a = freshUser();
    const b = freshUser();
    for (let i = 0; i < MCP_CREATE_DRAFT_CAP_PER_WINDOW; i++) {
      await runMcpWriteCall(draftCall(a, i % 2 ? "key-x" : "key-y"));
    }
    const over = await runMcpWriteCall(draftCall(a, "key-z"));
    expect(JSON.parse(over.content[0]?.text ?? "{}")).toMatchObject({ code: "RATE_LIMITED" });
    const other = await runMcpWriteCall(draftCall(b));
    expect(other.isError).toBeUndefined();
  });

  it("does not limit the other write tools: mark_read and set_tier still run after the draft cap is hit", async () => {
    const userId = freshUser();
    for (let i = 0; i < MCP_CREATE_DRAFT_CAP_PER_WINDOW + 1; i++) {
      await runMcpWriteCall(draftCall(userId));
    }
    const read = await runMcpWriteCall(callFor(userId));
    expect(read.isError).toBeUndefined();
    expect(executeToolCall).toHaveBeenCalledTimes(1);
  });

  it("a draft refused by its own cap does not spend the shared budget", async () => {
    const userId = freshUser();
    for (let i = 0; i < MCP_CREATE_DRAFT_CAP_PER_WINDOW; i++)
      await runMcpWriteCall(draftCall(userId));
    for (let i = 0; i < 50; i++) await runMcpWriteCall(draftCall(userId));
    // 10 drafts spent 10 of the shared 30; the 50 refusals spent nothing, so 20 writes remain.
    for (let i = 0; i < MCP_WRITE_CAP_PER_WINDOW - MCP_CREATE_DRAFT_CAP_PER_WINDOW; i++) {
      const r = await runMcpWriteCall(callFor(userId));
      expect(r.isError, `write ${i + 1}`).toBeUndefined();
    }
    const over = await runMcpWriteCall(callFor(userId));
    expect(JSON.parse(over.content[0]?.text ?? "{}")).toMatchObject({ code: "RATE_LIMITED" });
  });

  it("the shared cap still bites a draft: 30 other writes leave no room for one", async () => {
    const userId = freshUser();
    for (let i = 0; i < MCP_WRITE_CAP_PER_WINDOW; i++) await runMcpWriteCall(callFor(userId));
    executeCreateDraft.mockClear();
    const over = await runMcpWriteCall(draftCall(userId));
    expect(JSON.parse(over.content[0]?.text ?? "{}")).toMatchObject({ code: "RATE_LIMITED" });
    expect(executeCreateDraft).not.toHaveBeenCalled();
  });

  it("the draft window slides: a minute later drafts are allowed again", async () => {
    const userId = freshUser();
    for (let i = 0; i < MCP_CREATE_DRAFT_CAP_PER_WINDOW; i++)
      await runMcpWriteCall(draftCall(userId));
    expect(consumeMcpWriteBudget(userId, Date.now(), "create_draft")).toBe(false);
    vi.advanceTimersByTime(MCP_WRITE_WINDOW_MS);
    expect(consumeMcpWriteBudget(userId, Date.now(), "create_draft")).toBe(true);
  });

  it("a tool with no own cap is governed by the shared cap alone", () => {
    const userId = freshUser();
    for (let i = 0; i < MCP_WRITE_CAP_PER_WINDOW; i++) {
      expect(consumeMcpWriteBudget(userId, Date.now(), "mark_read"), `call ${i + 1}`).toBe(true);
    }
    expect(consumeMcpWriteBudget(userId, Date.now(), "mark_read")).toBe(false);
  });
});
