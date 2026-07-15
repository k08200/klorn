/**
 * Wire contract for POST /api/email/:id/reply-options — three
 * tone-differentiated reply drafts (accept / decline / info) for
 * one-keystroke reply surfaces (desktop PushCard, future mobile actions).
 * Served by packages/api/src/routes/email-replies.ts.
 *
 * The tone order is part of the contract: clients map keys 1/2/3 to the
 * array positionally, so the server must always send accept, decline, info.
 */

export type ReplyOptionTone = "accept" | "decline" | "info";

export interface ReplyOptionWire {
  tone: ReplyOptionTone;
  body: string;
}

export interface ReplyOptionsResponseWire {
  /** Reply-to address extracted from the original sender. */
  to: string;
  /** Original subject with a single `Re:` prefix. */
  subject: string;
  /** Exactly 3 drafts, always in accept / decline / info order. */
  options: ReplyOptionWire[];
}
