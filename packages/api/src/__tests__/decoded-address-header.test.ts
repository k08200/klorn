/**
 * Address headers of the Klorn mailbox with their encoded-words decoded
 * (mail/decoded-address-header.ts, step E1b of docs/providers/unified-platform-plan.md).
 *
 * The raw header is parsed first, quote- and comment-aware, and only the display
 * name is decoded: decoding the whole value first let an encoded comment or name
 * supply a second, fake mailbox that the parser then read as the sender
 * (security re-verification N1).
 */

import { describe, expect, it } from "vitest";
import {
  decodedAddressList,
  decodedMailbox,
  MAX_ADDRESS_CHARS,
  MAX_DISPLAY_NAME_CHARS,
  MAX_HEADER_CHARS,
  MAX_LIST_ENTRIES,
  MAX_RAW_HEADER_CHARS,
  stripControls,
} from "../mail/decoded-address-header.js";
import { extractEmailAddress, isPlainAddress, splitAddressList } from "../mail/email-address.js";
import { MAX_STORED_CC_LENGTH } from "../mail/imap-envelope.js";

const b64 = (text: string) => Buffer.from(text, "utf8").toString("base64");

describe("decodedMailbox", () => {
  it("keeps the real mailbox when an encoded comment spells another (a Klorn address)", () => {
    const raw =
      "=?utf-8?Q?=22?= <attacker@evil.com> (=?utf-8?Q?=22_=3Cjane=40klorn.ai=3E_=22=22?=)";
    const stored = decodedMailbox(raw);
    expect(extractEmailAddress(stored)).toBe("attacker@evil.com");
    expect(stored).not.toContain("jane@klorn.ai");
  });

  it("keeps the real mailbox when an encoded comment spells a trusted sender", () => {
    const raw =
      "=?utf-8?Q?=22?= <attacker@evil.com> (=?utf-8?Q?=22_=3Cno-reply=40accounts.google.com=3E_=22=22?=)";
    expect(extractEmailAddress(decodedMailbox(raw))).toBe("attacker@evil.com");
  });

  it("keeps the real mailbox when the encoded display name itself spells an angle-addr", () => {
    const raw = "=?utf-8?Q?Jane_=3Cjane=40klorn.ai=3E?= <attacker@evil.com>";
    const stored = decodedMailbox(raw);
    expect(extractEmailAddress(stored)).toBe("attacker@evil.com");
    expect(stored).toBe('"Jane <jane@klorn.ai>" <attacker@evil.com>');
  });

  it("decodes an ordinary display name and keeps the address", () => {
    expect(decodedMailbox(`=?UTF-8?B?${b64("김철수")}?= <Kim@Example.com>`)).toBe(
      "김철수 <Kim@Example.com>",
    );
    expect(decodedMailbox(`"=?UTF-8?B?${b64("김철수")}?=" <kim@example.com>`)).toBe(
      "김철수 <kim@example.com>",
    );
  });

  it("strips control characters after decoding", () => {
    expect(decodedMailbox("=?utf-8?Q?Ja=0D=0Ane=00?= <jane@example.com>")).toBe(
      "Ja ne <jane@example.com>",
    );
    expect(decodedMailbox("Plain\r\n Name <p@example.com>")).toBe("Plain Name <p@example.com>");
  });

  it("stores every header rebuilt from its name and mailbox (comments dropped)", () => {
    expect(decodedMailbox("<a@example.com> (=?utf-8?Q?x?=)")).toBe("a@example.com");
    expect(decodedMailbox("a@example.com")).toBe("a@example.com");
    expect(decodedMailbox("Sam <sam@example.com>")).toBe("Sam <sam@example.com>");
    expect(decodedMailbox('"Doe, Jane" <j@x.com>')).toBe('"Doe, Jane" <j@x.com>');
  });

  it("stores nothing for an ambiguous header (two angle-addrs)", () => {
    expect(decodedMailbox("=?utf-8?Q?x?= <a@example.com> <b@example.com>")).toBe("");
  });
});

describe("splitAddressList", () => {
  it("splits on commas outside quotes, comments and angle-addrs", () => {
    expect(
      splitAddressList('"Doe, Jane" <j@x.com>, (a, comment) b@y.com ,<"q,1"@z.com>, , c@w.com'),
    ).toEqual(['"Doe, Jane" <j@x.com>', "(a, comment) b@y.com", '<"q,1"@z.com>', "c@w.com"]);
  });

  it("keeps an unterminated quote's tail as one part", () => {
    expect(splitAddressList('a@x.com, "open, quote <b@y.com>')).toEqual([
      "a@x.com",
      '"open, quote <b@y.com>',
    ]);
  });
});

describe("decodedAddressList", () => {
  it("decodes each display name and keeps every address", () => {
    const raw = `=?UTF-8?B?${b64("한글")}?= <a@x.com>, "Doe, Jane" <j@x.com>, b@y.com`;
    expect(decodedAddressList(raw)).toBe('한글 <a@x.com>, "Doe, Jane" <j@x.com>, b@y.com');
  });

  it("cannot be made to add an address through an encoded name", () => {
    const raw = "=?utf-8?Q?x=2C_victim=40klorn.ai?= <a@x.com>";
    const list = splitAddressList(decodedAddressList(raw)).map(extractEmailAddress);
    expect(list).toEqual(["a@x.com"]);
  });
});

describe("caps that cannot change the mailbox (security verification A)", () => {
  // A quoted display name of 3,900+ characters holding <jane@klorn.ai>, then the
  // real mailbox: a cap at 4,000 used to cut inside the quotes, and the cut value
  // parsed as jane@klorn.ai.
  const quotedName = `"${"x".repeat(10)} <jane@klorn.ai> ${"y".repeat(3_990)}" <attacker@evil.com>`;
  // An atom phrase with one encoded word that decodes to <jane@klorn.ai>.
  const atomPhrase = `=?utf-8?Q?=3Cjane=40klorn.ai=3E?= ${"a".repeat(4_000)} <attacker@evil.com>`;

  it.each([
    ["a long quoted display name", quotedName],
    ["an atom phrase with one encoded word", atomPhrase],
  ])("keeps the real mailbox behind %s", (_label, raw) => {
    expect(extractEmailAddress(raw)).toBe("attacker@evil.com");
    const stored = decodedMailbox(raw);
    expect(extractEmailAddress(stored)).toBe("attacker@evil.com");
    expect(stored.length).toBeLessThan(3 * MAX_DISPLAY_NAME_CHARS + MAX_ADDRESS_CHARS);
  });

  it.each([
    ["a long quoted display name", quotedName],
    ["an atom phrase with one encoded word", atomPhrase],
  ])("keeps the real mailbox of a list entry behind %s", (_label, raw) => {
    const stored = decodedAddressList(`ok@example.com, ${raw}`);
    expect(splitAddressList(stored).map(extractEmailAddress)).toEqual([
      "ok@example.com",
      "attacker@evil.com",
    ]);
  });

  it("caps the display name, never the mailbox", () => {
    const stored = decodedMailbox(`${"n".repeat(1_000)} <long-name@example.com>`);
    expect(stored).toBe(`${"n".repeat(MAX_DISPLAY_NAME_CHARS)} <long-name@example.com>`);
  });

  it("stores nothing for a mailbox over 254 characters", () => {
    const address = `${"l".repeat(MAX_ADDRESS_CHARS)}@example.com`;
    expect(decodedMailbox(`Name <${address}>`)).toBe("");
  });

  it("parses an over-long raw header whole and keeps only its bare mailbox", () => {
    const raw = `"${"x <jane@klorn.ai> ".repeat(1_000)}" <attacker@evil.com>`;
    expect(raw.length).toBeGreaterThan(MAX_RAW_HEADER_CHARS);
    expect(decodedMailbox(raw)).toBe("attacker@evil.com");
    // Ambiguous past the limit: nothing, never a guess from a prefix.
    expect(decodedMailbox(`${raw} <second@evil.com>`)).toBe("");
  });

  it("keeps a stored list within the column, whole entries only", () => {
    const entry = (i: number) => `Person ${i} <person${i}@example.com>`;
    const raw = Array.from({ length: 400 }, (_, i) => entry(i)).join(", ");
    const stored = decodedAddressList(raw);
    expect(stored.length).toBeLessThanOrEqual(MAX_STORED_CC_LENGTH);
    const kept = splitAddressList(stored);
    expect(kept.length).toBeGreaterThan(90);
    expect(kept).toEqual(kept.map((_value, i) => entry(i)));
  });
});

describe("property: the stored mailbox is the raw one, or nothing", () => {
  // A small seeded generator, so a failure reproduces.
  function rng(seed: number) {
    let state = seed >>> 0;
    return () => {
      state = (state * 1_664_525 + 1_013_904_223) >>> 0;
      return state / 2 ** 32;
    };
  }
  const TOKENS = [
    '"',
    "\\",
    "(",
    ")",
    "<",
    ">",
    ",",
    " ",
    "@",
    "jane@klorn.ai",
    "<jane@klorn.ai>",
    "attacker@evil.com",
    "<attacker@evil.com>",
    "=?utf-8?Q?=3Cjane=40klorn.ai=3E?=",
    "=?utf-8?Q?=22?=",
    "=?utf-8?B?6rmA?=",
    "\r\n ",
    "\u0000",
    "Jane",
  ];
  function header(next: () => number): string {
    const parts: string[] = [];
    const count = 1 + Math.floor(next() * 12);
    for (let i = 0; i < count; i++) {
      const token = TOKENS[Math.floor(next() * TOKENS.length)];
      // Now and then a long run, to cross every cap.
      parts.push(next() < 0.08 ? token.repeat(200 + Math.floor(next() * 1_000)) : token);
    }
    return parts.join("");
  }

  const shown = (raw: string) => JSON.stringify(raw.slice(0, 300));

  it("for 3,000 generated mailboxes", () => {
    const next = rng(20_261_023);
    for (let i = 0; i < 3_000; i++) {
      const raw = header(next);
      const rawMailbox = extractEmailAddress(stripControls(raw).trim());
      const stored = extractEmailAddress(decodedMailbox(raw));
      if (stored !== "" && stored !== rawMailbox) {
        throw new Error(
          `stored ${stored.slice(0, 120)} for ${rawMailbox.slice(0, 120)}: ${shown(raw)}`,
        );
      }
      const keepable = isPlainAddress(rawMailbox) && rawMailbox.length <= MAX_ADDRESS_CHARS;
      if (keepable && raw.length <= MAX_RAW_HEADER_CHARS && stored !== rawMailbox) {
        throw new Error(`lost ${rawMailbox.slice(0, 120)}: ${shown(raw)}`);
      }
    }
  });

  it("for 1,000 generated lists: every stored entry's mailbox is one of the raw entries'", () => {
    const next = rng(4_242);
    for (let i = 0; i < 1_000; i++) {
      const raw = Array.from({ length: 1 + Math.floor(next() * 5) }, () => header(next)).join(", ");
      const rawMailboxes = new Set(
        splitAddressList(raw).map((entry) => extractEmailAddress(stripControls(entry).trim())),
      );
      for (const entry of splitAddressList(decodedAddressList(raw))) {
        const mailbox = extractEmailAddress(entry);
        if (mailbox !== "" && !rawMailboxes.has(mailbox)) {
          throw new Error(`invented ${mailbox.slice(0, 120)}: ${shown(raw)}`);
        }
      }
    }
  });
});

describe("bounded work on hostile header sizes", () => {
  const elapsed = (run: () => unknown) => {
    const started = performance.now();
    run();
    return performance.now() - started;
  };

  it("has no sender for a From over the 256 KiB ceiling, and does not parse it", () => {
    expect(MAX_HEADER_CHARS).toBe(256 * 1024);
    const over = `${"x".repeat(MAX_HEADER_CHARS)} <attacker@evil.com>`;
    expect(decodedMailbox(over)).toBe("");
    const huge = `"${"n".repeat(10_000_000)}" <attacker@evil.com>`;
    expect(elapsed(() => expect(decodedMailbox(huge)).toBe(""))).toBeLessThan(50);
  });

  it("stores no list over the ceiling, and does not parse it", () => {
    expect(decodedAddressList(`a@example.com, ${"b".repeat(MAX_HEADER_CHARS)}`)).toBe("");
    // 1M empty entries, 5 MB of `x,`: refused before any split.
    expect(elapsed(() => expect(decodedAddressList(",".repeat(1_000_000))).toBe(""))).toBeLessThan(
      50,
    );
    expect(elapsed(() => expect(decodedAddressList("x,".repeat(2_500_000))).toBe(""))).toBeLessThan(
      50,
    );
  });

  it("stops a list after its entry limit", () => {
    const raw = Array.from({ length: MAX_LIST_ENTRIES + 100 }, (_, i) => `p${i}@x.co`).join(", ");
    const stored = splitAddressList(decodedAddressList(raw));
    expect(stored).toHaveLength(MAX_LIST_ENTRIES);
    expect(stored[MAX_LIST_ENTRIES - 1]).toBe(`p${MAX_LIST_ENTRIES - 1}@x.co`);
  });

  it("scans lazily under the ceiling: many entries, empty or tiny, return quickly", () => {
    const empties = `${",".repeat(250_000)}a@b.co`;
    expect(empties.length).toBeLessThan(MAX_HEADER_CHARS);
    expect(elapsed(() => expect(decodedAddressList(empties)).toBe("a@b.co"))).toBeLessThan(100);

    const tiny = Array.from({ length: 35_000 }, () => "a@b.co").join(",");
    expect(tiny.length).toBeLessThan(MAX_HEADER_CHARS);
    let stored = "";
    expect(elapsed(() => (stored = decodedAddressList(tiny)))).toBeLessThan(100);
    expect(splitAddressList(stored)).toHaveLength(MAX_LIST_ENTRIES);
  });
});
