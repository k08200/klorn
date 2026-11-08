/**
 * Attention engine v3 read fields (docs/design/attention-engine-v3.md §3(5)
 * "Reasons and API contract"). Present only for a user under JUDGE_V3_POLICY;
 * absent (not null) for everyone else.
 */

/** One reason; reasons[0] decides the lane. Clients localise from code + params. */
export interface V3Reason {
  code: string;
  fact: string | null;
  /**
   * A verbatim quote from the mail, so its author is whoever sent the mail
   * (possibly an attacker). Render it as a literal quote attributed to the mail:
   * no markdown or HTML, no link or data detection, never a regex built from it
   * to highlight the body, never phrased as Klorn's own statement.
   */
  evidence: string | null;
  evidenceIn: "subject" | "body" | null;
  params: Record<string, string | number | boolean | null>;
}

export interface V3ItemBlock {
  /** The policy version that decided ("v3.0", "v3.1"); "v2" when the v2 lane stood; null when v3 never decided. */
  policyVersion: string | null;
  /** 1-based position in the ranked QUEUE; null outside a ranked QUEUE view. */
  rank: number | null;
  /** The daily interrupt budget held this mail, and it still shows the hold. */
  held: boolean;
  /** ISO 8601 UTC; null hides the chip. */
  due: string | null;
  threadTurn: "mine_to_reply" | "theirs" | "none" | null;
  reasons: V3Reason[];
}

export interface InterruptBudgetStatus {
  /** null = no limit. */
  limit: number | null;
  used: number;
  /** The user's local day, YYYY-MM-DD. */
  day: string;
}

/** Today fields: on `GET /api/email?window=today` and `GET /api/inbox/firewall`. */
export interface V3TodayFields {
  interruptBudget?: InterruptBudgetStatus;
  queueTotal?: number;
  /** When the ranks were computed (ISO). Also on a ranked QUEUE lane page. */
  rankedAt?: string;
}
