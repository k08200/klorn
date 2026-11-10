/**
 * send-receipt.ts — the deterministic floor for user-initiated sends
 * (MANUAL_SEND_RECEIPTS_ENABLED, OFF by default).
 *   - flag off: no row, no hash work, the routes behave as before;
 *   - flag on: an ActionReceipt (attention-floor.ts, schema v1) over
 *     sendEmailPayloadHash({ to, subject, body }) is written BEFORE the send and
 *     a write failure propagates (the route refuses to send);
 *   - the bytes handed to the provider are verified against it (mismatch throws);
 *   - the settle is user-scoped and fail-soft: the mail already went out.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  ActionReceiptMismatchError,
  RECEIPT_SCHEMA_VERSION,
  sendEmailPayloadHash,
} from "../judge/attention-floor.js";

const create = vi.hoisted(() => vi.fn());
const updateMany = vi.hoisted(() => vi.fn());
const captureError = vi.hoisted(() => vi.fn());

vi.mock("../db.js", () => {
  const prisma = { sendReceipt: { create, updateMany } };
  return { prisma, db: prisma };
});
vi.mock("../sentry.js", () => ({ captureError }));

const {
  openSendReceipt,
  assertSendMatchesReceipt,
  verifySendOrRefuse,
  settleSendReceipt,
  sendReceiptWire,
  outcomeOfSend,
} = await import("../mail/send-receipt.js");

const INPUT = {
  userId: "user-1",
  route: "send" as const,
  to: "Alice@Example.com ",
  subject: "Hi",
  body: "Hello",
  inbox: "primary",
};

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubEnv("MANUAL_SEND_RECEIPTS_ENABLED", "true");
  create.mockImplementation(async (args: { data: Record<string, unknown> }) => ({
    id: "rcpt-1",
    ...args.data,
  }));
  updateMany.mockResolvedValue({ count: 1 });
});

afterEach(() => vi.unstubAllEnvs());

describe("flag off", () => {
  it("writes nothing and returns null", async () => {
    vi.stubEnv("MANUAL_SEND_RECEIPTS_ENABLED", "");
    expect(await openSendReceipt(INPUT)).toBeNull();
    expect(create).not.toHaveBeenCalled();
  });
});

describe("openSendReceipt", () => {
  it("mints a v1 send_email receipt over the exact bytes and persists it as PENDING", async () => {
    const handle = await openSendReceipt({ ...INPUT, emailId: undefined });
    const payloadHash = sendEmailPayloadHash({ to: INPUT.to, subject: "Hi", body: "Hello" });
    expect(handle).toMatchObject({ id: "rcpt-1" });
    expect(handle?.receipt).toEqual({
      v: RECEIPT_SCHEMA_VERSION,
      action: "send_email",
      inputHash: "",
      payloadHash,
      target: "alice@example.com",
      approvedAt: expect.any(String),
      approvedBy: "user-1",
    });
    expect(create).toHaveBeenCalledWith({
      data: {
        userId: "user-1",
        route: "send",
        action: "send_email",
        payloadHash,
        receipt: handle?.receipt,
        inbox: "primary",
        emailId: null,
        status: "PENDING",
      },
      select: { id: true },
    });
  });

  it("records the reply's source email and the account it leaves from", async () => {
    await openSendReceipt({ ...INPUT, route: "reply", inbox: "li-1", emailId: "e1" });
    expect(create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ route: "reply", inbox: "li-1", emailId: "e1" }),
      }),
    );
  });

  it("a failed write propagates: no receipt, no send", async () => {
    create.mockRejectedValue(new Error("db down"));
    await expect(openSendReceipt(INPUT)).rejects.toThrow("db down");
  });
});

describe("assertSendMatchesReceipt", () => {
  it("passes for the approved bytes (cosmetic recipient edits included) and throws for others", async () => {
    const handle = await openSendReceipt(INPUT);
    if (!handle) throw new Error("expected a receipt");
    expect(() =>
      assertSendMatchesReceipt(handle, { to: "alice@example.com", subject: "Hi", body: "Hello" }),
    ).not.toThrow();
    expect(() =>
      assertSendMatchesReceipt(handle, { to: "alice@example.com", subject: "Hi", body: "Hello!" }),
    ).toThrow(ActionReceiptMismatchError);
    expect(() =>
      assertSendMatchesReceipt(handle, { to: "mallory@example.com", subject: "Hi", body: "Hello" }),
    ).toThrow(ActionReceiptMismatchError);
  });
});

describe("verifySendOrRefuse", () => {
  it("a mismatch settles the receipt REFUSED (nothing left) and propagates", async () => {
    const handle = await openSendReceipt(INPUT);
    if (!handle) throw new Error("expected a receipt");
    await expect(
      verifySendOrRefuse(handle, "user-1", { to: INPUT.to, subject: "Hi", body: "Edited" }),
    ).rejects.toThrow(ActionReceiptMismatchError);
    expect(updateMany).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ status: "REFUSED" }) }),
    );
  });

  it("the approved bytes pass and settle nothing", async () => {
    const handle = await openSendReceipt(INPUT);
    if (!handle) throw new Error("expected a receipt");
    await verifySendOrRefuse(handle, "user-1", { to: INPUT.to, subject: "Hi", body: "Hello" });
    expect(updateMany).not.toHaveBeenCalled();
  });
});

describe("outcomeOfSend", () => {
  it("maps a provider result to the receipt outcome", () => {
    expect(outcomeOfSend({ success: true, messageId: "m1" })).toEqual({
      status: "SENT",
      providerMessageId: "m1",
    });
    expect(outcomeOfSend({ success: true })).toEqual({ status: "SENT", providerMessageId: null });
    expect(outcomeOfSend({ error: "no" })).toEqual({ status: "REFUSED" });
    expect(outcomeOfSend({ unsupported: true, error: "no" })).toEqual({ status: "REFUSED" });
  });
});

describe("settleSendReceipt", () => {
  it("settles by id AND owner with the outcome", async () => {
    const handle = await openSendReceipt(INPUT);
    if (!handle) throw new Error("expected a receipt");
    await settleSendReceipt(handle, "user-1", { status: "SENT", providerMessageId: "sent-1" });
    expect(updateMany).toHaveBeenCalledWith({
      where: { id: "rcpt-1", userId: "user-1", status: "PENDING" },
      data: { status: "SENT", providerMessageId: "sent-1", completedAt: expect.any(Date) },
    });
  });

  it("is fail-soft: a settle error is reported, never thrown (the mail already went out)", async () => {
    const handle = await openSendReceipt(INPUT);
    if (!handle) throw new Error("expected a receipt");
    updateMany.mockRejectedValue(new Error("db down"));
    await expect(
      settleSendReceipt(handle, "user-1", { status: "REFUSED" }),
    ).resolves.toBeUndefined();
    expect(captureError).toHaveBeenCalled();
  });
});

describe("sendReceiptWire", () => {
  it("exposes the id, schema, action, payload hash and approval time — no recipient", async () => {
    const handle = await openSendReceipt(INPUT);
    if (!handle) throw new Error("expected a receipt");
    expect(sendReceiptWire(handle)).toEqual({
      id: "rcpt-1",
      v: "v1",
      action: "send_email",
      payloadHash: handle.receipt.payloadHash,
      approvedAt: handle.receipt.approvedAt,
    });
  });
});
