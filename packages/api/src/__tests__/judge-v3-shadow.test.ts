import { describe, expect, it, vi } from "vitest";
import { runFactsShadow, type ShadowDeps, type ShadowMail } from "../judge/v3/shadow.js";

const mail: ShadowMail = {
  emailId: "e1",
  threadId: "t1",
  from: "Sarah <sarah@partner.io>",
  to: "me@acme.com",
  cc: "",
  subject: "Contract",
  snippet: "Could you confirm by Tuesday 6pm?",
  body: "Could you confirm by Tuesday 6pm?",
  labels: ["INBOX"],
  receivedAt: new Date("2026-10-30T00:12:00Z"),
  hasListUnsubscribe: false,
  listId: null,
  precedence: null,
  autoSubmitted: null,
  dateHeader: "Fri, 30 Oct 2026 09:12:00 +0900",
  hasCalendarInvite: false,
  senderAuthenticated: true,
};

const extraction = {
  facts: null,
  source: "none" as const,
  preFacts: {},
  signals: {} as never,
  model: null,
  provider: null,
  servedByUserKey: false,
  usage: null,
  issues: [],
  evidenceCheck: { checked: 0, dropped: [] },
  escalate: true,
  escalateReasons: ["llm_failed" as const],
  certain: [],
};

function deps(over: Partial<ShadowDeps> = {}): ShadowDeps {
  return {
    enabled: vi.fn(() => true),
    usesOwnKey: vi.fn(async () => false),
    budget: vi.fn(async () => "ok" as const),
    slot: vi.fn(async <T>(fn: () => Promise<T>) => fn()),
    userContext: vi.fn(async () => ({ userAddresses: ["me@acme.com"], timeZone: "Asia/Seoul" })),
    repliedAfter: vi.fn(async () => false),
    extract: vi.fn(async () => extraction),
    relationship: vi.fn(async () => null),
    save: vi.fn(async () => undefined),
    now: () => new Date("2026-10-30T00:12:05Z"),
    ...over,
  };
}

describe("runFactsShadow", () => {
  it("does nothing while JUDGE_V3_SHADOW is off for the user", async () => {
    const d = deps({ enabled: vi.fn(() => false) });
    expect(await runFactsShadow("u1", mail, "QUEUE", d)).toBe("disabled");
    expect(d.extract).not.toHaveBeenCalled();
    expect(d.save).not.toHaveBeenCalled();
  });

  it("skips users on their own provider key: an invisible experiment must not spend it", async () => {
    const d = deps({ usesOwnKey: vi.fn(async () => true) });
    expect(await runFactsShadow("u1", mail, "QUEUE", d)).toBe("byok");
    expect(d.extract).not.toHaveBeenCalled();
  });

  it("skips (never waits) when the budget or call share is tight", async () => {
    for (const verdict of ["calls", "user_budget", "shadow_budget", "global_budget"] as const) {
      const d = deps({ budget: vi.fn(async () => verdict) });
      expect(await runFactsShadow("u1", mail, "QUEUE", d)).toBe(verdict);
      expect(d.extract).not.toHaveBeenCalled();
    }
  });

  it("skips when another shadow extraction is in flight", async () => {
    const d = deps({ slot: vi.fn(async () => null) });
    expect(await runFactsShadow("u1", mail, "QUEUE", d)).toBe("busy");
    expect(d.extract).not.toHaveBeenCalled();
  });

  it("extracts, snapshots the relationship and stores one row with the v2 lane frozen", async () => {
    const d = deps();
    expect(await runFactsShadow("u1", mail, "QUEUE", d)).toBe("stored");
    const [input, opts] = (d.extract as ReturnType<typeof vi.fn>).mock.calls[0] as [
      Record<string, unknown>,
      Record<string, unknown>,
    ];
    expect(input).toMatchObject({
      from: mail.from,
      userAddresses: ["me@acme.com"],
      userTimeZone: "Asia/Seoul",
      userRepliedAfter: false,
      senderAuthenticated: true,
      dateHeader: mail.dateHeader,
    });
    // The mail being judged is excluded from its own sender history.
    expect(d.relationship).toHaveBeenCalledWith("u1", mail.from, ["me@acme.com"], true, "e1");
    expect(opts).toEqual({ userId: "u1" });
    expect(d.save).toHaveBeenCalledWith(
      expect.objectContaining({
        userId: "u1",
        source: "EMAIL",
        sourceId: "e1",
        v2Tier: "QUEUE",
        extractedAt: new Date("2026-10-30T00:12:05Z"),
      }),
    );
  });

  it("treats a budget refusal mid-call as a quiet stop, writing nothing", async () => {
    const err = Object.assign(new Error("cap"), { name: "DailyCostCapExceededError" });
    const d = deps({
      extract: vi.fn(async () => {
        throw err;
      }),
    });
    expect(await runFactsShadow("u1", mail, "QUEUE", d)).toBe("stopped");
    expect(d.save).not.toHaveBeenCalled();
  });

  it("never throws: any other failure is reported and swallowed into 'failed'", async () => {
    const d = deps({
      save: vi.fn(async () => {
        throw new Error("db down");
      }),
    });
    await expect(runFactsShadow("u1", mail, "QUEUE", d)).resolves.toBe("failed");
  });

  it("does not ask about thread replies when the mail has no thread", async () => {
    const d = deps();
    await runFactsShadow("u1", { ...mail, threadId: null }, "QUEUE", d);
    expect(d.repliedAfter).not.toHaveBeenCalled();
    const [input] = (d.extract as ReturnType<typeof vi.fn>).mock.calls[0] as [
      Record<string, unknown>,
    ];
    expect(input.userRepliedAfter).toBeNull();
  });
});

describe("shadowMailFromRaw", () => {
  it("takes Gmail's DMARC verdict, else the Klorn mailbox's stored one", async () => {
    const { shadowMailFromRaw } = await import("../judge/v3/shadow.js");
    const raw = {
      gmailId: "g1",
      threadId: "t1",
      from: "a@b.com",
      to: "me@acme.com",
      cc: "",
      subject: "s",
      snippet: "",
      body: "",
      htmlBody: "",
      labels: [],
      isRead: false,
      isStarred: false,
      receivedAt: new Date(),
      attachments: [],
    };
    expect(shadowMailFromRaw("e", { ...raw, dmarcPass: true }).senderAuthenticated).toBe(true);
    expect(
      shadowMailFromRaw("e", {
        ...raw,
        authentication: { spf: "pass", dkim: "pass", dmarc: "fail" },
      }).senderAuthenticated,
    ).toBe(false);
    expect(shadowMailFromRaw("e", raw).senderAuthenticated).toBeNull();
    // The Klorn mailbox needs DKIM and DMARC, as isAuthenticatedSender says.
    expect(
      shadowMailFromRaw("e", {
        ...raw,
        authentication: { spf: "pass", dkim: "fail", dmarc: "pass" },
      }).senderAuthenticated,
    ).toBe(false);
  });

  it("detects an .ics attachment for producers without a MIME walk", async () => {
    const { shadowMailFromRaw } = await import("../judge/v3/shadow.js");
    const raw = {
      gmailId: "g1",
      threadId: null,
      from: "a@b.com",
      to: "",
      cc: "",
      subject: "s",
      snippet: "",
      body: "",
      htmlBody: "",
      labels: [],
      isRead: false,
      isStarred: false,
      receivedAt: new Date(),
      attachments: [{ filename: "invite.ics", mimeType: "application/octet-stream" }] as never,
    };
    expect(shadowMailFromRaw("e", raw).hasCalendarInvite).toBe(true);
    // No MIME walk and no .ics: unknown, not "no invite".
    expect(shadowMailFromRaw("e", { ...raw, attachments: [] }).hasCalendarInvite).toBeNull();
  });
});
