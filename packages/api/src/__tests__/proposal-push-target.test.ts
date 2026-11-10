/**
 * proposalPushMailFields — the native deep link of an approval push. Only a
 * reply draft (`send_email` + `in_reply_to_email_id` naming one of the user's
 * stored mails) gets `emailId` + `pendingActionId`; everything else is {} so
 * its push is byte-identical to before.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const findFirst = vi.hoisted(() => vi.fn());

vi.mock("../db.js", () => ({
  prisma: { emailMessage: { findFirst } },
  db: { emailMessage: { findFirst } },
}));

import { proposalPushMailFields } from "../agentcore/proposal-push-target.js";

beforeEach(() => {
  findFirst.mockReset();
});

describe("proposalPushMailFields", () => {
  it("links a reply draft to the stored mail it answers", async () => {
    findFirst.mockResolvedValue({ id: "em_1" });
    const out = await proposalPushMailFields(
      "u1",
      "send_email",
      { to: "a@example.com", subject: "Re: hi", body: "ok", in_reply_to_email_id: "gm_abc" },
      "pa_9",
    );
    expect(out).toEqual({ emailId: "em_1", pendingActionId: "pa_9" });
    // Scoped to the caller; accepts the Klorn row id or the provider id.
    expect(findFirst).toHaveBeenCalledWith({
      where: { userId: "u1", OR: [{ id: "gm_abc" }, { gmailId: "gm_abc" }] },
      select: { id: true },
    });
  });

  it("returns the server's row id, never the model's value", async () => {
    findFirst.mockResolvedValue({ id: "em_row" });
    const out = await proposalPushMailFields(
      "u1",
      "send_email",
      { in_reply_to_email_id: "  gm_provider  " },
      "pa_1",
    );
    expect(out.emailId).toBe("em_row");
    expect(findFirst.mock.calls[0]?.[0].where.OR[0]).toEqual({ id: "gm_provider" });
  });

  it("is {} when the id is not one of the user's mails", async () => {
    findFirst.mockResolvedValue(null);
    expect(
      await proposalPushMailFields("u1", "send_email", { in_reply_to_email_id: "x" }, "pa"),
    ).toEqual({});
  });

  it("is {} for a brand-new send (no in_reply_to_email_id) without a lookup", async () => {
    expect(await proposalPushMailFields("u1", "send_email", { to: "a@b.c" }, "pa")).toEqual({});
    expect(findFirst).not.toHaveBeenCalled();
  });

  it("is {} for any tool that is not send_email", async () => {
    for (const tool of ["archive_email", "reply_to_email", "create_event", "mark_read"]) {
      expect(
        await proposalPushMailFields("u1", tool, { in_reply_to_email_id: "gm_1" }, "pa"),
      ).toEqual({});
    }
    expect(findFirst).not.toHaveBeenCalled();
  });

  it("ignores malformed args", async () => {
    for (const args of [null, undefined, "str", 7, { in_reply_to_email_id: 5 }]) {
      expect(await proposalPushMailFields("u1", "send_email", args, "pa")).toEqual({});
    }
    expect(
      await proposalPushMailFields("u1", "send_email", { in_reply_to_email_id: "   " }, "pa"),
    ).toEqual({});
    expect(
      await proposalPushMailFields(
        "u1",
        "send_email",
        { in_reply_to_email_id: "x".repeat(201) },
        "pa",
      ),
    ).toEqual({});
    expect(findFirst).not.toHaveBeenCalled();
  });

  it("degrades to {} (push still goes out) when the lookup throws", async () => {
    findFirst.mockRejectedValue(new Error("db down"));
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    expect(
      await proposalPushMailFields("u1", "send_email", { in_reply_to_email_id: "gm" }, "pa"),
    ).toEqual({});
    warn.mockRestore();
  });
});
