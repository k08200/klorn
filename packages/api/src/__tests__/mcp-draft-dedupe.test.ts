/**
 * The short memory behind create_draft's retry guard: the same draft (same user,
 * same email, same body, same subject) asked for again inside the window is the
 * first draft, not a second one. In-process, so per instance, exactly like the
 * write cap; it only ever makes a duplicate less likely, never a wrong one.
 */

import { describe, expect, it } from "vitest";
import {
  DRAFT_DEDUPE_WINDOW_MS,
  draftKey,
  findRecentDraft,
  MAX_REMEMBERED_DRAFTS,
  recentDraftCount,
  rememberDraft,
} from "../mcp/draft-dedupe.js";

const T0 = 1_000_000_000_000;
const parts = (over: Partial<Parameters<typeof draftKey>[0]> = {}) => ({
  userId: "u1",
  emailKey: "g-1",
  bodyHash: "a".repeat(64),
  subject: "Re: Plan",
  ...over,
});
const draft = (draftId: string) => ({ draftId, provider: "GOOGLE", to: "alice@example.com" });

describe("draftKey", () => {
  it("is deterministic and a fixed-size hex digest", () => {
    expect(draftKey(parts())).toBe(draftKey(parts()));
    expect(draftKey(parts())).toMatch(/^[0-9a-f]{64}$/);
  });

  it("changes with every part", () => {
    const base = draftKey(parts());
    for (const over of [
      { userId: "u2" },
      { emailKey: "g-2" },
      { bodyHash: "b".repeat(64) },
      { subject: "Re: Other" },
    ]) {
      expect(draftKey(parts(over)), JSON.stringify(over)).not.toBe(base);
    }
  });

  it("cannot be made to collide by moving text between parts", () => {
    expect(draftKey(parts({ userId: "u1", emailKey: "g-1" }))).not.toBe(
      draftKey(parts({ userId: "u1g", emailKey: "-1" })),
    );
  });

  it("does not carry the subject in the clear", () => {
    expect(draftKey(parts({ subject: "secret subject" }))).not.toContain("secret");
  });
});

describe("remembering and finding", () => {
  it("finds a draft inside the window and not at or after its end", () => {
    const key = draftKey(parts({ userId: "window-user" }));
    rememberDraft(key, draft("d-1"), T0);
    expect(findRecentDraft(key, T0)).toEqual(draft("d-1"));
    expect(findRecentDraft(key, T0 + DRAFT_DEDUPE_WINDOW_MS - 1)).toEqual(draft("d-1"));
    expect(findRecentDraft(key, T0 + DRAFT_DEDUPE_WINDOW_MS)).toBeNull();
  });

  it("knows nothing about a key it never saw", () => {
    expect(findRecentDraft(draftKey(parts({ userId: "never" })), T0)).toBeNull();
  });

  it("keeps the first draft for a key that is remembered again while still fresh", () => {
    const key = draftKey(parts({ userId: "twice-user" }));
    rememberDraft(key, draft("d-first"), T0);
    rememberDraft(key, draft("d-second"), T0 + 1000);
    expect(findRecentDraft(key, T0 + 2000)).toEqual(draft("d-first"));
  });
});

describe("bounded memory", () => {
  it("never holds more than MAX_REMEMBERED_DRAFTS, dropping the oldest first", () => {
    const now = T0 + 10 * DRAFT_DEDUPE_WINDOW_MS;
    const keys = Array.from({ length: MAX_REMEMBERED_DRAFTS + 25 }, (_, i) =>
      draftKey(parts({ userId: "flood-user", emailKey: `g-${i}` })),
    );
    for (const [i, key] of keys.entries()) rememberDraft(key, draft(`d-${i}`), now + i);
    expect(recentDraftCount()).toBeLessThanOrEqual(MAX_REMEMBERED_DRAFTS);
    expect(findRecentDraft(keys[0], now + keys.length)).toBeNull();
    expect(findRecentDraft(keys.at(-1) as string, now + keys.length)).toEqual(
      draft(`d-${keys.length - 1}`),
    );
  });

  it("sweeps expired entries when a new one is remembered, so idle users do not accumulate", () => {
    const stale = draftKey(parts({ userId: "sweep-stale" }));
    const later = T0 + 50 * DRAFT_DEDUPE_WINDOW_MS;
    rememberDraft(stale, draft("d-stale"), later);
    expect(recentDraftCount()).toBeGreaterThanOrEqual(1);
    const now = later + DRAFT_DEDUPE_WINDOW_MS;
    const fresh = draftKey(parts({ userId: "sweep-new" }));
    rememberDraft(fresh, draft("d-new"), now);
    // Everything older than the window is gone; only the new entry is held.
    expect(recentDraftCount()).toBe(1);
    expect(findRecentDraft(fresh, now)).toEqual(draft("d-new"));
  });
});
