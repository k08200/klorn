/**
 * What the Klorn mailbox's inbound webhook tells an operator (step E1b of
 * docs/providers/unified-platform-plan.md).
 *
 * A drop that could hide a systemic fault (a refused key, a schema drift, a
 * store bug, a forward Resend refuses) is never silent: it becomes a Sentry
 * event, `klorn-mailbox.<scope>`. Resend retries every delivery for about
 * 28 h, so each scope reports at most once an hour, and re-arms after it.
 * The same limit applies to repetitive log lines (rejected signatures).
 *
 * An event carries the email id, a status, or an error class or Resend error
 * name: never an address, a subject, a body or a key.
 */

import { captureError } from "../sentry.js";

export const REPORT_WINDOW_MS = 60 * 60_000;
const SCOPE_PREFIX = "klorn-mailbox";

export interface ReportExtra {
  emailId?: string;
  status?: number;
  /** An error class, a Resend error name, or a retry reason code. */
  kind?: string;
}

export interface InboundReporter {
  report(scope: string, extra: ReportExtra): void;
  log(level: "warn" | "error", key: string, line: string): void;
}

/**
 * One reporter per registered route, so its windows are process-wide. A report
 * held back inside a window is counted, and the next one sent for that scope
 * carries the count as `suppressed`.
 */
export function createInboundReporter(now: () => number = Date.now): InboundReporter {
  const lastAt = new Map<string, number>();
  const heldBack = new Map<string, number>();
  /** The count held back since the last send, or null while the window is open. */
  const due = (key: string): number | null => {
    const previous = lastAt.get(key);
    if (previous !== undefined && now() - previous < REPORT_WINDOW_MS) {
      heldBack.set(key, (heldBack.get(key) ?? 0) + 1);
      return null;
    }
    lastAt.set(key, now());
    const suppressed = heldBack.get(key) ?? 0;
    heldBack.delete(key);
    return suppressed;
  };
  return {
    report(scope, extra) {
      const suppressed = due(`report:${scope}`);
      if (suppressed === null) return;
      const suffix = extra.kind ? `: ${extra.kind}` : "";
      captureError(new Error(`[${SCOPE_PREFIX}] ${scope}${suffix}`), {
        tags: { scope: `${SCOPE_PREFIX}.${scope}` },
        extra: suppressed > 0 ? { ...extra, suppressed } : { ...extra },
      });
    },
    log(level, key, line) {
      const suppressed = due(`log:${key}`);
      if (suppressed === null) return;
      const message = suppressed > 0 ? `${line} (suppressed=${suppressed})` : line;
      if (level === "error") console.error(message);
      else console.warn(message);
    },
  };
}
