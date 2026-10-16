/**
 * auth/pending-links.ts: the parked OAuth authorization codes of account-link
 * flows. A handle is single use, lives 5 minutes, is stored only as its SHA-256,
 * and the store refuses new entries past its cap instead of growing.
 */

import crypto from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  _pendingLinkKeysForTests,
  _resetPendingLinksForTests,
  MAX_PENDING_LINKS,
  MAX_PENDING_LINKS_PER_USER,
  PENDING_LINK_SWEEP_MS,
  PENDING_LINK_TTL_MS,
  parkPendingLink,
  pendingLinkCount,
  takePendingLink,
} from "../auth/pending-links.js";

const LINK = { userId: "u1", marker: "__link_inbox__", code: "auth-code" } as const;

beforeEach(() => {
  _resetPendingLinksForTests();
});

afterEach(() => {
  vi.useRealTimers();
  _resetPendingLinksForTests();
});

describe("park / take", () => {
  it("hands back a 64-hex handle that resolves to the parked link exactly once", () => {
    const handle = parkPendingLink(LINK);

    expect(handle).toMatch(/^[0-9a-f]{64}$/);
    expect(takePendingLink(handle as string)).toMatchObject(LINK);
    expect(takePendingLink(handle as string)).toBeNull();
    expect(pendingLinkCount()).toBe(0);
  });

  it("keeps the native app scheme the flow was started with", () => {
    const handle = parkPendingLink({ ...LINK, appScheme: "klorn" }) as string;
    expect(takePendingLink(handle)?.appScheme).toBe("klorn");
  });

  it("gives every park its own handle", () => {
    const a = parkPendingLink(LINK);
    const b = parkPendingLink(LINK);
    expect(a).toMatch(/^[0-9a-f]{64}$/);
    expect(a).not.toBe(b);
    expect(pendingLinkCount()).toBe(2);
  });

  it.each([
    ["an unknown handle", "f".repeat(64)],
    ["a short handle", "abc"],
    ["upper-case hex", "A".repeat(64)],
    ["a non-string", 42],
    ["undefined", undefined],
  ])("returns null for %s without throwing", (_label, handle) => {
    parkPendingLink(LINK);
    expect(takePendingLink(handle)).toBeNull();
    expect(pendingLinkCount()).toBe(1);
  });
});

describe("storage", () => {
  it("stores only the SHA-256 of the handle, never the handle itself", () => {
    const handle = parkPendingLink(LINK) as string;
    const keys = _pendingLinkKeysForTests();

    expect(keys).toEqual([crypto.createHash("sha256").update(handle).digest("hex")]);
    expect(keys).not.toContain(handle);
  });
});

describe("TTL", () => {
  it("is five minutes", () => {
    expect(PENDING_LINK_TTL_MS).toBe(5 * 60 * 1000);
  });

  it("resolves just before the TTL and not after it", () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-10-15T00:00:00Z"));
    const early = parkPendingLink(LINK) as string;
    const late = parkPendingLink(LINK) as string;

    vi.setSystemTime(Date.now() + PENDING_LINK_TTL_MS - 1);
    expect(takePendingLink(early)).not.toBeNull();

    vi.setSystemTime(Date.now() + 2);
    expect(takePendingLink(late)).toBeNull();
  });

  it("sweeps an abandoned entry on the sweep interval after its TTL, then stops the timer", () => {
    vi.useFakeTimers();
    parkPendingLink(LINK);
    expect(pendingLinkCount()).toBe(1);

    vi.advanceTimersByTime(PENDING_LINK_TTL_MS + PENDING_LINK_SWEEP_MS);

    expect(pendingLinkCount()).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
  });
});

describe("timers", () => {
  it("uses ONE timer however many links are parked", () => {
    vi.useFakeTimers();
    for (let i = 0; i < 50; i += 1) parkPendingLink({ ...LINK, userId: `user-${i}` });
    expect(vi.getTimerCount()).toBe(1);
  });

  it("leaves no timer behind once every parked link is taken", () => {
    vi.useFakeTimers();
    const handles = Array.from({ length: 20 }, (_, i) =>
      parkPendingLink({ ...LINK, userId: `user-${i}` }),
    );
    for (const handle of handles) expect(takePendingLink(handle)).not.toBeNull();

    expect(pendingLinkCount()).toBe(0);
    expect(_pendingLinkKeysForTests()).toEqual([]);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("leaves no timer behind once evictions empty a user's parks", () => {
    vi.useFakeTimers();
    for (let i = 0; i < 10; i += 1) parkPendingLink(LINK);
    expect(pendingLinkCount()).toBe(MAX_PENDING_LINKS_PER_USER);
    expect(vi.getTimerCount()).toBe(1);

    for (const key of _pendingLinkKeysForTests()) expect(key).toMatch(/^[0-9a-f]{64}$/);
    _resetPendingLinksForTests();

    expect(vi.getTimerCount()).toBe(0);
  });

  it("an evicted or expired entry is no longer reachable from any timer: only the map held it", () => {
    vi.useFakeTimers();
    const first = parkPendingLink(LINK) as string;
    for (let i = 0; i < MAX_PENDING_LINKS_PER_USER; i += 1) parkPendingLink(LINK);

    expect(takePendingLink(first)).toBeNull();
    expect(vi.getTimerCount()).toBe(1);
  });
});

describe("per-user bound", () => {
  it("keeps at most a few parks per user: a new one evicts that user's oldest", () => {
    expect(MAX_PENDING_LINKS_PER_USER).toBe(3);
    const mine = Array.from({ length: MAX_PENDING_LINKS_PER_USER }, () => parkPendingLink(LINK));
    const theirs = parkPendingLink({ ...LINK, userId: "u2" });

    const newest = parkPendingLink(LINK);

    expect(pendingLinkCount()).toBe(MAX_PENDING_LINKS_PER_USER + 1);
    expect(takePendingLink(mine[0])).toBeNull();
    expect(takePendingLink(mine[1])).not.toBeNull();
    expect(takePendingLink(newest)).not.toBeNull();
    expect(takePendingLink(theirs)).not.toBeNull();
  });

  it("so one account replaying its state cannot fill the store for everyone", () => {
    for (let i = 0; i < MAX_PENDING_LINKS * 2; i += 1) parkPendingLink(LINK);
    expect(pendingLinkCount()).toBe(MAX_PENDING_LINKS_PER_USER);
    expect(parkPendingLink({ ...LINK, userId: "u2" })).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe("cap", () => {
  it("refuses a park past the cap, and accepts again once one is taken", () => {
    const handles = Array.from({ length: MAX_PENDING_LINKS }, (_, i) =>
      parkPendingLink({ ...LINK, userId: `user-${i}` }),
    );
    expect(handles.every((h) => typeof h === "string")).toBe(true);
    expect(MAX_PENDING_LINKS).toBe(500);

    expect(parkPendingLink({ ...LINK, userId: "one-more" })).toBeNull();
    expect(pendingLinkCount()).toBe(MAX_PENDING_LINKS);

    takePendingLink(handles[0] as string);
    expect(parkPendingLink({ ...LINK, userId: "one-more" })).toMatch(/^[0-9a-f]{64}$/);
  });
});
