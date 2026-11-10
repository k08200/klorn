/**
 * The Mail list pane (Mail artboard on phones, FoldOpen / TabletLandscape on
 * wide windows): large title, account filter, search, lane tabs, then the
 * rows grouped by day — with pull-to-refresh, infinite scroll, the compose
 * button and the skeleton / empty / error / offline states.
 */
import type { EmailLaneCounts, EmailListItem, InboxOption, LiveTier } from "@klorn/contract";
import { type ReactNode, useEffect, useMemo, useRef } from "react";
import { isApiError } from "../../api/client";
import type { InboxScope } from "../../api/endpoints";
import { useI18n } from "../../i18n/I18nProvider";
import { useLayout } from "../../layout/LayoutContext";
import { useRouter } from "../../router/Router";
import { type LaneParam, LIVE_LANES } from "../../router/routes";
import { Icon } from "../../ui/Icon";
import { MailGlyph } from "../../ui/MailGlyph";
import { SourceBadge } from "../../ui/SourceBadge";
import { EmptyState, OfflineBanner, ProblemState, SkeletonRows } from "../../ui/StateView";
import { PULL_THRESHOLD, usePullToRefresh } from "../../ui/usePullToRefresh";
import { MailRow } from "./MailRow";
import { accountOf, allLanesTotal, groupByDay } from "./model";
import { useAccountLabel } from "./useAccountLabel";

export interface MailListProps {
  lane: LaneParam;
  inbox: InboxScope;
  inboxes: readonly InboxOption[];
  search: string;
  onSearch: (value: string) => void;
  rows: EmailListItem[];
  reasons: ReadonlyMap<string, string | null>;
  counts: EmailLaneCounts | undefined;
  state: {
    loading: boolean;
    failed: boolean;
    offline: boolean;
    refetching: boolean;
    hasMore: boolean;
    loadingMore: boolean;
    showBanner: boolean;
    needsConnection: boolean;
  };
  selectedId?: string;
  selection: ReadonlySet<string> | null;
  now: Date;
  onRefresh: () => Promise<unknown>;
  onLoadMore: () => void;
  onRetry: () => void;
  onOpenAccounts: () => void;
  onOpenMenu: () => void;
  onCompose: () => void;
  onDone: (email: EmailListItem) => void;
  onLane: (email: EmailListItem, origin: "swipe" | "menu") => void;
  onRowActions: (email: EmailListItem) => void;
  onStartSelect: (email: EmailListItem) => void;
  onToggleSelect: (email: EmailListItem) => void;
  onSelectionDone: () => void;
  onSelectionLane: () => void;
  onSelectionCancel: () => void;
}

const TAB_LANES: readonly LaneParam[] = ["ALL", ...LIVE_LANES];

function LaneTabs({ lane, counts }: { lane: LaneParam; counts: EmailLaneCounts | undefined }) {
  const { t, tn } = useI18n();
  const { navigate } = useRouter();
  const total = allLanesTotal(counts);
  return (
    <div className="lane-tabs" role="tablist" aria-label={t("nav.lanes")}>
      {TAB_LANES.map((l) => {
        const on = l === lane;
        const count = l === "ALL" ? total : (counts?.[l as LiveTier].total ?? null);
        const name = l === "ALL" ? t("mail.lane.all") : l;
        return (
          <button
            key={l}
            type="button"
            role="tab"
            aria-selected={on}
            aria-label={count === null ? name : tn("mail.lane.tabCount", count, { lane: name })}
            className={`lane-tab${l === "ALL" ? "" : ` lane-tab--${l.toLowerCase()}`}`}
            data-on={on || undefined}
            onClick={() =>
              navigate(l === "ALL" ? { name: "mail" } : { name: "mail", lane: l }, {
                replace: true,
              })
            }
          >
            {name}
            {count === null ? null : <span className="lane-tab__count">{count}</span>}
          </button>
        );
      })}
    </div>
  );
}

function AccountButton({
  inbox,
  inboxes,
  onOpen,
}: {
  inbox: InboxScope;
  inboxes: readonly InboxOption[];
  onOpen: () => void;
}) {
  const { t } = useI18n();
  const chosen =
    inbox === "all" ? null : (inboxes.find((i) => (i.id ?? "primary") === inbox) ?? null);
  const label = chosen ? (chosen.email ?? t("mail.account.primary")) : t("mail.account.all");
  const stack = chosen ? [chosen] : inboxes.slice(0, 3);
  return (
    <button
      type="button"
      className="account-button"
      onClick={onOpen}
      aria-haspopup="dialog"
      aria-label={t("mail.account.button", { account: label })}
    >
      <span className="account-button__stack" aria-hidden="true">
        {stack.map((i) => (
          <span key={i.id ?? "primary"} className="account-button__badge">
            <SourceBadge inbox={i} size={20} />
          </span>
        ))}
      </span>
      <span className="account-button__label">{label}</span>
      <MailGlyph name="chevronDown" size={14} strokeWidth={2} />
    </button>
  );
}

function PullIndicator({ pull, refreshing }: { pull: number; refreshing: boolean }) {
  const { t } = useI18n();
  if (pull <= 0 && !refreshing) return null;
  return (
    <div
      className="ptr"
      style={{ height: refreshing ? 40 : pull }}
      role="status"
      aria-live="polite"
    >
      <Icon
        name="refresh"
        size={18}
        className={refreshing ? "ptr__icon ptr__icon--spin" : "ptr__icon"}
      />
      <span className="sr-only">
        {refreshing
          ? t("mail.syncing")
          : pull >= PULL_THRESHOLD
            ? t("state.release")
            : t("state.pull")}
      </span>
    </div>
  );
}

export function MailList(props: MailListProps) {
  const { t, tn } = useI18n();
  const plan = useLayout();
  const scrollRef = useRef<HTMLDivElement>(null);
  const sentinel = useRef<HTMLDivElement>(null);
  const variant = plan.panes === 2 || plan.posture === "tabletop" ? "card" : "inset";
  const { pull, refreshing } = usePullToRefresh(scrollRef, props.onRefresh);
  const { state, rows, lane, selection } = props;
  const selecting = selection !== null;

  // Infinite scroll: the sentinel coming into view loads the next page.
  const loadMore = props.onLoadMore;
  const canLoad = state.hasMore && !state.loadingMore;
  useEffect(() => {
    const el = sentinel.current;
    const root = scrollRef.current;
    if (!el || !root || !canLoad || typeof IntersectionObserver === "undefined") return;
    const io = new IntersectionObserver(
      (entries) => {
        if (entries.some((e) => e.isIntersecting)) loadMore();
      },
      { root, rootMargin: "400px 0px" },
    );
    io.observe(el);
    return () => io.disconnect();
  }, [canLoad, loadMore]);

  const sections = useMemo(() => groupByDay(rows, props.now), [rows, props.now]);
  const labelOf = useAccountLabel(props.inboxes);
  const accountCount = props.inboxes.length;

  const renderRow = (email: EmailListItem) => {
    const account = accountOf(email.linkedInboxAccountId, props.inboxes);
    return (
      <MailRow
        key={email.id}
        email={email}
        account={account}
        accountLabel={labelOf(account)}
        reason={props.reasons.get(email.id) ?? email.summary ?? null}
        lane={lane === "ALL" ? undefined : lane}
        variant={variant}
        selected={email.id === props.selectedId}
        selecting={selecting}
        checked={selection?.has(email.id) ?? false}
        now={props.now}
        onDone={() => props.onDone(email)}
        onLane={() => props.onLane(email, "swipe")}
        onLongPress={() => (selecting ? props.onToggleSelect(email) : props.onStartSelect(email))}
        onToggle={() => props.onToggleSelect(email)}
        onActions={() => props.onRowActions(email)}
      />
    );
  };

  let content: ReactNode;
  if (state.loading) {
    content = <SkeletonRows rows={variant === "card" ? 4 : 3} label={t("mail.loading")} />;
  } else if (state.failed) {
    content = <ProblemState kind={state.offline ? "offline" : "error"} onRetry={props.onRetry} />;
  } else if (state.needsConnection) {
    content = (
      <EmptyState
        tone="neutral"
        icon="mail"
        title={t("state.noAccounts.title")}
        body={t("state.noAccounts.body")}
      />
    );
  } else if (rows.length === 0) {
    content = props.search ? (
      <EmptyState
        tone="neutral"
        icon="mail"
        title={t("mail.empty.search", { query: props.search })}
      />
    ) : lane === "PUSH" ? (
      <EmptyState title={t("today.brief.emptyTitle")} body={t("today.brief.emptyBody")} />
    ) : (
      <EmptyState
        title={lane === "ALL" ? t("mail.empty.all") : t("mail.empty.lane", { lane })}
        body={t("mail.empty.body")}
      />
    );
  } else if (variant === "inset") {
    content = sections.map((section) => (
      <section key={section.key} className="mail-day" aria-labelledby={`day-${section.key}`}>
        <h2 id={`day-${section.key}`} className="mail-day__title">
          <DayTitle dayKey={section.key} now={props.now} />
        </h2>
        <ul className="mail-day__rows">{section.rows.map(renderRow)}</ul>
      </section>
    ));
  } else {
    content = <ul className="mail-cards">{rows.map(renderRow)}</ul>;
  }

  return (
    <div className="mail-list" data-variant={variant}>
      {selecting ? (
        <div className="mail-select-bar" role="toolbar" aria-label={t("mail.select.toolbar")}>
          <button
            type="button"
            className="mail-select-bar__cancel"
            onClick={props.onSelectionCancel}
          >
            {t("mail.select.cancel")}
          </button>
          <span className="mail-select-bar__count" aria-live="polite">
            {tn("mail.select.count", selection.size)}
          </span>
        </div>
      ) : null}
      <header className="mail-head">
        <div className="mail-head__row">
          <h1 className="mail-head__title">
            {plan.nav === "sidebar" && lane === "ALL" ? t("mail.title.allMail") : t("tab.mail")}
          </h1>
          <div className="mail-head__actions">
            {accountCount > 1 ? (
              <AccountButton
                inbox={props.inbox}
                inboxes={props.inboxes}
                onOpen={props.onOpenAccounts}
              />
            ) : null}
            <button
              type="button"
              className="mail-head__menu"
              onClick={props.onOpenMenu}
              aria-haspopup="dialog"
              aria-label={t("mail.menu.open")}
            >
              <MailGlyph name="more" size={20} />
            </button>
          </div>
        </div>
        <label className="mail-search">
          <MailGlyph name="search" size={17} strokeWidth={2} className="mail-search__icon" />
          <span className="sr-only">{t("mail.search.label")}</span>
          <input
            type="search"
            enterKeyHint="search"
            value={props.search}
            onChange={(e) => props.onSearch(e.target.value)}
            placeholder={
              accountCount > 1
                ? tn("mail.search.placeholderAccounts", accountCount)
                : t("mail.search.placeholder")
            }
          />
          {props.search ? (
            <button
              type="button"
              className="mail-search__clear"
              onClick={() => props.onSearch("")}
              aria-label={t("mail.search.clear")}
            >
              <MailGlyph name="close" size={16} strokeWidth={2.2} />
            </button>
          ) : null}
        </label>
        <LaneTabs lane={lane} counts={props.counts} />
      </header>
      <div ref={scrollRef} className="mail-scroll" aria-busy={state.loading || undefined}>
        <PullIndicator pull={pull} refreshing={refreshing || (state.refetching && pull > 0)} />
        {state.showBanner ? <OfflineBanner /> : null}
        {content}
        {state.hasMore || state.loadingMore ? (
          <div ref={sentinel} className="mail-more">
            {state.loadingMore ? (
              <span className="mail-more__spinner" role="status">
                <Icon name="refresh" size={18} className="ptr__icon ptr__icon--spin" />
                <span className="sr-only">{t("mail.loadingMore")}</span>
              </span>
            ) : (
              <button type="button" className="button button--quiet" onClick={props.onLoadMore}>
                {t("mail.loadMore")}
              </button>
            )}
          </div>
        ) : null}
      </div>
      {selecting ? (
        <div className="mail-bulk" role="toolbar" aria-label={t("mail.select.actions")}>
          <button
            type="button"
            className="mail-bulk__button"
            disabled={selection.size === 0}
            onClick={props.onSelectionDone}
          >
            <MailGlyph name="done" size={22} />
            {t("mail.action.done")}
          </button>
          <button
            type="button"
            className="mail-bulk__button"
            disabled={selection.size === 0}
            onClick={props.onSelectionLane}
          >
            <MailGlyph name="lane" size={22} />
            {t("mail.action.lane")}
          </button>
        </div>
      ) : (
        <button
          type="button"
          className="compose-fab"
          onClick={props.onCompose}
          aria-label={t("mail.compose.new")}
        >
          <MailGlyph name="compose" size={24} />
        </button>
      )}
    </div>
  );
}

function DayTitle({ dayKey, now }: { dayKey: string; now: Date }) {
  const { t, intlTag } = useI18n();
  if (dayKey === "today") return <>{t("mail.day.today")}</>;
  if (dayKey === "yesterday") return <>{t("mail.day.yesterday")}</>;
  const [y, m, d] = dayKey.split("-").map(Number);
  const date = new Date(y ?? 1970, (m ?? 1) - 1, d ?? 1);
  const days = (now.getTime() - date.getTime()) / 86_400_000;
  return (
    <>
      {new Intl.DateTimeFormat(
        intlTag,
        days < 6 ? { weekday: "long" } : { month: "long", day: "numeric", weekday: "short" },
      ).format(date)}
    </>
  );
}

export function blockState(q: {
  isPending: boolean;
  isError: boolean;
  error: unknown;
  data: unknown;
}): { loading: boolean; failed: boolean; offline: boolean } {
  const failed = q.isError && q.data === undefined;
  return {
    loading: q.isPending && q.data === undefined && !q.isError,
    failed,
    offline: failed && isApiError(q.error) && q.error.isOffline,
  };
}
