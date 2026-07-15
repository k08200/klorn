/**
 * Wire contract for the daily Attention Receipt —
 * `GET /api/inbox/receipt/today` and `POST /api/inbox/receipt/undo/:id`.
 * Built by packages/api/src/routes/receipt.ts; rendered by the web receipt
 * page and the firewall board's receipt strip. Both sides import these
 * types, so a shape change that would desync server and client fails to
 * compile instead of failing in production.
 */

export interface ReceiptItem {
  id: string;
  title: string;
  source: string;
  type: string;
  tierReason: string | null;
  surfacedAt: string;
  /** Pushed items only: push delivery outcome. */
  pushStatus?: string;
  pushClickedAt?: string | null;
}

export interface DailyReceiptSummary {
  /** Signals Klorn evaluated. */
  totalSeen: number;
  /** Pushed + pending items the user saw. */
  totalInterrupted: number;
  /** Silenced (would have been noise). */
  savedFromInbox: number;
  /** Executed without asking. */
  autoHandled: number;
  /** 1-2 sentence human summary. */
  narrative: string;
}

export interface DailyReceipt {
  /** YYYY-MM-DD in the user's timezone. */
  date: string;
  silenced: ReceiptItem[];
  queued: ReceiptItem[];
  pushed: ReceiptItem[];
  auto: ReceiptItem[];
  summary: DailyReceiptSummary;
}

export interface ReceiptUndoResponse {
  ok: boolean;
  message: string;
}
