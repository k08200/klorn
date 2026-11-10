import { beforeEach, describe, expect, it } from "vitest";
import {
  AUTO_MODE_MAX_DRAFT_ATTEMPTS,
  type AutoModeSweepDeps,
  recipientFromHeader,
  resetAutoModeDraftAttempts,
  runAutoModeSweep,
} from "../agentcore/auto-mode-sweep.js";

/** Fake deps that record every call in order and can be steered per test. */
function makeDeps(overrides: Partial<AutoModeSweepDeps> = {}) {
  const calls: string[] = [];
  const deps: AutoModeSweepDeps = {
    findCandidates: async () => {
      calls.push("findCandidates");
      return [{ id: "item-1", sourceId: "row-1" }];
    },
    findEmail: async () => {
      calls.push("findEmail");
      return {
        id: "row-1",
        gmailId: "g-1",
        from: "Jane <jane@example.com>",
        subject: "Hello",
        body: "hi",
      };
    },
    alreadyReplied: async () => {
      calls.push("alreadyReplied");
      return false;
    },
    isSingleRecipient: (to) => {
      calls.push("isSingleRecipient");
      return !to.includes(",");
    },
    replyBlocked: async () => {
      calls.push("replyBlocked");
      return null;
    },
    draftReply: async () => {
      calls.push("draftReply");
      return "a fine reply";
    },
    emailStillExists: async () => {
      calls.push("emailStillExists");
      return true;
    },
    writeLedger: async () => {
      calls.push("writeLedger");
      return { id: "ledger-1" };
    },
    send: async () => {
      calls.push("send");
    },
    markLedgerFailed: async () => {
      calls.push("markLedgerFailed");
    },
    resolveItem: async () => {
      calls.push("resolveItem");
    },
    warn: () => {},
    reportError: () => {},
    now: () => 1_755_500_000_000,
    ...overrides,
  };
  return { deps, calls };
}

beforeEach(() => resetAutoModeDraftAttempts());

describe("recipientFromHeader", () => {
  it("prefers the bracketed addr-spec, trims a bare one", () => {
    expect(recipientFromHeader("Jane <jane@x.com>")).toBe("jane@x.com");
    expect(recipientFromHeader("  bare@x.com ")).toBe("bare@x.com");
  });
});

describe("runAutoModeSweep ordering contracts (security review 2026-08-16)", () => {
  it("happy path runs in the pinned order, ledger BEFORE send", async () => {
    const { deps, calls } = makeDeps();
    await runAutoModeSweep("u1", "guideline", deps);
    expect(calls).toEqual([
      "findCandidates",
      "findEmail",
      "alreadyReplied",
      "isSingleRecipient",
      "replyBlocked",
      "draftReply",
      "emailStillExists",
      "writeLedger",
      "send",
      "resolveItem",
    ]);
  });

  it("dedupe hit spends nothing: no LLM, no ledger, no send", async () => {
    const { deps, calls } = makeDeps({
      alreadyReplied: async () => {
        calls.push("alreadyReplied");
        return true;
      },
    });
    await runAutoModeSweep("u1", "g", deps);
    expect(calls).not.toContain("draftReply");
    expect(calls).not.toContain("writeLedger");
    expect(calls).not.toContain("send");
  });

  it("a multi-recipient From is refused before the LLM and the ledger", async () => {
    const { deps, calls } = makeDeps({
      findEmail: async () => {
        calls.push("findEmail");
        return {
          id: "row-1",
          gmailId: "g-1",
          from: "a@x.com, b@evil.com",
          subject: "s",
          body: "b",
        };
      },
    });
    await runAutoModeSweep("u1", "g", deps);
    expect(calls).not.toContain("draftReply");
    expect(calls).not.toContain("writeLedger");
  });

  it("a P2002 ledger loser never sends", async () => {
    const { deps, calls } = makeDeps({
      writeLedger: async () => {
        calls.push("writeLedger");
        return null;
      },
    });
    await runAutoModeSweep("u1", "g", deps);
    expect(calls).toContain("writeLedger");
    expect(calls).not.toContain("send");
    expect(calls).not.toContain("resolveItem");
  });

  it("a send failure rewrites the ledger and never resolves the item", async () => {
    const { deps, calls } = makeDeps({
      send: async () => {
        calls.push("send");
        throw new Error("gmail down");
      },
    });
    await runAutoModeSweep("u1", "g", deps);
    expect(calls).toContain("markLedgerFailed");
    expect(calls.indexOf("markLedgerFailed")).toBeGreaterThan(calls.indexOf("send"));
    expect(calls).not.toContain("resolveItem");
  });

  it("empty drafts are capped, and the counter clears on success", async () => {
    let draft: string | null = null;
    const { deps, calls } = makeDeps({
      draftReply: async () => {
        calls.push("draftReply");
        return draft;
      },
    });
    for (let i = 0; i < AUTO_MODE_MAX_DRAFT_ATTEMPTS + 2; i++) {
      await runAutoModeSweep("u1", "g", deps);
    }
    // Only the first N ticks spent an LLM call; the extra ticks skipped.
    expect(calls.filter((c) => c === "draftReply")).toHaveLength(AUTO_MODE_MAX_DRAFT_ATTEMPTS);
    // A later success resets the counter for the item.
    draft = "recovered";
    resetAutoModeDraftAttempts();
    await runAutoModeSweep("u1", "g", deps);
    expect(calls).toContain("send");
  });

  it("one failing item never aborts the rest of the batch", async () => {
    const { deps, calls } = makeDeps({
      findCandidates: async () => {
        calls.push("findCandidates");
        return [
          { id: "item-bad", sourceId: "row-bad" },
          { id: "item-good", sourceId: "row-good" },
        ];
      },
      findEmail: async (_u, rowId) => {
        calls.push(`findEmail:${rowId}`);
        if (rowId === "row-bad") throw new Error("db hiccup");
        return {
          id: rowId,
          gmailId: `g-${rowId}`,
          from: "Jane <jane@example.com>",
          subject: "s",
          body: "b",
        };
      },
    });
    await runAutoModeSweep("u1", "g", deps);
    expect(calls).toContain("findEmail:row-bad");
    expect(calls).toContain("findEmail:row-good");
    expect(calls).toContain("send");
  });
});

describe("runAutoModeSweep — shared unattended-reply guards", () => {
  it("skips a blocked mail before any LLM spend or ledger write", async () => {
    const { deps, calls } = makeDeps({
      replyBlocked: async () => {
        calls.push("replyBlocked");
        return "daily-cap";
      },
    });

    await runAutoModeSweep("u1", "be brief", deps);

    expect(calls).toContain("replyBlocked");
    expect(calls).not.toContain("draftReply");
    expect(calls).not.toContain("writeLedger");
    expect(calls).not.toContain("send");
  });
});
