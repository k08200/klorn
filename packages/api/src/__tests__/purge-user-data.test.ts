import { describe, expect, it, vi } from "vitest";
import { purgeUserData } from "../purge-user-data.js";

function makeTxSpy() {
  const called = new Set<string>();
  const scopes: unknown[] = [];
  const tx = new Proxy(
    {},
    {
      get(_t, model: string) {
        return {
          deleteMany: vi.fn(async (arg: unknown) => {
            called.add(model);
            scopes.push(arg);
            return { count: 0 };
          }),
        };
      },
    },
  );
  return { tx, called, scopes };
}

describe("purgeUserData", () => {
  it("deletes every CASA-critical user-scoped table (complete-deletion guard)", async () => {
    const { tx, called } = makeTxSpy();
    await purgeUserData(tx as never, "u1");

    // Google API data (linked-account OAuth tokens, verbatim mail content) MUST
    // be purged — these regressed before. A dropped table fails this test.
    const required = [
      "linkedInboxAccount",
      "linkedCalendarAccount",
      "senderTrait",
      "userToken",
      "emailMessage",
      "emailAttachment",
      "calendarEvent",
      "devicePushToken",
      "emailProcessingLog",
      "learnedRule",
      "contactEngagementScore",
      "contactTrustScore",
      "conversationSummary",
      "message",
      "conversation",
      "notification",
      "memory",
    ];
    for (const model of required) {
      expect(called.has(model), `purgeUserData must delete ${model}`).toBe(true);
    }
  });

  it("scopes every delete to the target user (directly or via conversation)", async () => {
    const { tx, scopes } = makeTxSpy();
    await purgeUserData(tx as never, "u-42");
    expect(scopes.length).toBeGreaterThan(20);
    for (const s of scopes) {
      const where = (s as { where?: Record<string, unknown> }).where ?? {};
      const direct = where.userId === "u-42";
      const viaConversation =
        (where.conversation as { userId?: string } | undefined)?.userId === "u-42";
      expect(direct || viaConversation).toBe(true);
    }
  });
});
