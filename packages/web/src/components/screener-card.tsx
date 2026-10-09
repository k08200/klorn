"use client";

import { useState } from "react";
import { useT } from "../lib/i18n";
import { formatRelativeIntl } from "../lib/text";
import { useScreener } from "../lib/use-screener";

/** Rows shown before the list collapses behind "show all". */
const VISIBLE_LIMIT = 5;

/**
 * Screener — the read-and-decide surface for `judge/screener.ts` (#1221).
 *
 * That PR shipped `GET /api/screener/pending` and `POST /api/screener/decision`
 * and said, in its own words, "No UI. Nothing renders them yet." An API nobody
 * can reach is worth exactly as much as one that does not exist, so this is the
 * other half.
 *
 * Three properties are inherited from the server and must not be softened here:
 *
 *   1. **Nothing is held.** HEY parks unscreened mail until you rule on it.
 *      Klorn does not: mail is classified and delivered exactly as it is today
 *      whether or not you ever open this. The copy therefore promises a
 *      shortcut, never a quarantine — telling a user their mail is waiting on
 *      them when it is not would be the worst kind of true-sounding lie.
 *
 *   2. **The flag is server-side.** With `SCREENER_ENABLED` unset the routes
 *      answer 404, not 403, so an unshipped feature is indistinguishable from
 *      one that does not exist. This mirrors that exactly: a 404 renders
 *      `null`, and no flag is plumbed to the client to leak the answer.
 *
 *   3. **The write does not fail open.** `recordScreenerDecision` returns 500
 *      rather than pretending, because someone who clicks "block" and sees no
 *      error will assume the sender is handled. So a failed decision leaves the
 *      row exactly where it was and says so — it is never optimistically
 *      removed.
 *
 * Zero pending renders nothing at all. An empty "no new senders" box on the
 * busiest screen in the app is a permanent claim on attention in exchange for
 * no information, which is the behaviour this whole product argues against.
 */
export default function ScreenerCard() {
  const { t, locale } = useT();
  const [expanded, setExpanded] = useState(false);
  const { pending, deciding, decide } = useScreener();

  if (!pending || pending.length === 0) return null;

  const rows = expanded ? pending : pending.slice(0, VISIBLE_LIMIT);
  const hidden = pending.length - rows.length;

  return (
    <section
      data-testid="screener-card"
      aria-labelledby="screener-heading"
      className="panel-elevated mb-4 rounded-2xl border border-line/70 bg-surface-panel p-5"
    >
      <header className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
        <h2 id="screener-heading" className="text-base font-semibold text-ink">
          {t("screener.title")}
        </h2>
        <span className="text-xs text-ink-dim">
          {t("screener.count", { count: String(pending.length) })}
        </span>
      </header>
      <p className="mt-1.5 text-[13px] leading-5 text-ink-mid">{t("screener.subtitle")}</p>

      <ul className="mt-4 space-y-1.5">
        {rows.map((row) => {
          const busy = deciding[row.sender];
          return (
            <li
              key={row.sender}
              className="flex flex-wrap items-center gap-x-3 gap-y-2 rounded-xl border border-line bg-surface-raised px-3 py-2"
            >
              <div className="min-w-0 flex-1">
                <p className="truncate text-sm font-medium text-ink" title={row.sender}>
                  {row.sender}
                </p>
                <p className="mt-0.5 text-[11px] text-ink-dim">
                  {row.lastReceivedAt
                    ? t("screener.meta", {
                        count: String(row.messageCount),
                        when: formatRelativeIntl(row.lastReceivedAt, locale, t("screener.justNow")),
                      })
                    : t("screener.metaNoDate", { count: String(row.messageCount) })}
                </p>
              </div>
              <div className="flex shrink-0 items-center gap-2">
                <button
                  type="button"
                  disabled={Boolean(busy)}
                  onClick={() => decide(row.sender, "ALLOW")}
                  className="focus-ring inline-flex min-h-11 items-center rounded-lg border border-line px-3 text-xs font-semibold text-ink transition hover:border-line-strong hover:bg-surface-hover disabled:cursor-not-allowed disabled:opacity-60"
                >
                  {busy === "ALLOW" ? t("screener.working") : t("screener.allow")}
                </button>
                <button
                  type="button"
                  disabled={Boolean(busy)}
                  onClick={() => decide(row.sender, "BLOCK")}
                  className="focus-ring inline-flex min-h-11 items-center rounded-lg border border-state-danger-line px-3 text-xs font-semibold text-state-danger-ink transition hover:bg-state-danger-bg disabled:cursor-not-allowed disabled:opacity-60"
                >
                  {busy === "BLOCK" ? t("screener.working") : t("screener.block")}
                </button>
              </div>
            </li>
          );
        })}
      </ul>

      {hidden > 0 && (
        <button
          type="button"
          onClick={() => setExpanded(true)}
          className="focus-ring mt-3 inline-flex min-h-11 items-center text-xs font-semibold text-accent-deep hover:underline"
        >
          {t("screener.showAll", { count: String(hidden) })}
        </button>
      )}

      <p className="mt-3 text-[11px] leading-4 text-ink-dim">{t("screener.noHold")}</p>
    </section>
  );
}
