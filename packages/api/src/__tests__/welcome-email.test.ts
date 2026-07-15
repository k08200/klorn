import { beforeEach, describe, expect, it, vi } from "vitest";

// In-memory User table + a controllable queue of send outcomes so the
// idempotency tests exercise the real atomic-claim logic end to end.
type UserRow = { id: string; welcomeEmailSentAt: Date | null };
type SendResult = "sent" | "skipped" | "failed";
const state = vi.hoisted(() => ({
  users: new Map<string, UserRow>(),
  sendResults: [] as SendResult[],
  sendCalls: [] as Array<{ email: string; name: string | null }>,
}));

type UpdateManyArgs = {
  where?: { id?: string; welcomeEmailSentAt?: Date | null };
  data?: { welcomeEmailSentAt?: Date | null };
};

vi.mock("../db.js", () => ({
  prisma: {
    user: {
      // Mirrors Prisma updateMany: matches by id and, when the where clause
      // pins welcomeEmailSentAt to null, only rows currently null (the claim).
      updateMany: vi.fn(({ where = {}, data = {} }: UpdateManyArgs) => {
        let count = 0;
        for (const [id, row] of state.users) {
          if (where.id !== undefined && id !== where.id) continue;
          if (where.welcomeEmailSentAt === null && row.welcomeEmailSentAt !== null) continue;
          state.users.set(id, { ...row, welcomeEmailSentAt: data.welcomeEmailSentAt ?? null });
          count++;
        }
        return Promise.resolve({ count });
      }),
    },
  },
}));

// Keep the real buildWelcomeEmail (pure, tested below); stub only the network send.
vi.mock("../mail/email.js", async (importActual) => {
  const actual = await importActual<typeof import("../mail/email.js")>();
  return {
    ...actual,
    sendWelcomeEmail: vi.fn((email: string, name?: string | null) => {
      state.sendCalls.push({ email, name: name ?? null });
      const result: SendResult = state.sendResults.shift() ?? "sent";
      return Promise.resolve(result);
    }),
  };
});

vi.mock("../sentry.js", () => ({ captureError: vi.fn() }));

import { buildWelcomeEmail, type FounderIdentity } from "../mail/email.js";
import { maybeSendWelcomeEmail } from "../notify/welcome-email.js";
import { captureError } from "../sentry.js";

const FOUNDER: FounderIdentity = { name: "Ada", title: "Founder", communityUrl: null };
const TEAM: FounderIdentity = { name: "", title: "Founder", communityUrl: null };

beforeEach(() => {
  state.users.clear();
  state.sendResults = [];
  state.sendCalls = [];
  vi.mocked(captureError).mockClear();
});

describe("buildWelcomeEmail", () => {
  it("greets by the first name and signs off as the founder", () => {
    const { subject, text, html } = buildWelcomeEmail("jane@acme.com", "Jane Doe", FOUNDER);
    expect(subject).toBe("Welcome to Klorn");
    expect(text).toContain("Hey Jane,");
    expect(text).toContain("I'm Ada, and I build Klorn.");
    expect(text).toContain("— Ada");
    expect(text).toContain("Founder, Klorn");
    expect(html).toContain("Hey Jane,");
  });

  it("falls back to the email local part when there is no name", () => {
    const { text } = buildWelcomeEmail("yongrean.kim@acme.com", null, FOUNDER);
    expect(text).toContain("Hey yongrean.kim,");
  });

  it("uses a neutral team voice when no founder name is configured", () => {
    const { text } = buildWelcomeEmail("jane@acme.com", "Jane", TEAM);
    expect(text).toContain("I'm on the team that builds Klorn.");
    expect(text).toContain("— The Klorn team");
    expect(text).not.toContain("Founder, Klorn");
  });

  it("includes the community line only when a community URL is set", () => {
    const without = buildWelcomeEmail("jane@acme.com", "Jane", FOUNDER);
    expect(without.text).not.toContain("Come say hi");

    const withUrl = buildWelcomeEmail("jane@acme.com", "Jane", {
      ...FOUNDER,
      communityUrl: "https://klorn.ai/community",
    });
    expect(withUrl.text).toContain("https://klorn.ai/community");
    expect(withUrl.html).toContain('href="https://klorn.ai/community"');
  });

  it("escapes HTML in the name so it cannot inject markup", () => {
    const { html } = buildWelcomeEmail("evil@acme.com", "<script>alert(1)</script>", FOUNDER);
    expect(html).not.toContain("<script>");
  });
});

describe("maybeSendWelcomeEmail", () => {
  const recipient = { id: "u1", email: "jane@acme.com", name: "Jane" };

  it("sends exactly once even when called repeatedly", async () => {
    state.users.set("u1", { id: "u1", welcomeEmailSentAt: null });

    await maybeSendWelcomeEmail(recipient);
    await maybeSendWelcomeEmail(recipient);
    await maybeSendWelcomeEmail(recipient);

    expect(state.sendCalls).toHaveLength(1);
    expect(state.users.get("u1")?.welcomeEmailSentAt).toBeInstanceOf(Date);
  });

  it("does not send when the user was already welcomed", async () => {
    state.users.set("u1", { id: "u1", welcomeEmailSentAt: new Date("2026-01-01") });

    await maybeSendWelcomeEmail(recipient);

    expect(state.sendCalls).toHaveLength(0);
  });

  it("releases the claim on send failure so the next sign-in retries", async () => {
    state.users.set("u1", { id: "u1", welcomeEmailSentAt: null });
    state.sendResults = ["failed", "sent"]; // first attempt fails, retry succeeds

    await maybeSendWelcomeEmail(recipient);
    // Claim was released back to null after the failed send.
    expect(state.users.get("u1")?.welcomeEmailSentAt).toBeNull();

    await maybeSendWelcomeEmail(recipient);
    expect(state.sendCalls).toHaveLength(2);
    expect(state.users.get("u1")?.welcomeEmailSentAt).toBeInstanceOf(Date);
  });

  it("releases the claim quietly when Resend is unconfigured (skipped)", async () => {
    state.users.set("u1", { id: "u1", welcomeEmailSentAt: null });
    state.sendResults = ["skipped"]; // no RESEND_API_KEY → graceful no-op

    await maybeSendWelcomeEmail(recipient);

    // Not permanently stamped — a later sign-in (once configured) retries.
    expect(state.users.get("u1")?.welcomeEmailSentAt).toBeNull();
    // A skip is expected, not an error: no Sentry noise.
    expect(captureError).not.toHaveBeenCalled();
  });
});
