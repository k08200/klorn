import { describe, expect, it, vi } from "vitest";
import { purgeUserData } from "../purge-user-data.js";

function makeTxSpy() {
  const called = new Set<string>();
  const scopes: unknown[] = [];
  const updates: {
    model: string;
    arg: { where: Record<string, unknown>; data: Record<string, unknown> };
  }[] = [];
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
          updateMany: vi.fn(async (arg: never) => {
            updates.push({ model, arg });
            return { count: 0 };
          }),
        };
      },
    },
  );
  return { tx, called, scopes, updates };
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
      // D5a: a linked Google Drive / OneDrive account's OAuth tokens and address.
      "linkedDriveAccount",
      "senderTrait",
      "senderLabel",
      "sentMessage",
      "sendReceipt",
      "imapMovedMessage",
      "mcpWriteAudit",
      "userToken",
      "emailMessage",
      "emailAttachment",
      "calendarEvent",
      "driveFile",
      "driveFileSummary",
      "driveSummaryUsage",
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

  it("revokes (never deletes) the user's API keys, so a purged account cannot be read by an old key", async () => {
    const { tx, called, updates } = makeTxSpy();
    await purgeUserData(tx as never, "u-7");
    expect(called.has("apiKey")).toBe(false);
    const revocations = updates.filter((u) => u.model === "apiKey");
    expect(revocations).toHaveLength(1);
    expect(revocations[0]?.arg.where).toEqual({ userId: "u-7", revokedAt: null });
    expect(revocations[0]?.arg.data.revokedAt).toBeInstanceOf(Date);
    // Only the api key table is revoked here; nothing else is updated.
    expect(updates.map((u) => u.model)).toEqual(["apiKey"]);
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

describe("purgeUserData covers every user-scoped model (schema-driven guard)", () => {
  // Rows that stay with the account on a data wipe, each for a reason. A new
  // model with a userId must be purged or listed here, or this test fails.
  const KEPT_WITH_ACCOUNT: Record<string, string> = {
    userIdentity: "sign-in methods: deleting them locks the user out of the kept account",
    team: "account structure shared with other members, not data obtained from mail",
    storagePurge: "the durable queue that deletes the user's stored objects: must survive",
    apiKey: "revoked (updateMany), never deleted, so audit rows keep their key",
  };

  it("deletes or deliberately keeps every model that has a userId", async () => {
    const { readFileSync } = await import("node:fs");
    const { fileURLToPath } = await import("node:url");
    const schema = readFileSync(
      fileURLToPath(new URL("../../prisma/schema.prisma", import.meta.url)),
      "utf8",
    );
    const userScoped = [...schema.matchAll(/^model (\w+) \{([\s\S]*?)^\}/gm)]
      .filter(([, , body]) => /^\s+userId\s+String/m.test(body ?? ""))
      .map(([, name]) => (name ?? "").charAt(0).toLowerCase() + (name ?? "").slice(1));

    const { tx, called, updates } = makeTxSpy();
    await purgeUserData(tx as never, "u1");
    const revoked = new Set(updates.map((u) => u.model));

    const uncovered = userScoped.filter(
      (model) => !called.has(model) && !revoked.has(model) && !(model in KEPT_WITH_ACCOUNT),
    );
    expect(uncovered).toEqual([]);
    expect(userScoped.length).toBeGreaterThan(50);
  });
});
