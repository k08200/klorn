/**
 * Subscriptions (Subscriptions artboard): the senders of the last 90 days of
 * list mail, per connected account (never merged), with how much of it was
 * read. 구독취소 per row; "거의 안 읽는 N곳 한 번에 정리" unsubscribes the
 * rarely-read ones after a confirmation that lists them, and clears their
 * mail from Klorn's lists (처리 완료) — nothing is ever deleted.
 *
 * GET /api/email/subscriptions · POST /api/email/subscriptions/unsubscribe
 * (dark unless BULK_UNSUBSCRIBE_ENABLED; Mail hides the entry point on 404).
 */
import { useQueryClient } from "@tanstack/react-query";
import { type ReactNode, useState } from "react";
import { isApiError } from "../../api/client";
import { useInboxes } from "../../api/queries";
import type { EmailSubscriptionWire } from "../../api/wire";
import { getServices } from "../../app/services";
import { useI18n } from "../../i18n/I18nProvider";
import { useLayout } from "../../layout/LayoutContext";
import { openExternal } from "../../platform/external";
import { hapticSuccess, hapticWarning } from "../../platform/haptics";
import { MailGlyph } from "../../ui/MailGlyph";
import { Sheet } from "../../ui/Sheet";
import { EmptyState, ProblemState, SkeletonRows } from "../../ui/StateView";
import { mailKeys, useSubscriptions } from "./data";
import {
  accountOf,
  avatarTone,
  monogram,
  rarelyRead,
  readPercent,
  readTone,
  subscriptionKey,
  subscriptionStats,
} from "./model";
import { useAccountLabel } from "./useAccountLabel";

type RowState = "working" | "done" | "link" | "failed";

export function SubscriptionsScreen({ onBack }: { onBack: () => void }) {
  const { t, tn, intlTag } = useI18n();
  const plan = useLayout();
  const qc = useQueryClient();
  const subs = useSubscriptions();
  const inboxes = useInboxes().data?.inboxes ?? [];
  const labelOf = useAccountLabel(inboxes);
  const accountName = (sub: EmailSubscriptionWire) =>
    labelOf(accountOf(sub.linkedInboxAccountId, inboxes)) ??
    sub.accountLabel ??
    t("mail.account.primary");
  const [rowState, setRowState] = useState<Record<string, RowState>>({});
  const [confirm, setConfirm] = useState<EmailSubscriptionWire[] | null>(null);
  const [bulkBusy, setBulkBusy] = useState(false);
  const [summary, setSummary] = useState<string | null>(null);

  const list = subs.data?.subscriptions ?? [];
  const stats = subscriptionStats(list);
  const rare = rarelyRead(list).filter((s) => {
    const st = rowState[subscriptionKey(s)];
    return st !== "done" && st !== "link";
  });
  const nf = new Intl.NumberFormat(intlTag);

  const unsubscribe = async (sub: EmailSubscriptionWire, archive: boolean): Promise<RowState> => {
    const key = subscriptionKey(sub);
    setRowState((s) => ({ ...s, [key]: "working" }));
    try {
      const res = await getServices().ep.subscriptions.unsubscribe({
        sender: sub.sender,
        linkedInboxAccountId: sub.linkedInboxAccountId,
        archive,
      });
      const next: RowState = res.done ? "done" : "link";
      setRowState((s) => ({ ...s, [key]: next }));
      // Nothing automatic worked: the list's own page, in the system browser.
      if (!res.done && !archive) void openExternal(res.url);
      return next;
    } catch (err) {
      setRowState((s) => ({ ...s, [key]: "failed" }));
      if (isApiError(err) && err.status === 404)
        void qc.invalidateQueries({ queryKey: mailKeys.subscriptions });
      return "failed";
    }
  };

  const bulk = async () => {
    if (!confirm) return;
    setBulkBusy(true);
    let done = 0;
    let failed = 0;
    for (const sub of confirm) {
      const r = await unsubscribe(sub, true);
      if (r === "failed") failed++;
      else done++;
    }
    setBulkBusy(false);
    setConfirm(null);
    if (failed) hapticWarning();
    else hapticSuccess();
    setSummary(failed ? t("subs.bulk.partial", { done, failed }) : tn("subs.bulk.done", done));
    void qc.invalidateQueries({ queryKey: mailKeys.feeds });
  };

  let body: ReactNode;
  if (subs.isPending) {
    body = <SkeletonRows rows={4} label={t("subs.loading")} />;
  } else if (subs.isError && !subs.data) {
    body = (
      <ProblemState
        kind={isApiError(subs.error) && subs.error.isOffline ? "offline" : "error"}
        onRetry={() => void subs.refetch()}
      />
    );
  } else if (subs.data === null) {
    body = <EmptyState tone="neutral" icon="mail" title={t("subs.unavailable")} />;
  } else if (list.length === 0) {
    body = <EmptyState title={t("subs.empty.title")} body={t("subs.empty.body")} />;
  } else {
    body = (
      <>
        <div className="subs-stats card">
          <div className="subs-stat">
            <span className="subs-stat__n">{nf.format(stats.senders)}</span>
            <span className="subs-stat__label">{t("subs.stat.senders")}</span>
          </div>
          <div className="subs-stat">
            <span className="subs-stat__n">{nf.format(stats.mail)}</span>
            <span className="subs-stat__label">{t("subs.stat.mail")}</span>
          </div>
          <div className="subs-stat">
            <span className="subs-stat__n">{stats.readPercent}%</span>
            <span className="subs-stat__label">{t("subs.stat.read")}</span>
          </div>
        </div>
        <ul className="subs-list card" aria-label={t("subs.list.label")}>
          {list.map((sub) => {
            const key = subscriptionKey(sub);
            const pct = readPercent(sub);
            const name = sub.displayName ?? sub.sender;
            const state = rowState[key];
            const account = accountName(sub);
            return (
              <li key={key} className="subs-row">
                <span
                  className={`subs-row__tile mail-avatar--${avatarTone(name)}`}
                  aria-hidden="true"
                >
                  {monogram(name)}
                </span>
                <span className="subs-row__text">
                  <span className="subs-row__name">{name}</span>
                  <span className="subs-row__meta">
                    <span className="meter" aria-hidden="true">
                      <span
                        className={`meter__fill meter__fill--${readTone(pct)}`}
                        style={{ width: `${Math.max(pct, 3)}%` }}
                      />
                    </span>
                    <span className="subs-row__meta-text">
                      {t("subs.row.meta", { pct, account, count: nf.format(sub.count) })}
                    </span>
                  </span>
                </span>
                {state === "done" ? (
                  <span className="subs-row__done" role="status">
                    <MailGlyph name="done" size={16} strokeWidth={2.2} />
                    {t("subs.row.done")}
                  </span>
                ) : state === "link" ? (
                  <span className="subs-row__done subs-row__done--link" role="status">
                    <MailGlyph name="external" size={16} />
                    {t("subs.row.link")}
                  </span>
                ) : (
                  <button
                    type="button"
                    className="subs-row__button"
                    disabled={state === "working" || bulkBusy}
                    aria-label={t("subs.row.unsubscribeFrom", { name })}
                    onClick={() => void unsubscribe(sub, false)}
                  >
                    {state === "working"
                      ? t("subs.row.working")
                      : state === "failed"
                        ? t("subs.row.retry")
                        : t("subs.row.unsubscribe")}
                  </button>
                )}
              </li>
            );
          })}
        </ul>
      </>
    );
  }

  return (
    <div className="subs" data-nav={plan.nav}>
      <div className="subs__nav">
        <button type="button" className="reader-nav__back" onClick={onBack}>
          <MailGlyph name="chevronLeft" size={24} strokeWidth={2.2} />
          {t("tab.mail")}
        </button>
      </div>
      <div className="subs__scroll" aria-busy={subs.isPending || undefined}>
        <div className="subs__head">
          <h1 className="screen-title">{t("subs.title")}</h1>
          <p className="subs__intro">{t("subs.intro", { days: subs.data?.windowDays ?? 90 })}</p>
        </div>
        {summary ? (
          <p className="subs__summary" role="status">
            {summary}
          </p>
        ) : null}
        {body}
      </div>
      {rare.length > 0 ? (
        <div className="subs-bar">
          <button
            type="button"
            className="sheet-cta sheet-cta--dark"
            disabled={bulkBusy}
            onClick={() => setConfirm(rare)}
          >
            {tn("subs.bulk.button", rare.length)}
          </button>
          <span className="subs-bar__note">{t("subs.bulk.note")}</span>
        </div>
      ) : null}
      <Sheet
        open={confirm !== null}
        onClose={() => (bulkBusy ? undefined : setConfirm(null))}
        title={tn("subs.confirm.title", confirm?.length ?? 0)}
        subtitle={t("subs.confirm.subtitle")}
        footer={
          <>
            <button
              type="button"
              className="sheet-cta"
              disabled={bulkBusy}
              onClick={() => void bulk()}
            >
              {bulkBusy ? t("subs.row.working") : tn("subs.confirm.go", confirm?.length ?? 0)}
            </button>
            <button
              type="button"
              className="sheet-cta sheet-cta--quiet"
              disabled={bulkBusy}
              onClick={() => setConfirm(null)}
            >
              {t("subs.confirm.cancel")}
            </button>
          </>
        }
      >
        <ul className="subs-confirm">
          {(confirm ?? []).map((sub) => (
            <li key={subscriptionKey(sub)} className="subs-confirm__row">
              <span className="subs-confirm__name">{sub.displayName ?? sub.sender}</span>
              <span className="subs-confirm__meta">
                {t("subs.row.meta", {
                  pct: readPercent(sub),
                  account: accountName(sub),
                  count: nf.format(sub.count),
                })}
              </span>
            </li>
          ))}
        </ul>
      </Sheet>
    </div>
  );
}
