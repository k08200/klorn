/**
 * MCP write audit — one row per write call. An allowed call is inserted as
 * `attempted` BEFORE execution and a failed insert must surface (the caller then
 * refuses the call); it is settled to ok/error afterwards. A refused call is
 * best-effort: it never throws, does nothing at all while the flag is off, and is
 * throttled per (key, tool, reason) so a key holder cannot drive unbounded inserts.
 */

import crypto from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const create = vi.hoisted(() => vi.fn());
const update = vi.hoisted(() => vi.fn());
const captureError = vi.hoisted(() => vi.fn());

vi.mock("../db.js", () => {
  const prisma = { mcpWriteAudit: { create, update } };
  return { prisma, db: prisma };
});
vi.mock("../sentry.js", () => ({ captureError }));

import {
  droppedRefusedAuditCount,
  hashToolArgs,
  MAX_ARGS_DEPTH,
  MAX_HASHED_ARGS_BYTES,
  MAX_TARGET_ID_LENGTH,
  REFUSED_AUDIT_WINDOW_MS,
  recordAllowedWrite,
  recordRefusedWrite,
  settleWriteAudit,
} from "../mcp/write-audit.js";

let seq = 0;
/** Fresh key id per test: the refused-audit throttle lives in module state. */
const freshInput = (args: Record<string, unknown> = {}) => ({
  userId: "u1",
  apiKeyId: `k-audit-${++seq}`,
  tool: "mark_read",
  args,
});

const sha256 = (text: string) => crypto.createHash("sha256").update(text).digest("hex");

function nested(depth: number): Record<string, unknown> {
  let value: Record<string, unknown> = { leaf: true };
  for (let i = 1; i < depth; i++) value = { child: value };
  return value;
}

beforeEach(() => {
  create.mockReset();
  update.mockReset();
  captureError.mockReset();
  create.mockResolvedValue({ id: "row-1" });
  update.mockResolvedValue({});
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-09-30T10:00:00.000Z"));
  vi.stubEnv("MCP_WRITE_TOOLS_ENABLED", "true");
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
});

describe("hashToolArgs", () => {
  it("matches a golden vector: SHA-256 of the canonical JSON, computed independently", () => {
    expect(hashToolArgs({ email_id: "18c3f0a1b2c3d4e5" })).toBe(
      "1addafcf0c4fb0cf266d6db76cc3cbd5e3f40704409fc626fb3f82a18a82a0b8",
    );
    expect(hashToolArgs({ email_id: "18c3f0a1b2c3d4e5" })).toBe(
      sha256('{"email_id":"18c3f0a1b2c3d4e5"}'),
    );
  });

  it("ignores key order at every depth", () => {
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

  it("hashes empty args, nulls, unicode and NUL bytes without throwing", () => {
    expect(hashToolArgs({})).toBe(sha256("{}"));
    expect(hashToolArgs({ a: null })).not.toBe(hashToolArgs({}));
    expect(hashToolArgs({ email_id: "메일-🙂-'; DROP TABLE" })).toMatch(/^[0-9a-f]{64}$/);
    expect(hashToolArgs({ email_id: "a\u0000b" })).toBe(sha256('{"email_id":"a\\u0000b"}'));
  });

  it("hashes content up to the size bound and a marker plus the length beyond it", () => {
    // '{"a":"' + value + '"}' is 8 bytes of overhead around the value.
    const atBound = { a: "x".repeat(MAX_HASHED_ARGS_BYTES - 8) };
    expect(hashToolArgs(atBound)).toBe(sha256(`{"a":"${"x".repeat(MAX_HASHED_ARGS_BYTES - 8)}"}`));

    const over = { a: "x".repeat(MAX_HASHED_ARGS_BYTES - 7) };
    const overBytes = MAX_HASHED_ARGS_BYTES + 1;
    expect(hashToolArgs(over)).toBe(sha256(`klorn:mcp-args:oversize:${overBytes}`));
    // Content is deliberately not hashed past the bound: same length, same hash.
    expect(hashToolArgs({ a: "y".repeat(MAX_HASHED_ARGS_BYTES - 7) })).toBe(hashToolArgs(over));
  });

  it("measures the size bound in bytes, not characters", () => {
    const multibyte = { a: "🙂".repeat(MAX_HASHED_ARGS_BYTES / 4) };
    expect(hashToolArgs(multibyte)).toMatch(/^[0-9a-f]{64}$/);
    expect(hashToolArgs(multibyte)).toBe(
      sha256(`klorn:mcp-args:oversize:${8 + MAX_HASHED_ARGS_BYTES}`),
    );
  });

  it("hashes nesting up to the depth bound and a fixed marker beyond it, never throwing", () => {
    expect(hashToolArgs(nested(MAX_ARGS_DEPTH))).not.toBe(sha256("klorn:mcp-args:too-deep"));
    const tooDeep = hashToolArgs(nested(MAX_ARGS_DEPTH + 1));
    expect(tooDeep).toBe(sha256("klorn:mcp-args:too-deep"));
    expect(hashToolArgs(nested(50_000))).toBe(tooDeep);
  });

  it("survives a cyclic structure and values JSON cannot carry", () => {
    const cyclic: Record<string, unknown> = { a: 1 };
    cyclic.self = cyclic;
    expect(hashToolArgs(cyclic)).toBe(sha256("klorn:mcp-args:too-deep"));
    expect(hashToolArgs({ n: BigInt(1) })).toBe(sha256("klorn:mcp-args:unhashable"));
  });
});

describe("recordAllowedWrite", () => {
  it("inserts an `attempted` row with the target id and args hash, and returns the row id", async () => {
    create.mockResolvedValueOnce({ id: "audit-1" });
    const input = freshInput({ email_id: "g-123" });
    const id = await recordAllowedWrite(input);
    expect(id).toBe("audit-1");
    expect(create).toHaveBeenCalledTimes(1);
    expect(create).toHaveBeenCalledWith({
      data: {
        userId: "u1",
        apiKeyId: input.apiKeyId,
        tool: "mark_read",
        targetId: "g-123",
        argsHash: hashToolArgs({ email_id: "g-123" }),
        outcome: "attempted",
        reason: null,
      },
      select: { id: true },
    });
  });

  it("propagates an insert failure so the caller can refuse the write", async () => {
    create.mockRejectedValueOnce(new Error("db down"));
    await expect(recordAllowedWrite(freshInput({ email_id: "g" }))).rejects.toThrow("db down");
  });

  it("stores a target id only when it is 1-256 chars of [A-Za-z0-9_-]", async () => {
    const stored: [unknown, string | null][] = [
      ["g-123_AB", "g-123_AB"],
      ["x", "x"],
      ["x".repeat(MAX_TARGET_ID_LENGTH), "x".repeat(MAX_TARGET_ID_LENGTH)],
      ["x".repeat(MAX_TARGET_ID_LENGTH + 1), null],
      ["", null],
      ["   ", null],
      [" g1", null],
      ["g 1", null],
      ["g\u0000x", null],
      ["g\n1", null],
      ["g/../1", null],
      ["메일", null],
      [42, null],
      [{ $ne: null }, null],
      [undefined, null],
    ];
    for (const [email_id, expected] of stored) {
      create.mockResolvedValueOnce({ id: "a" });
      await recordAllowedWrite(freshInput({ email_id }));
      const data = (create.mock.calls.at(-1)?.[0] as { data: { targetId: unknown } }).data;
      expect(data.targetId, JSON.stringify(email_id)?.slice(0, 40)).toBe(expected);
    }
  });

  it("does not throw on hostile args: deep, huge or NUL-laden", async () => {
    for (const args of [
      nested(10_000),
      { email_id: "g", blob: "z".repeat(1_000_000) },
      { email_id: "a\u0000b", other: "\u0000".repeat(100) },
    ]) {
      create.mockResolvedValueOnce({ id: "a" });
      await expect(recordAllowedWrite(freshInput(args))).resolves.toBe("a");
    }
  });
});

describe("recordRefusedWrite", () => {
  it("inserts a refused row carrying the reason", async () => {
    const input = freshInput({ email_id: "g" });
    await recordRefusedWrite({ ...input, reason: "permission_denied" });
    expect(create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        outcome: "refused",
        reason: "permission_denied",
        apiKeyId: input.apiKeyId,
      }),
      select: { id: true },
    });
  });

  it("does nothing at all while the flag is off: no insert, no throttle slot spent", async () => {
    vi.stubEnv("MCP_WRITE_TOOLS_ENABLED", "false");
    const input = { ...freshInput(), reason: "permission_denied" as const };
    const dropped = droppedRefusedAuditCount();
    await recordRefusedWrite(input);
    await recordRefusedWrite({ ...input, reason: "rate_limited" });
    expect(create).not.toHaveBeenCalled();
    expect(droppedRefusedAuditCount()).toBe(dropped);
    // Flag flips on: the very first refusal is recorded (the slot was not spent).
    vi.stubEnv("MCP_WRITE_TOOLS_ENABLED", "true");
    await recordRefusedWrite(input);
    expect(create).toHaveBeenCalledTimes(1);
  });

  it("records at most one row per (key, tool, reason) per window and counts the drops", async () => {
    const input = { ...freshInput({ email_id: "g" }), reason: "permission_denied" as const };
    const before = droppedRefusedAuditCount();
    for (let i = 0; i < 100; i++) await recordRefusedWrite(input);
    expect(create).toHaveBeenCalledTimes(1);
    expect(droppedRefusedAuditCount() - before).toBe(99);

    vi.advanceTimersByTime(REFUSED_AUDIT_WINDOW_MS - 1);
    await recordRefusedWrite(input);
    expect(create).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(1);
    await recordRefusedWrite(input);
    expect(create).toHaveBeenCalledTimes(2);
  });

  it("throttles each key, tool and reason independently", async () => {
    const a = { ...freshInput(), reason: "permission_denied" as const };
    await recordRefusedWrite(a);
    await recordRefusedWrite({ ...a, apiKeyId: `${a.apiKeyId}-other` });
    await recordRefusedWrite({ ...a, tool: "set_tier" });
    await recordRefusedWrite({ ...a, reason: "rate_limited" });
    expect(create).toHaveBeenCalledTimes(4);
    await recordRefusedWrite(a);
    expect(create).toHaveBeenCalledTimes(4);
  });

  it("never throws: an insert failure is reported with user and key, not surfaced", async () => {
    create.mockRejectedValueOnce(new Error("db down"));
    const input = { ...freshInput(), reason: "permission_denied" as const };
    await expect(recordRefusedWrite(input)).resolves.toBeUndefined();
    expect(captureError).toHaveBeenCalledTimes(1);
    expect(captureError.mock.calls[0]?.[1]).toMatchObject({
      extra: { userId: "u1", apiKeyId: input.apiKeyId, tool: "mark_read" },
    });
  });
});

describe("settleWriteAudit", () => {
  const input = () => freshInput({ email_id: "g" });

  it("settles a successful call to ok", async () => {
    await settleWriteAudit(input(), "audit-1", { outcome: "ok" });
    expect(update).toHaveBeenCalledWith({
      where: { id: "audit-1" },
      data: { outcome: "ok", reason: null },
    });
  });

  it("settles a failed call to error with its reason", async () => {
    await settleWriteAudit(input(), "audit-1", { outcome: "error", reason: "tool_error" });
    expect(update).toHaveBeenCalledWith({
      where: { id: "audit-1" },
      data: { outcome: "error", reason: "tool_error" },
    });
    await settleWriteAudit(input(), "audit-2", { outcome: "error", reason: "exception" });
    expect(update).toHaveBeenLastCalledWith({
      where: { id: "audit-2" },
      data: { outcome: "error", reason: "exception" },
    });
  });

  it("never throws; the failure is reported with user, key and row", async () => {
    update.mockRejectedValueOnce(new Error("db down"));
    const i = input();
    await expect(settleWriteAudit(i, "audit-1", { outcome: "ok" })).resolves.toBeUndefined();
    expect(captureError).toHaveBeenCalledTimes(1);
    expect(captureError.mock.calls[0]?.[1]).toMatchObject({
      extra: { userId: "u1", apiKeyId: i.apiKeyId, auditId: "audit-1" },
    });
  });
});
