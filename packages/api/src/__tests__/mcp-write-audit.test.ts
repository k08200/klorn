/**
 * MCP write audit — one row per write call. Allowed calls are inserted BEFORE
 * execution and a failed insert must surface (the caller then refuses the call);
 * refused calls are best-effort and must never throw.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const create = vi.hoisted(() => vi.fn());
const update = vi.hoisted(() => vi.fn());
const captureError = vi.hoisted(() => vi.fn());

vi.mock("../db.js", () => {
  const prisma = { mcpWriteAudit: { create, update } };
  return { prisma, db: prisma };
});
vi.mock("../sentry.js", () => ({ captureError }));

import {
  hashToolArgs,
  MAX_TARGET_ID_LENGTH,
  recordAllowedWrite,
  recordRefusedWrite,
  settleWriteAudit,
} from "../mcp/write-audit.js";

const BASE = { userId: "u1", apiKeyId: "k1", tool: "mark_read" };

beforeEach(() => {
  create.mockReset();
  update.mockReset();
  captureError.mockReset();
});

describe("hashToolArgs", () => {
  it("is SHA-256 hex over the canonical JSON: key order never matters", () => {
    const a = hashToolArgs({ email_id: "abc", extra: { y: 1, x: [1, 2] } });
    const b = hashToolArgs({ extra: { x: [1, 2], y: 1 }, email_id: "abc" });
    expect(a).toMatch(/^[0-9a-f]{64}$/);
    expect(a).toBe(b);
  });

  it("changes when a value, an array order or a key changes", () => {
    const base = hashToolArgs({ email_id: "abc", list: [1, 2] });
    expect(hashToolArgs({ email_id: "abd", list: [1, 2] })).not.toBe(base);
    expect(hashToolArgs({ email_id: "abc", list: [2, 1] })).not.toBe(base);
    expect(hashToolArgs({ email_id: "abc", list: [1, 2], more: true })).not.toBe(base);
  });

  it("hashes empty args, nulls and unicode without throwing", () => {
    expect(hashToolArgs({})).toMatch(/^[0-9a-f]{64}$/);
    expect(hashToolArgs({ a: null })).not.toBe(hashToolArgs({}));
    expect(hashToolArgs({ email_id: "메일-🙂-'; DROP TABLE" })).toMatch(/^[0-9a-f]{64}$/);
  });

  it("distinguishes a string that looks like JSON from the JSON itself", () => {
    expect(hashToolArgs({ a: "1" })).not.toBe(hashToolArgs({ a: 1 }));
  });
});

describe("recordAllowedWrite", () => {
  it("inserts an ok row with the target id and args hash, and returns the row id", async () => {
    create.mockResolvedValueOnce({ id: "audit-1" });
    const id = await recordAllowedWrite({ ...BASE, args: { email_id: "g-123" } });
    expect(id).toBe("audit-1");
    expect(create).toHaveBeenCalledTimes(1);
    expect(create).toHaveBeenCalledWith({
      data: {
        userId: "u1",
        apiKeyId: "k1",
        tool: "mark_read",
        targetId: "g-123",
        argsHash: hashToolArgs({ email_id: "g-123" }),
        outcome: "ok",
        reason: null,
      },
      select: { id: true },
    });
  });

  it("propagates an insert failure so the caller can refuse the write", async () => {
    create.mockRejectedValueOnce(new Error("db down"));
    await expect(recordAllowedWrite({ ...BASE, args: { email_id: "g" } })).rejects.toThrow(
      "db down",
    );
  });

  it("stores no target id when email_id is missing, not a string, blank or oversized", async () => {
    const cases: Record<string, unknown>[] = [
      {},
      { email_id: 42 },
      { email_id: "   " },
      { email_id: "x".repeat(MAX_TARGET_ID_LENGTH + 1) },
      { email_id: { $ne: null } },
    ];
    for (const args of cases) {
      create.mockResolvedValueOnce({ id: "a" });
      await recordAllowedWrite({ ...BASE, args });
      const data = (create.mock.calls.at(-1)?.[0] as { data: { targetId: unknown } }).data;
      expect(data.targetId, JSON.stringify(args).slice(0, 40)).toBeNull();
    }
  });

  it("accepts an id exactly at the length bound", async () => {
    create.mockResolvedValueOnce({ id: "a" });
    const email_id = "x".repeat(MAX_TARGET_ID_LENGTH);
    await recordAllowedWrite({ ...BASE, args: { email_id } });
    expect((create.mock.calls[0]?.[0] as { data: { targetId: unknown } }).data.targetId).toBe(
      email_id,
    );
  });
});

describe("recordRefusedWrite", () => {
  it("inserts a refused row carrying the reason", async () => {
    create.mockResolvedValueOnce({ id: "r1" });
    await recordRefusedWrite({ ...BASE, args: { email_id: "g" }, reason: "permission_denied" });
    expect(create).toHaveBeenCalledWith({
      data: expect.objectContaining({ outcome: "refused", reason: "permission_denied" }),
      select: { id: true },
    });
  });

  it("never throws: an insert failure is reported, not surfaced", async () => {
    create.mockRejectedValueOnce(new Error("db down"));
    await expect(
      recordRefusedWrite({ ...BASE, args: {}, reason: "permission_denied" }),
    ).resolves.toBeUndefined();
    expect(captureError).toHaveBeenCalledTimes(1);
  });
});

describe("settleWriteAudit", () => {
  it("downgrades the pre-inserted row to error with a reason", async () => {
    update.mockResolvedValueOnce({});
    await settleWriteAudit("audit-1", "tool_error");
    expect(update).toHaveBeenCalledWith({
      where: { id: "audit-1" },
      data: { outcome: "error", reason: "tool_error" },
    });
  });

  it("never throws", async () => {
    update.mockRejectedValueOnce(new Error("db down"));
    await expect(settleWriteAudit("audit-1", "exception")).resolves.toBeUndefined();
    expect(captureError).toHaveBeenCalledTimes(1);
  });
});
