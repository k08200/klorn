/**
 * applyFlagRun: one UID STORE for a whole run of UIDs that want the same change,
 * then one UID FETCH of FLAGS to read the result back. These pin what happens
 * when the coalesced STORE is refused (split and retry, bounded), how the
 * read-back is compared (case-insensitive, never confirmed by a missing FLAGS
 * item), and that the UID set string is only ever built from valid UIDs.
 */

import { describe, expect, it, vi } from "vitest";
import { MAX_IMAP_UID } from "../mail/imap-message-id.js";
import {
  applyFlagRun,
  MAX_STORE_COMMANDS_PER_RUN,
  readChange,
  starChange,
} from "../mail/providers/imap-flags.js";

type FakeClient = Parameters<typeof applyFlagRun>[0];

const uidsOf = (range: string) => range.split(",").map(Number);
const range = (from: number, to: number) =>
  Array.from({ length: to - from + 1 }, (_, i) => from + i);

/**
 * A server holding `present` UIDs. `noIf` decides when a STORE on a UID set is
 * answered NO (imapflow resolves false); by default every set is accepted.
 */
function fakeServer(
  present: number[],
  opts: { noIf?: (uids: number[]) => boolean; flagsOf?: (uid: number) => unknown } = {},
) {
  const held = new Map(present.map((uid) => [uid, new Set<string>()]));
  const store = (add: boolean) =>
    vi.fn(async (r: string, flags: string[]) => {
      const uids = uidsOf(r);
      if (opts.noIf?.(uids)) return false;
      for (const uid of uids) {
        for (const flag of flags) {
          if (add) held.get(uid)?.add(flag);
          else held.get(uid)?.delete(flag);
        }
      }
      return true;
    });
  const messageFlagsAdd = store(true);
  const messageFlagsRemove = store(false);
  const fetch = vi.fn((r: string) =>
    (async function* () {
      for (const uid of uidsOf(r)) {
        const flags = held.get(uid);
        if (flags) yield { uid, flags: opts.flagsOf ? opts.flagsOf(uid) : new Set(flags) };
      }
    })(),
  );
  const client = { messageFlagsAdd, messageFlagsRemove, fetch } as unknown as FakeClient;
  return { client, held, messageFlagsAdd, messageFlagsRemove, fetch };
}

describe("a refused coalesced STORE is split and retried", () => {
  it("confirms 99 of 100 UIDs when the server NOs any set containing the one bad UID", async () => {
    const uids = range(1, 100);
    const BAD = 57;
    const server = fakeServer(uids, { noIf: (set) => set.includes(BAD) });

    const outcomes = await applyFlagRun(server.client, uids, readChange(true));

    expect(outcomes.size).toBe(100);
    for (const uid of uids) {
      expect(outcomes.get(uid)).toBe(uid === BAD ? "refused" : "confirmed");
    }
    for (const uid of uids) expect(server.held.get(uid)?.has("\\Seen")).toBe(uid !== BAD);
    // Halving finds the bad UID in about 2 * log2(100) commands, not 100, and
    // the read-back is one FETCH for everything that was stored.
    expect(server.messageFlagsAdd.mock.calls.length).toBeLessThanOrEqual(20);
    expect(server.fetch).toHaveBeenCalledTimes(1);
    expect(uidsOf(server.fetch.mock.calls[0][0] as string)).not.toContain(BAD);
  });

  it("does not split when the first STORE is accepted", async () => {
    const server = fakeServer(range(1, 50));
    const outcomes = await applyFlagRun(server.client, range(1, 50), starChange(true));
    expect([...outcomes.values()].every((o) => o === "confirmed")).toBe(true);
    expect(server.messageFlagsAdd).toHaveBeenCalledTimes(1);
  });

  it("refuses a single UID without any retry", async () => {
    const server = fakeServer([7], { noIf: () => true });
    const outcomes = await applyFlagRun(server.client, [7], readChange(true));
    expect(outcomes.get(7)).toBe("refused");
    expect(server.messageFlagsAdd).toHaveBeenCalledTimes(1);
    expect(server.fetch).not.toHaveBeenCalled();
  });

  it("splits removals the same way", async () => {
    const uids = range(1, 8);
    const server = fakeServer(uids, { noIf: (set) => set.includes(3) });
    const outcomes = await applyFlagRun(server.client, uids, readChange(false));
    expect(outcomes.get(3)).toBe("refused");
    expect(outcomes.get(4)).toBe("confirmed");
    expect(server.messageFlagsRemove).toHaveBeenCalled();
    expect(server.messageFlagsAdd).not.toHaveBeenCalled();
  });

  it("keeps the per-UID result right when a UID is also simply missing from INBOX", async () => {
    const server = fakeServer([1, 3], { noIf: (set) => set.includes(2) });
    const outcomes = await applyFlagRun(server.client, [1, 2, 3], readChange(true));
    expect(outcomes.get(1)).toBe("confirmed");
    expect(outcomes.get(2)).toBe("refused");
    expect(outcomes.get(3)).toBe("confirmed");
  });

  it("bounds the total commands per run when every set is refused", async () => {
    const uids = range(1, 200);
    const server = fakeServer(uids, { noIf: () => true });

    const outcomes = await applyFlagRun(server.client, uids, readChange(true));

    expect(MAX_STORE_COMMANDS_PER_RUN).toBeGreaterThan(0);
    expect(MAX_STORE_COMMANDS_PER_RUN).toBeLessThanOrEqual(64);
    expect(server.messageFlagsAdd.mock.calls.length).toBeLessThanOrEqual(
      MAX_STORE_COMMANDS_PER_RUN,
    );
    expect(outcomes.size).toBe(200);
    expect([...outcomes.values()].every((o) => o === "refused")).toBe(true);
    expect(server.fetch).not.toHaveBeenCalled();
  });

  it("still confirms what was stored before the budget ran out", async () => {
    const uids = range(1, 200);
    // Every even UID is bad: the search cannot finish inside the budget, but
    // whatever it did store must be read back and confirmed, never dropped.
    const server = fakeServer(uids, { noIf: (set) => set.some((uid) => uid % 2 === 0) });
    const outcomes = await applyFlagRun(server.client, uids, readChange(true));
    expect(server.messageFlagsAdd.mock.calls.length).toBeLessThanOrEqual(
      MAX_STORE_COMMANDS_PER_RUN,
    );
    for (const [uid, outcome] of outcomes) {
      if (outcome === "confirmed") expect(server.held.get(uid)?.has("\\Seen")).toBe(true);
      else expect(outcome).toBe("refused");
    }
  });
});

describe("read-back comparison", () => {
  it.each([
    ["uppercase in a Set", new Set(["\\SEEN"])],
    ["lowercase in a Set", new Set(["\\seen"])],
    ["mixed case in an array", ["\\sEeN", "\\Flagged"]],
  ])("confirms \\Seen held as %s", async (_label, flags) => {
    const server = fakeServer([1], { flagsOf: () => flags });
    const outcomes = await applyFlagRun(server.client, [1], readChange(true));
    expect(outcomes.get(1)).toBe("confirmed");
  });

  it("confirms a removal when the flag is absent in any case, and not when it is present", async () => {
    const absent = fakeServer([1], { flagsOf: () => new Set(["\\ANSWERED"]) });
    expect((await applyFlagRun(absent.client, [1], starChange(false))).get(1)).toBe("confirmed");

    const present = fakeServer([1], { flagsOf: () => new Set(["\\FLAGGED"]) });
    expect((await applyFlagRun(present.client, [1], starChange(false))).get(1)).toBe("unconfirmed");
  });

  it.each([
    ["add", readChange(true)],
    ["remove", readChange(false)],
  ])("never confirms when the FETCH answer has no FLAGS item (%s)", async (_label, change) => {
    const server = fakeServer([1], { flagsOf: () => undefined });
    expect((await applyFlagRun(server.client, [1], change)).get(1)).toBe("unconfirmed");
  });
});

describe("the UID set string is built only from valid UIDs", () => {
  it.each([
    ["zero", 0],
    ["negative", -1],
    ["fractional", 1.5],
    ["NaN", Number.NaN],
    ["Infinity", Number.POSITIVE_INFINITY],
    ["above 2^32-1", MAX_IMAP_UID + 1],
    ["unsafe integer", Number.MAX_SAFE_INTEGER + 2],
  ])("refuses the whole run, without any command, when a UID is %s", async (_label, bad) => {
    const server = fakeServer([1, 2]);
    const outcomes = await applyFlagRun(server.client, [1, bad, 2], readChange(true));

    expect(server.messageFlagsAdd).not.toHaveBeenCalled();
    expect(server.messageFlagsRemove).not.toHaveBeenCalled();
    expect(server.fetch).not.toHaveBeenCalled();
    expect([...outcomes.values()].every((o) => o === "refused")).toBe(true);
    expect(outcomes.get(1)).toBe("refused");
  });

  it("accepts the smallest and the largest legal UID", async () => {
    const server = fakeServer([1, MAX_IMAP_UID]);
    const outcomes = await applyFlagRun(server.client, [1, MAX_IMAP_UID], readChange(true));
    expect(outcomes.get(1)).toBe("confirmed");
    expect(outcomes.get(MAX_IMAP_UID)).toBe("confirmed");
    expect(server.messageFlagsAdd.mock.calls[0][0]).toBe(`1,${MAX_IMAP_UID}`);
  });
});
