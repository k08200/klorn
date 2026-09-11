/**
 * Per-row context signals (mail-first shell, 2026-08-26).
 *
 * The inbox shows one chronological list; the intelligence rides on the rows
 * as labels — the lane chip, plus at most ONE of the signals below so a row
 * never becomes a tag cloud. Every signal is a recorded fact: Gmail's own
 * category labels, or the user's reply history. Nothing here guesses — a
 * wrong "first contact" on a ten-year colleague is worse than no label.
 */

export type GmailCategory = "promotions" | "social" | "updates" | "forums";

/** Categories the LLM judge can pin on a row (EmailMessage.category —
 *  email-classifier.ts). Richer than Gmail's tabs: who the sender IS. */
export type JudgeSignalCategory = "internal" | "customer" | "investor" | "system" | "billing";

export type SignalCategory = GmailCategory | JudgeSignalCategory;

/**
 * What the judge's stored category contributes to the row signal. The
 * relationship/function verdicts (내부/고객/투자자/시스템) surface as-is —
 * they are the detail Gmail's tabs can't see (a security notice from a
 * first-time sender is 시스템, not 첫 연락). "automated" folds into
 * promotions: one bulk-mail category, not two words for the same pile.
 * meeting is the MEETING lane's job; conversation/other claim nothing.
 * Unknown strings (older classifier vocabularies) claim nothing either.
 */
export function judgeSignalOf(category: string | null | undefined): SignalCategory | null {
  switch (category) {
    // The classifier's vocabulary (agent-tool path) — kept for when it, or a
    // future summarize vocabulary, stores these.
    case "internal":
    case "customer":
    case "investor":
    case "system":
      return category;
    // The vocabulary the summarize pass ACTUALLY stores on EmailMessage
    // (email-summarize.ts) — the list the first mapping missed, which is why
    // no judge chip appeared on real rows.
    case "billing":
      return "billing";
    case "engineering":
      // CI/deploy/tooling notices — the founder's github-actions rows.
      return "system";
    case "newsletter":
    case "automated":
      // One bulk-mail category, not three words for the same pile.
      return "promotions";
    // personal/business stay unclaimed: the summarize pass can't tell 회사
    // from 고객, and a wrong claim is worse than none. meeting is the lane's
    // job; conversation/other/unknown claim nothing.
    default:
      return null;
  }
}

/** Fixed precedence; promotions is the strongest claim when Gmail stamps several. */
const CATEGORY_LABELS: [string, GmailCategory][] = [
  ["CATEGORY_PROMOTIONS", "promotions"],
  ["CATEGORY_SOCIAL", "social"],
  ["CATEGORY_UPDATES", "updates"],
  ["CATEGORY_FORUMS", "forums"],
];

export function gmailCategoryOf(labels: string[] | undefined): GmailCategory | null {
  if (!labels?.length) return null;
  const set = new Set(labels);
  for (const [label, category] of CATEGORY_LABELS) {
    if (set.has(label)) return category;
  }
  return null;
}

export type RowSignal =
  | { kind: "category"; category: SignalCategory }
  | { kind: "replied"; count: number }
  | { kind: "first" }
  | null;

/**
 * The one non-lane chip a row shows, in evidence order: the user's declared
 * company domain (a recorded fact about WHO — company-domains.ts), then the
 * judge's verdict (it read the mail; Gmail's tab is a heuristic), then
 * Gmail's tab, then the relationship (a newsletter must never read as
 * "first contact"). A null repliedCount means the engagement lookup did not
 * run for this row, and a missing fact renders as no chip rather than a
 * false one.
 */
export function rowSignalFor(input: {
  /** Sender is on one of the user's declared company domains. */
  internal?: boolean;
  judgeCategory?: string | null;
  category: GmailCategory | null;
  repliedCount: number | null;
}): RowSignal {
  if (input.internal) return { kind: "category", category: "internal" };
  const judged = judgeSignalOf(input.judgeCategory);
  if (judged) return { kind: "category", category: judged };
  if (input.category) return { kind: "category", category: input.category };
  if (input.repliedCount === null) return null;
  if (input.repliedCount > 0) return { kind: "replied", count: input.repliedCount };
  return { kind: "first" };
}
