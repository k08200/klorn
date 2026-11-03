/**
 * clampSentField: what every SentMessage write stores for `to` and `subject`,
 * and what the provenance classifier compares. Postgres text cannot hold NUL,
 * and Prisma rejects a lone surrogate in a write or a `contains` filter, so a
 * header carrying either must not poison the row or the batch.
 */

import { describe, expect, it } from "vitest";
import { clampSentField, SENT_FIELD_MAX } from "../mail/sent-fields.js";
import { expectLinear, repeatTo } from "./helpers/linear-timing.js";

describe("clampSentField", () => {
  it("keeps ordinary text and valid surrogate pairs as they are", () => {
    expect(clampSentField("Re: Lunch 😀")).toBe("Re: Lunch 😀");
  });

  it("drops NUL characters", () => {
    expect(clampSentField("a\u0000b\u0000")).toBe("ab");
  });

  it("drops lone surrogates, high or low", () => {
    expect(clampSentField("x\uD800y")).toBe("xy");
    expect(clampSentField("x\uDC00y")).toBe("xy");
    expect(clampSentField("\uDE00\uD83D")).toBe("");
  });

  it("stores at most SENT_FIELD_MAX characters and never half a pair", () => {
    expect(clampSentField("s".repeat(5_000))).toHaveLength(SENT_FIELD_MAX);
    expect(clampSentField(`${"a".repeat(SENT_FIELD_MAX - 1)}😀`)).toBe(
      "a".repeat(SENT_FIELD_MAX - 1),
    );
  });

  it("is linear on a huge header of lone surrogates", () => {
    expectLinear((n) => repeatTo(n, "\uD800"), clampSentField);
  });
});
