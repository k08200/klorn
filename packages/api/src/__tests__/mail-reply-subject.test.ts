/**
 * The subject of an agent's reply draft (step A4 of
 * docs/providers/unified-platform-plan.md): derived from the original mail, which
 * is data we did not choose, or supplied by the agent, which is checked and never
 * repaired. Limits count code points (what a JSON-schema `maxLength` counts), and
 * invisible characters are built with `String.fromCodePoint`, never typed in.
 */

import { describe, expect, it } from "vitest";
import { checkedSubject, MAX_SUBJECT_LENGTH, replySubject } from "../mail/reply-subject.js";

const cp = (...codes: number[]) => String.fromCodePoint(...codes);
const EMOJI = cp(0x1f4c5);
const LS = cp(0x2028);
const RLO = cp(0x202e);
const ZWSP = cp(0x200b);

describe("replySubject — the derived subject of a reply", () => {
  it("prefixes Re: once", () => {
    expect(replySubject("Quarterly plan")).toBe("Re: Quarterly plan");
  });

  it("does not double an existing reply prefix, in any case or spacing", () => {
    for (const subject of [
      "Re: Quarterly plan",
      "RE: Quarterly plan",
      "re: quarterly plan",
      "Re:Quarterly plan",
      "  Re: Quarterly plan",
    ]) {
      expect(replySubject(subject), subject).toBe(subject.trim());
    }
    expect(replySubject("Re: Re: Quarterly plan")).toBe("Re: Re: Quarterly plan");
  });

  it("prefixes words that merely start with re, and other prefixes", () => {
    expect(replySubject("Research update")).toBe("Re: Research update");
    expect(replySubject("Re")).toBe("Re: Re");
    expect(replySubject("Fwd: Invoice")).toBe("Re: Fwd: Invoice");
  });

  it("is a bare Re: for an empty, blank or missing subject", () => {
    for (const subject of ["", "   ", null, undefined]) {
      expect(replySubject(subject)).toBe("Re:");
    }
  });

  it("flattens control characters so the derived subject is always one line", () => {
    expect(replySubject("Hello\r\nBcc: evil@y.com")).toBe("Re: Hello Bcc: evil@y.com");
    expect(replySubject(`a${cp(0)}b\tc${LS}d`)).toBe("Re: a b c d");
  });

  it("strips bidi and zero-width controls from the original, so the visible text cannot be reordered", () => {
    expect(replySubject(`Invoice ${RLO}fdp.exe`)).toBe("Re: Invoice fdp.exe");
    expect(replySubject(`pay${ZWSP}pal`)).toBe("Re: paypal");
    expect(replySubject(`${ZWSP}${RLO}`)).toBe("Re:");
  });

  it("is capped at the subject limit in code points, prefix included", () => {
    expect(Array.from(replySubject("x".repeat(5000)))).toHaveLength(MAX_SUBJECT_LENGTH);
    expect(Array.from(replySubject(`Re: ${"x".repeat(5000)}`))).toHaveLength(MAX_SUBJECT_LENGTH);
    expect(Array.from(replySubject("x".repeat(MAX_SUBJECT_LENGTH - 4)))).toHaveLength(
      MAX_SUBJECT_LENGTH,
    );
  });

  it("counts an emoji as one code point against the cap and never splits it", () => {
    const fits = replySubject(EMOJI.repeat(MAX_SUBJECT_LENGTH - 4));
    expect(Array.from(fits)).toHaveLength(MAX_SUBJECT_LENGTH);
    expect(fits.endsWith(EMOJI)).toBe(true);
    const over = replySubject(EMOJI.repeat(MAX_SUBJECT_LENGTH));
    expect(Array.from(over)).toHaveLength(MAX_SUBJECT_LENGTH);
    expect(over).toBe(`Re: ${EMOJI.repeat(MAX_SUBJECT_LENGTH - 4)}`);
  });

  it("trims AFTER truncating: a cut that lands after a space leaves no trailing space", () => {
    // "Re: " + 295 x + " " + y: the cap falls right after the space.
    const subject = replySubject(`${"x".repeat(MAX_SUBJECT_LENGTH - 5)} yyyy`);
    expect(subject).toBe(`Re: ${"x".repeat(MAX_SUBJECT_LENGTH - 5)}`);
    expect(subject.endsWith(" ")).toBe(false);
  });

  it("keeps non-ASCII text intact", () => {
    expect(replySubject(`회의 일정 확인 ${EMOJI}`)).toBe(`Re: 회의 일정 확인 ${EMOJI}`);
  });
});

describe("checkedSubject — an agent-supplied subject, checked and not repaired", () => {
  it("accepts a plain subject, trimmed", () => {
    expect(checkedSubject("Thursday works")).toBe("Thursday works");
    expect(checkedSubject("  Thursday works  ")).toBe("Thursday works");
  });

  it("accepts exactly the cap in code points, emoji included", () => {
    expect(checkedSubject("x".repeat(MAX_SUBJECT_LENGTH))).not.toBeNull();
    expect(checkedSubject(EMOJI.repeat(MAX_SUBJECT_LENGTH))).toBe(EMOJI.repeat(MAX_SUBJECT_LENGTH));
  });

  it("refuses one code point over the cap", () => {
    expect(checkedSubject("x".repeat(MAX_SUBJECT_LENGTH + 1))).toBeNull();
    expect(checkedSubject(EMOJI.repeat(MAX_SUBJECT_LENGTH + 1))).toBeNull();
  });

  it("refuses every line break and control character, tested before trimming", () => {
    for (const subject of [
      "Hi\r\nBcc: attacker@evil.test",
      "Hi\nthere",
      "Hi\rthere",
      "Hi\r\n",
      "\nHi",
      `Hi${cp(0)}there`,
      `Hi${LS}there`,
      "Hi\tthere",
    ]) {
      expect(checkedSubject(subject), JSON.stringify(subject)).toBeNull();
    }
  });

  it("strips bidi and zero-width controls from a supplied subject instead of refusing it", () => {
    expect(checkedSubject(`Invoice ${RLO}fdp.exe`)).toBe("Invoice fdp.exe");
    expect(checkedSubject(`pay${ZWSP}pal`)).toBe("paypal");
  });

  it("refuses a subject that is empty, blank or only invisible characters", () => {
    for (const subject of ["", "   ", `${ZWSP}${RLO}`, ` ${ZWSP} `]) {
      expect(checkedSubject(subject), JSON.stringify(subject)).toBeNull();
    }
  });
});
