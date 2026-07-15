/**
 * Locks down the three properties the deterministic floor depends on:
 *
 *   1. STABILITY — semantically identical payloads always hash the same,
 *      regardless of cosmetic whitespace in recipients, label order, or
 *      NFC/NFD Unicode normalization form.
 *
 *   2. SENSITIVITY — any one-character change to a payload field flips
 *      the hash. If the bytes mutate between approve and execute, the
 *      receipt MUST verify-fail. Silent passes here are the failure mode
 *      this whole module exists to prevent.
 *
 *   3. CROSS-ACTION REFUSAL — a receipt minted for one floor action
 *      cannot authorize a different floor action even if the recipient
 *      address happens to be the same. Schema version mismatch is also
 *      a verify-time failure.
 */

import { describe, expect, it } from "vitest";
import {
  ActionReceiptMismatchError,
  ActionReceiptSchemaError,
  deletePermanentPayloadHash,
  FLOOR_ACTIONS,
  forwardExternalPayloadHash,
  isFloorAction,
  mintReceipt,
  RECEIPT_SCHEMA_VERSION,
  sendEmailPayloadHash,
  verifyReceipt,
} from "../judge/attention-floor.js";

const approvedAt = new Date("2026-06-04T09:00:00Z");
const approvedBy = "approver@example.com";
const inputHash = "a".repeat(64);

describe("FLOOR_ACTIONS list discipline", () => {
  it("locks the doctrine list to three actions", () => {
    // If you're adding to this list, also: (1) write a justification of
    // why client-side undo is impossible, (2) add a matching *PayloadHash
    // function, (3) wire the new action into tool-executor refusal.
    expect(FLOOR_ACTIONS).toEqual(["send_email", "delete_permanent", "forward_external"]);
  });

  it.each(FLOOR_ACTIONS)("isFloorAction recognizes %s", (name) => {
    expect(isFloorAction(name)).toBe(true);
  });

  it.each([
    "archive",
    "trash",
    "label",
    "mark_read",
    "tier_override",
    "snooze",
    "create_event",
  ])("isFloorAction rejects reversible action %s", (name) => {
    expect(isFloorAction(name)).toBe(false);
  });
});

describe("sendEmailPayloadHash — stability", () => {
  const base = {
    to: "alice@example.com",
    subject: "Re: Q3 plan",
    body: "Sounds good — let's lock the Friday slot.",
  };

  it("hashes identical input identically", () => {
    expect(sendEmailPayloadHash(base)).toBe(sendEmailPayloadHash(base));
  });

  it("returns a 64-char hex digest", () => {
    expect(sendEmailPayloadHash(base)).toMatch(/^[0-9a-f]{64}$/);
  });

  it("normalizes cosmetic recipient differences (trim + lowercase)", () => {
    const a = sendEmailPayloadHash(base);
    const b = sendEmailPayloadHash({ ...base, to: "  Alice@Example.COM  " });
    expect(a).toBe(b);
  });

  it("treats NFC and NFD body the same", () => {
    const nfc = sendEmailPayloadHash({ ...base, body: "한국 미팅 확정" });
    const nfd = sendEmailPayloadHash({ ...base, body: "한국 미팅 확정".normalize("NFD") });
    expect(nfc).toBe(nfd);
  });
});

describe("sendEmailPayloadHash — sensitivity", () => {
  const base = {
    to: "alice@example.com",
    subject: "Re: Q3 plan",
    body: "Sounds good — let's lock the Friday slot.",
  };
  const baseline = sendEmailPayloadHash(base);

  it("flips when recipient changes", () => {
    expect(sendEmailPayloadHash({ ...base, to: "mallory@example.com" })).not.toBe(baseline);
  });

  it("flips when subject changes by one character", () => {
    expect(sendEmailPayloadHash({ ...base, subject: "Re: Q3 plans" })).not.toBe(baseline);
  });

  it("flips when body changes by one character", () => {
    expect(sendEmailPayloadHash({ ...base, body: `${base.body}.` })).not.toBe(baseline);
  });

  it("flips when body is empty vs whitespace", () => {
    expect(sendEmailPayloadHash({ ...base, body: "" })).not.toBe(
      sendEmailPayloadHash({ ...base, body: " " }),
    );
  });
});

describe("deletePermanentPayloadHash", () => {
  it("stable for same gmailId", () => {
    const h = deletePermanentPayloadHash({ gmailId: "abc123" });
    expect(h).toBe(deletePermanentPayloadHash({ gmailId: "abc123" }));
  });

  it("sensitive to gmailId change", () => {
    expect(deletePermanentPayloadHash({ gmailId: "abc123" })).not.toBe(
      deletePermanentPayloadHash({ gmailId: "abc124" }),
    );
  });

  it("distinct from sendEmailPayloadHash on the same gmailId string", () => {
    // Cross-action collision would be catastrophic — verify they're
    // schema-tagged differently so the same id never produces the same hash.
    const del = deletePermanentPayloadHash({ gmailId: "abc123" });
    const send = sendEmailPayloadHash({ to: "abc123", subject: "", body: "" });
    expect(del).not.toBe(send);
  });
});

describe("forwardExternalPayloadHash", () => {
  const base = { gmailId: "msg-1", to: "external@partner.com" };

  it("stable for same input", () => {
    expect(forwardExternalPayloadHash(base)).toBe(forwardExternalPayloadHash(base));
  });

  it("normalizes recipient", () => {
    expect(forwardExternalPayloadHash(base)).toBe(
      forwardExternalPayloadHash({ ...base, to: "  External@Partner.COM  " }),
    );
  });

  it("flips when gmailId changes", () => {
    expect(forwardExternalPayloadHash(base)).not.toBe(
      forwardExternalPayloadHash({ ...base, gmailId: "msg-2" }),
    );
  });

  it("flips when external recipient changes", () => {
    expect(forwardExternalPayloadHash(base)).not.toBe(
      forwardExternalPayloadHash({ ...base, to: "other@partner.com" }),
    );
  });
});

describe("verifyReceipt — happy path", () => {
  it("passes when receipt and current payload hash match", () => {
    const payloadHash = sendEmailPayloadHash({
      to: "alice@example.com",
      subject: "hi",
      body: "msg",
    });
    const receipt = mintReceipt({
      action: "send_email",
      inputHash,
      payloadHash,
      target: "alice@example.com",
      approvedAt,
      approvedBy,
    });
    expect(() =>
      verifyReceipt(receipt, { action: "send_email", currentPayloadHash: payloadHash }),
    ).not.toThrow();
  });
});

describe("verifyReceipt — refusal", () => {
  const payloadHash = sendEmailPayloadHash({
    to: "alice@example.com",
    subject: "hi",
    body: "msg",
  });
  const receipt = mintReceipt({
    action: "send_email",
    inputHash,
    payloadHash,
    target: "alice@example.com",
    approvedAt,
    approvedBy,
  });

  it("throws ActionReceiptMismatchError when payload mutates", () => {
    const mutated = sendEmailPayloadHash({
      to: "alice@example.com",
      subject: "hi",
      body: "msg2", // one-char mutation
    });
    expect(() =>
      verifyReceipt(receipt, { action: "send_email", currentPayloadHash: mutated }),
    ).toThrow(ActionReceiptMismatchError);
  });

  it("throws ActionReceiptMismatchError when the action class is wrong", () => {
    // A send_email receipt cannot authorize a delete_permanent — the schema
    // tags catch this even if recipient is the same address by coincidence.
    expect(() =>
      verifyReceipt(receipt, {
        action: "delete_permanent",
        currentPayloadHash: payloadHash,
      }),
    ).toThrow(ActionReceiptMismatchError);
  });

  it("throws ActionReceiptSchemaError when schema version doesn't match", () => {
    const stale = { ...receipt, v: "v0" as unknown as "v1" };
    expect(() =>
      verifyReceipt(stale, { action: "send_email", currentPayloadHash: payloadHash }),
    ).toThrow(ActionReceiptSchemaError);
  });
});

describe("mintReceipt", () => {
  it("returns the canonical shape with ISO approvedAt", () => {
    const receipt = mintReceipt({
      action: "send_email",
      inputHash,
      payloadHash: "b".repeat(64),
      target: "alice@example.com",
      approvedAt,
      approvedBy,
    });
    expect(receipt.v).toBe(RECEIPT_SCHEMA_VERSION);
    expect(receipt.action).toBe("send_email");
    expect(receipt.inputHash).toBe(inputHash);
    expect(receipt.target).toBe("alice@example.com");
    expect(receipt.approvedBy).toBe(approvedBy);
    expect(receipt.approvedAt).toBe(approvedAt.toISOString());
  });
});
