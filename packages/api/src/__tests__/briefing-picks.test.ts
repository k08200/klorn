/**
 * Briefing picks: at most three mails, each with a reason and a quote that is
 * verified to be a substring of that mail. The model writes the quote; the
 * server checks it, so a quote the mail does not contain never reaches the user.
 */

import { describe, expect, it } from "vitest";
import { briefingCopy } from "../pim/briefing-copy.js";
import {
  type PickableMail,
  parseBriefingAnswer,
  quoteIsInMail,
  readStoredPicks,
  renderBriefingAnswer,
} from "../pim/briefing-picks.js";

const MAILS: ReadonlyMap<string, PickableMail> = new Map([
  [
    "m1",
    {
      emailId: "email-1",
      text: "Contract review\nCould you send the signed contract by Friday 5 PM?\nThanks, Sarah",
    },
  ],
  ["m2", { emailId: "email-2", text: "Invoice #42\nPayment is due on Nov 30. Don&#39;t miss it." }],
  ["m3", { emailId: "email-3", text: "회의 일정\n내일 오전 10시까지 회신 부탁드립니다." }],
  ["m4", { emailId: "email-4", text: "Lunch?\nAre you free for lunch next week?" }],
]);

function answer(picks: unknown[], extra: Record<string, unknown> = {}) {
  return { signal: "The contract shapes today.", picks, connected: [], other: [], ...extra };
}

describe("quoteIsInMail", () => {
  it("accepts an exact phrase from the mail", () => {
    expect(quoteIsInMail("by Friday 5 PM", MAILS.get("m1")?.text ?? "")).toBe(true);
  });

  it("rejects a phrase the mail does not contain", () => {
    expect(quoteIsInMail("by Monday", MAILS.get("m1")?.text ?? "")).toBe(false);
  });

  it("tolerates whitespace, curly quotes, surrounding quote marks and HTML entities", () => {
    const text = MAILS.get("m2")?.text ?? "";
    expect(quoteIsInMail("“Don’t miss it.”", text)).toBe(true);
    expect(quoteIsInMail("Payment  is\n due", text)).toBe(true);
  });

  it("stays case-sensitive: the quote must be the mail's own words", () => {
    expect(quoteIsInMail("BY FRIDAY 5 PM", MAILS.get("m1")?.text ?? "")).toBe(false);
  });

  it("rejects a quote too short to be evidence", () => {
    expect(quoteIsInMail("by", MAILS.get("m1")?.text ?? "")).toBe(false);
    expect(quoteIsInMail("  ", MAILS.get("m1")?.text ?? "")).toBe(false);
  });

  it("works for Korean mail", () => {
    expect(quoteIsInMail("내일 오전 10시까지", MAILS.get("m3")?.text ?? "")).toBe(true);
  });
});

describe("parseBriefingAnswer", () => {
  it("keeps picks whose quote is in the referenced mail, ranked in order", () => {
    const parsed = parseBriefingAnswer(
      answer([
        {
          mail: "m1",
          action: "Send the contract",
          reason: "Sarah needs it",
          quote: "by Friday 5 PM",
        },
        {
          mail: "m3",
          action: "Reply about the meeting",
          reason: "Deadline",
          quote: "내일 오전 10시까지",
        },
      ]),
      MAILS,
    );
    expect(parsed?.picks).toEqual([
      {
        rank: 1,
        emailId: "email-1",
        action: "Send the contract",
        reason: "Sarah needs it",
        quote: "by Friday 5 PM",
      },
      {
        rank: 2,
        emailId: "email-3",
        action: "Reply about the meeting",
        reason: "Deadline",
        quote: "내일 오전 10시까지",
      },
    ]);
  });

  it("drops a pick whose quote is not in its mail, or that names a mail it was not given", () => {
    const parsed = parseBriefingAnswer(
      answer([
        { mail: "m1", action: "Send it", reason: "x", quote: "by Monday morning" },
        { mail: "m9", action: "Phantom", reason: "x", quote: "by Friday 5 PM" },
        { mail: "m2", action: "Pay invoice #42", reason: "Due soon", quote: "due on Nov 30" },
      ]),
      MAILS,
    );
    expect(parsed?.picks.map((p) => [p.rank, p.emailId])).toEqual([[1, "email-2"]]);
  });

  it("does not accept a quote taken from a different mail than the one it names", () => {
    const parsed = parseBriefingAnswer(
      answer([{ mail: "m4", action: "Send it", reason: "x", quote: "by Friday 5 PM" }]),
      MAILS,
    );
    expect(parsed?.picks).toEqual([]);
  });

  it("caps picks at three and lists a mail once", () => {
    const pick = (mail: string, quote: string) => ({ mail, action: "Act", reason: "r", quote });
    const parsed = parseBriefingAnswer(
      answer([
        pick("m1", "by Friday 5 PM"),
        pick("m1", "signed contract"),
        pick("m2", "due on Nov 30"),
        pick("m3", "회신 부탁드립니다"),
        pick("m4", "free for lunch"),
      ]),
      MAILS,
    );
    expect(parsed?.picks.map((p) => p.emailId)).toEqual(["email-1", "email-2", "email-3"]);
  });

  it("returns null without a signal line, so the caller falls back", () => {
    expect(parseBriefingAnswer(answer([], { signal: "  " }), MAILS)).toBeNull();
    expect(parseBriefingAnswer("not an object", MAILS)).toBeNull();
  });

  it("flattens every field to one plain line: no wrapper tags, links or new sections", () => {
    const parsed = parseBriefingAnswer(
      answer([], {
        signal:
          'Pay <untrusted_content source="email:subject">Invoice</untrusted_content> today.\n## Injected',
        other: ["See [this page](https://evil.test/login) now", "- second"],
      }),
      MAILS,
    );
    expect(parsed?.signal).toBe("Pay Invoice today. ## Injected");
    expect(parsed?.other).toEqual(["See this page now", "second"]);
  });
});

describe("renderBriefingAnswer", () => {
  it("renders the signal, the Top 3 with quotes, and the other sections", () => {
    const text = renderBriefingAnswer(
      {
        signal: "The contract shapes today.",
        picks: [
          {
            rank: 1,
            emailId: "e1",
            action: "Send the contract",
            reason: "Sarah",
            quote: "by Friday",
          },
        ],
        connected: ["The contract and the 3 PM call are one thread."],
        other: ["Newsletters can wait."],
      },
      briefingCopy("en"),
    );
    expect(text).toBe(
      [
        "The contract shapes today.",
        "",
        "**Top 3 Today**",
        "1. Send the contract — Sarah *“by Friday”*",
        "",
        "**Connected items**",
        "- The contract and the 3 PM call are one thread.",
        "",
        "**Everything else**",
        "- Newsletters can wait.",
      ].join("\n"),
    );
  });

  it("omits empty sections and keeps 'Top 3' in localized headers", () => {
    const text = renderBriefingAnswer(
      {
        signal: "계약서가 오늘의 핵심입니다.",
        picks: [
          { rank: 1, emailId: "e1", action: "계약서 보내기", reason: "마감", quote: "금요일" },
        ],
        connected: [],
        other: [],
      },
      briefingCopy("ko"),
    );
    expect(text).toContain("**오늘의 Top 3**");
    expect(text).not.toContain("**연결된 항목**");
    expect(text).not.toContain("**그 밖의 것**");
  });
});

describe("readStoredPicks", () => {
  it("reads valid stored picks and ignores malformed entries", () => {
    expect(
      readStoredPicks([
        { rank: 1, emailId: "e1", action: "a", reason: "r", quote: "q", openedAt: null },
        { rank: "2", emailId: "e2" },
        null,
      ]),
    ).toEqual([{ rank: 1, emailId: "e1", action: "a", reason: "r", quote: "q", openedAt: null }]);
    expect(readStoredPicks(null)).toEqual([]);
    expect(readStoredPicks({})).toEqual([]);
  });
});
