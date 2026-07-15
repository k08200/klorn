/**
 * P0-B slice 1 (write): dismissing an EMAIL firewall item records the negative
 * half of the contact-engagement graph — dismissCount for the sender. Before
 * this, recordContactEngagement's "dismiss" branch had no caller, so dismissCount
 * sat at 0 forever and the "dismisses −" the config documents never accumulated.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const findFirst = vi.fn();
const update = vi.fn();
const findUnique = vi.fn();
const recordFeedback = vi.fn();
const recordContactEngagement = vi.fn();

vi.mock("../db.js", () => ({
  prisma: {
    attentionItem: { findFirst: (a: unknown) => findFirst(a), update: (a: unknown) => update(a) },
    emailMessage: { findUnique: (a: unknown) => findUnique(a) },
  },
}));
vi.mock("../learning/feedback.js", () => ({ recordFeedback: (a: unknown) => recordFeedback(a) }));
vi.mock("../learning/contact-engagement.js", () => ({
  recordContactEngagement: (u: string, e: string, k: string) => recordContactEngagement(u, e, k),
}));

import { dismissAttentionItem } from "../attention-dismiss.js";

describe("dismissAttentionItem — per-sender dismiss engagement", () => {
  beforeEach(() => {
    findFirst.mockReset();
    update.mockReset();
    findUnique.mockReset();
    recordFeedback.mockReset();
    recordContactEngagement.mockReset();
    update.mockResolvedValue({});
  });

  it("records a 'dismiss' engagement for the sender of an EMAIL item", async () => {
    findFirst.mockResolvedValue({ id: "i1", source: "EMAIL", sourceId: "email-1" });
    findUnique.mockResolvedValue({ from: "Vercel <noreply@vercel.com>" });

    const res = await dismissAttentionItem("u1", "i1");

    expect(res).toEqual({ ok: true });
    expect(findUnique).toHaveBeenCalledWith({
      where: { id: "email-1" },
      select: { from: true },
    });
    expect(recordContactEngagement).toHaveBeenCalledTimes(1);
    expect(recordContactEngagement).toHaveBeenCalledWith("u1", "noreply@vercel.com", "dismiss");
  });

  it("does NOT record engagement for a non-EMAIL item", async () => {
    findFirst.mockResolvedValue({ id: "i2", source: "CALENDAR_EVENT", sourceId: "evt-1" });

    await dismissAttentionItem("u1", "i2");

    expect(findUnique).not.toHaveBeenCalled();
    expect(recordContactEngagement).not.toHaveBeenCalled();
  });

  it("does NOT record engagement when the item isn't the user's", async () => {
    findFirst.mockResolvedValue(null);

    const res = await dismissAttentionItem("u1", "i3");

    expect(res).toEqual({ ok: false, reason: "not_found" });
    expect(recordContactEngagement).not.toHaveBeenCalled();
  });

  it("still records the feedback signal (existing behaviour preserved)", async () => {
    findFirst.mockResolvedValue({ id: "i1", source: "EMAIL", sourceId: "email-1" });
    findUnique.mockResolvedValue({ from: "noreply@vercel.com" });

    await dismissAttentionItem("u1", "i1");

    expect(recordFeedback).toHaveBeenCalledTimes(1);
    expect(recordFeedback.mock.calls[0][0]).toMatchObject({
      userId: "u1",
      source: "ATTENTION_ITEM",
      sourceId: "i1",
      signal: "DISMISSED",
    });
  });
});
