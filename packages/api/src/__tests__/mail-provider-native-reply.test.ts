/**
 * Step B0b, the seam: which providers thread a reply by the original message's
 * own id (`nativeReply`), and the one helper callers use to name that message.
 * Only OUTLOOK does. Every other provider, with every action flag on or off,
 * must be handed exactly what it was handed before B0b: no extra key.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../db.js", () => {
  const prisma = { linkedInboxAccount: { findFirst: vi.fn() } };
  return { prisma, db: prisma };
});
vi.mock("../mail/gmail.js", () => ({
  sendEmail: vi.fn(),
  createEmailDraft: vi.fn(),
  getReplyHeaders: vi.fn(),
  markAsRead: vi.fn(),
  toggleReadGmail: vi.fn(),
  toggleStarGmail: vi.fn(),
  trashEmail: vi.fn(),
  untrashEmail: vi.fn(),
  archiveEmail: vi.fn(),
  unarchiveEmail: vi.fn(),
  markLinkedInboxForReconnect: vi.fn(),
}));
vi.mock("nodemailer", () => ({ createTransport: vi.fn() }));
vi.mock("imapflow", () => ({ ImapFlow: class {} }));
vi.mock("../crypto-tokens.js", () => ({ decryptToken: () => "pw" }));
vi.mock("../sentry.js", () => ({ captureError: vi.fn() }));

const { mailActionsForProvider } = await import("../mail/providers/dispatch.js");
const { replyTargetFor } = await import("../mail/providers/reply-target.js");
const { unsupportedMailActions } = await import("../mail/providers/unsupported.js");

const FLAGS = ["IMAP_SEND_ENABLED", "IMAP_ACTIONS_ENABLED", "ICLOUD_INBOX_ENABLED"] as const;
const original = Object.fromEntries(FLAGS.map((name) => [name, process.env[name]]));

beforeEach(() => {
  for (const name of FLAGS) delete process.env[name];
});
afterEach(() => {
  for (const name of FLAGS) {
    const value = original[name];
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
});

describe("replyTargetFor", () => {
  it("names the original message for a provider that threads natively", () => {
    expect(replyTargetFor({ nativeReply: true }, "outlook:me@x.com:ID")).toEqual({
      replyToProviderMessageId: "outlook:me@x.com:ID",
    });
  });

  it.each([
    ["no capability", {}],
    ["the capability switched off", { nativeReply: false }],
  ])("returns nothing for %s, so no key is added to a call", (_name, actions) => {
    const target = replyTargetFor(actions, "gm-1");
    expect(target).toEqual({});
    expect(Object.keys(target)).toEqual([]);
  });
});

describe("which providers declare nativeReply", () => {
  it("OUTLOOK does", () => {
    expect(mailActionsForProvider("OUTLOOK").nativeReply).toBe(true);
  });

  it.each([
    "GOOGLE",
    "NAVER",
    "ICLOUD",
    "IMAP",
  ] as const)("%s does not, with the IMAP flags off or on", (provider) => {
    expect(mailActionsForProvider(provider).nativeReply).toBeUndefined();
    process.env.IMAP_SEND_ENABLED = "true";
    process.env.IMAP_ACTIONS_ENABLED = "true";
    process.env.ICLOUD_INBOX_ENABLED = "true";
    expect(mailActionsForProvider(provider).nativeReply).toBeUndefined();
  });

  it("the unsupported surface does not declare it", () => {
    expect(unsupportedMailActions("IMAP").nativeReply).toBeUndefined();
  });
});
