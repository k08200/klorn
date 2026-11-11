import { beforeEach, describe, expect, it, vi } from "vitest";

// The scheduler's INBOX reconcile runs detached from the per-user tick
// (mail/reconcile-job.ts). Production, 2026-11-11: for the two users with a few
// thousand mirrored messages the reconcile's read-status refresh alone took
// 41–51 s per inbox, so awaited inside runUserCycle it overran the 30 s
// per-user budget every time, and withTimeout does not cancel, so it kept
// running anyway while the next tick re-entered the same user. These tests pin
// the detached run's guards: one run per user, a global cap, never rejects, and
// a hung run gives its slot back.

const m = vi.hoisted(() => ({
  reconcileEmails: vi.fn(async (_userId: string) => ({ removed: 0, updated: 0 })),
  reconcileLinkedInboxes: vi.fn(async (_userId: string) => ({ removed: 0, updated: 0 })),
  captureError: vi.fn(),
}));

vi.mock("../mail/email-sync.js", () => ({
  reconcileEmails: m.reconcileEmails,
  reconcileLinkedInboxes: m.reconcileLinkedInboxes,
}));
vi.mock("../sentry.js", () => ({ captureError: m.captureError }));

import {
  MAX_CONCURRENT_RECONCILES,
  RECONCILE_STALE_AFTER_MS,
  resetReconcileJobsForTests,
  startDetachedReconcile,
} from "../mail/reconcile-job.js";

/** A promise the test settles by hand, standing in for a long Gmail reconcile. */
function deferred() {
  let resolve: () => void = () => {};
  const promise = new Promise<void>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.spyOn(console, "error").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});
  m.reconcileEmails.mockResolvedValue({ removed: 0, updated: 0 });
  m.reconcileLinkedInboxes.mockResolvedValue({ removed: 0, updated: 0 });
  resetReconcileJobsForTests();
});

describe("startDetachedReconcile", () => {
  it("reconciles the primary inbox and, when asked, the linked inboxes", async () => {
    const run = startDetachedReconcile("user-1", { includeLinked: true });

    expect(run).not.toBeNull();
    await run;
    expect(m.reconcileEmails).toHaveBeenCalledWith("user-1");
    expect(m.reconcileLinkedInboxes).toHaveBeenCalledWith("user-1");
  });

  it("leaves the linked inboxes alone while linked sync is off", async () => {
    await startDetachedReconcile("user-1", { includeLinked: false });

    expect(m.reconcileEmails).toHaveBeenCalledWith("user-1");
    expect(m.reconcileLinkedInboxes).not.toHaveBeenCalled();
  });

  it("never starts a second run for a user whose run is still going", async () => {
    const gate = deferred();
    m.reconcileEmails.mockImplementationOnce(async () => {
      await gate.promise;
      return { removed: 0, updated: 0 };
    });

    const first = startDetachedReconcile("user-1", { includeLinked: false });
    const second = startDetachedReconcile("user-1", { includeLinked: false });

    expect(first).not.toBeNull();
    expect(second).toBeNull();
    gate.resolve();
    await first;
    expect(m.reconcileEmails).toHaveBeenCalledTimes(1);
  });

  it("frees the user's slot once the run settles, so a later tick can start one", async () => {
    await startDetachedReconcile("user-1", { includeLinked: false });

    const again = startDetachedReconcile("user-1", { includeLinked: false });

    expect(again).not.toBeNull();
    await again;
    expect(m.reconcileEmails).toHaveBeenCalledTimes(2);
  });

  it("turns away users beyond MAX_CONCURRENT_RECONCILES while those runs are going", async () => {
    const gate = deferred();
    m.reconcileEmails.mockImplementation(async () => {
      await gate.promise;
      return { removed: 0, updated: 0 };
    });

    const started = Array.from({ length: MAX_CONCURRENT_RECONCILES }, (_, i) =>
      startDetachedReconcile(`user-${i}`, { includeLinked: false }),
    );
    const extra = startDetachedReconcile("user-extra", { includeLinked: false });

    expect(started.every((run) => run !== null)).toBe(true);
    expect(extra).toBeNull();
    gate.resolve();
    await Promise.all(started);
    expect(m.reconcileEmails).not.toHaveBeenCalledWith("user-extra");
  });

  it("never rejects: a failing primary reconcile is reported and the linked ones still run", async () => {
    m.reconcileEmails.mockRejectedValueOnce(new Error("Gmail 500"));

    await expect(
      startDetachedReconcile("user-1", { includeLinked: true }),
    ).resolves.toBeUndefined();

    expect(m.captureError).toHaveBeenCalledWith(
      expect.any(Error),
      expect.objectContaining({
        tags: expect.objectContaining({ scope: "automation.reconcile", userId: "user-1" }),
      }),
    );
    expect(m.reconcileLinkedInboxes).toHaveBeenCalledWith("user-1");
  });

  it("never rejects: a failing linked reconcile is reported under its own scope", async () => {
    m.reconcileLinkedInboxes.mockRejectedValueOnce(new Error("revoked"));

    await expect(
      startDetachedReconcile("user-1", { includeLinked: true }),
    ).resolves.toBeUndefined();

    expect(m.captureError).toHaveBeenCalledWith(
      expect.any(Error),
      expect.objectContaining({
        tags: expect.objectContaining({ scope: "automation.reconcile.linked", userId: "user-1" }),
      }),
    );
  });

  it("gives back the slot of a run hung past RECONCILE_STALE_AFTER_MS, and says so", async () => {
    m.reconcileEmails.mockImplementationOnce(() => new Promise(() => {}));
    const t0 = 1_000_000;

    expect(startDetachedReconcile("user-1", { includeLinked: false }, t0)).not.toBeNull();
    expect(
      startDetachedReconcile("user-1", { includeLinked: false }, t0 + RECONCILE_STALE_AFTER_MS - 1),
    ).toBeNull();
    const retry = startDetachedReconcile(
      "user-1",
      { includeLinked: false },
      t0 + RECONCILE_STALE_AFTER_MS,
    );

    expect(retry).not.toBeNull();
    await retry;
    expect(m.reconcileEmails).toHaveBeenCalledTimes(2);
    expect(m.captureError).toHaveBeenCalledWith(
      expect.any(Error),
      expect.objectContaining({
        tags: expect.objectContaining({ scope: "automation.reconcile.stale", userId: "user-1" }),
      }),
    );
  });

  it("a hung run that finally settles does not free the slot of the run that replaced it", async () => {
    const hung = deferred();
    const replacement = deferred();
    m.reconcileEmails
      .mockImplementationOnce(async () => {
        await hung.promise;
        return { removed: 0, updated: 0 };
      })
      .mockImplementationOnce(async () => {
        await replacement.promise;
        return { removed: 0, updated: 0 };
      });
    const t0 = 2_000_000;

    const first = startDetachedReconcile("user-1", { includeLinked: false }, t0);
    const second = startDetachedReconcile(
      "user-1",
      { includeLinked: false },
      t0 + RECONCILE_STALE_AFTER_MS,
    );
    hung.resolve();
    await first;

    // The replacement is still going: the user stays claimed.
    expect(second).not.toBeNull();
    expect(
      startDetachedReconcile("user-1", { includeLinked: false }, t0 + RECONCILE_STALE_AFTER_MS + 1),
    ).toBeNull();
    replacement.resolve();
    await second;
  });
});
