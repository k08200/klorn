/**
 * Connecting an IMAP inbox (iCloud, Naver, generic) starts its first poll at
 * once instead of leaving the user staring at an empty inbox for up to one
 * scheduler interval (5 min). The poll is the scheduler's own fan-out scoped to
 * the ONE new row, so the per-account in-flight guard and backoff still apply.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const m = vi.hoisted(() => ({
  sync: vi.fn(),
  notify: vi.fn(),
  captureError: vi.fn(),
  bgDisabled: vi.fn(() => false),
}));

vi.mock("../mail/imap-accounts.js", () => ({
  syncImapAccountsForUser: (...args: unknown[]) => m.sync(...args),
}));
vi.mock("../notify/conversations-updated.js", () => ({
  notifyConversationsUpdated: (...args: unknown[]) => m.notify(...args),
}));
vi.mock("../scheduler-heartbeat.js", () => ({
  isBackgroundAgentsDisabled: () => m.bgDisabled(),
}));
vi.mock("../sentry.js", () => ({ captureError: (...args: unknown[]) => m.captureError(...args) }));

const { startFirstImapSync } = await import("../mail/imap-first-sync.js");
const { IMAP_PROVIDERS } = await import("../mail/imap-providers.js");

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

beforeEach(() => {
  vi.clearAllMocks();
  m.bgDisabled.mockReturnValue(false);
  m.sync.mockResolvedValue({ fetched: 3, inserted: 3, classified: 3, errors: 0 });
  vi.spyOn(console, "warn").mockImplementation(() => {});
});

describe("startFirstImapSync", () => {
  it("polls only the new row of that user and provider, and wakes clients on new mail", async () => {
    const started = startFirstImapSync("user-1", IMAP_PROVIDERS.ICLOUD, "row-9");
    expect(started).toBe(true);
    await flush();
    expect(m.sync).toHaveBeenCalledWith("user-1", IMAP_PROVIDERS.ICLOUD, { rowId: "row-9" });
    expect(m.notify).toHaveBeenCalledWith("user-1");
  });

  it("does not wake clients when nothing was inserted", async () => {
    m.sync.mockResolvedValue({ fetched: 0, inserted: 0, classified: 0, errors: 0 });
    startFirstImapSync("user-1", IMAP_PROVIDERS.NAVER, "row-1");
    await flush();
    expect(m.notify).not.toHaveBeenCalled();
  });

  it("does nothing in a process whose background work is disabled (the poller lives elsewhere)", async () => {
    m.bgDisabled.mockReturnValue(true);
    expect(startFirstImapSync("user-1", IMAP_PROVIDERS.ICLOUD, "row-9")).toBe(false);
    await flush();
    expect(m.sync).not.toHaveBeenCalled();
  });

  it("reports a failed first poll and never throws into the connect response", async () => {
    m.sync.mockRejectedValue(new Error("LOGIN failed"));
    expect(() => startFirstImapSync("user-1", IMAP_PROVIDERS.ICLOUD, "row-9")).not.toThrow();
    await flush();
    expect(m.captureError).toHaveBeenCalledWith(
      expect.any(Error),
      expect.objectContaining({
        tags: { scope: "imap-first-sync" },
        extra: { userId: "user-1", linkedInboxAccountId: "row-9" },
      }),
    );
  });
});
