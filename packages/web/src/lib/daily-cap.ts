/**
 * The assistant's daily AI allowance, as the chat turn reports it.
 *
 * A turn over the per-user daily cost cap answers with `errorCode`:
 * DAILY_COST_CAP_FREE for a free user on the free allowance (the line offers
 * the upgrade), DAILY_COST_CAP for everyone else (no upsell to someone who
 * already pays). The reply itself is the server's English sentence, so the
 * bubble that carries it renders the localized line instead. A turn without
 * the field (an older API) renders exactly as before.
 */

export type DailyCapCode = "DAILY_COST_CAP_FREE" | "DAILY_COST_CAP";

export interface DailyCapNotice {
  messageKey: string;
  upgrade: boolean;
}

const NOTICES: Record<DailyCapCode, DailyCapNotice> = {
  DAILY_COST_CAP_FREE: { messageKey: "dailyCap.free", upgrade: true },
  DAILY_COST_CAP: { messageKey: "dailyCap.paid", upgrade: false },
};

function isDailyCapCode(value: unknown): value is DailyCapCode {
  return value === "DAILY_COST_CAP_FREE" || value === "DAILY_COST_CAP";
}

export function dailyCapNotice(code: unknown): DailyCapNotice | null {
  return isDailyCapCode(code) ? NOTICES[code] : null;
}

/** The capped turn: its code, and the reply the server persisted for it. */
export interface CapTurn {
  code: DailyCapCode;
  reply: string;
}

export function capTurnFrom(
  turn: { reply?: unknown; errorCode?: unknown } | undefined,
): CapTurn | null {
  if (!turn || !isDailyCapCode(turn.errorCode) || typeof turn.reply !== "string") return null;
  return { code: turn.errorCode, reply: turn.reply };
}

interface BubbleMessage {
  role: "USER" | "ASSISTANT" | "SYSTEM";
  content: string;
  metadata: { errorCode?: unknown } | null;
}

/**
 * The cap code a chat bubble stands for, or null for an ordinary bubble. A
 * code stored on the message wins (it survives a reload); otherwise the
 * assistant bubble whose text is the capped turn's reply.
 */
export function capCodeForMessage(
  message: BubbleMessage,
  capTurn: CapTurn | null,
): DailyCapCode | null {
  if (message.role !== "ASSISTANT") return null;
  const stored = message.metadata?.errorCode;
  if (isDailyCapCode(stored)) return stored;
  if (capTurn && message.content === capTurn.reply) return capTurn.code;
  return null;
}
