/**
 * Today (Main / MainDark artboards). Five blocks, each on its own query so one
 * failure never blanks the screen: header + summary, "Needs you now" brief,
 * lanes strip, next event, Approvals. Layout follows the shell's plan:
 * one column on phones, two columns on wide windows, one column per side of a
 * vertical hinge, reading (brief) above a horizontal hinge.
 */
import type { LiveTier } from "@klorn/contract";
import { useQueryClient } from "@tanstack/react-query";
import { type ReactNode, useEffect, useRef, useState } from "react";
import { isApiError } from "../../api/client";
import {
  useEvents,
  useFirewall,
  useLaneCounts,
  useMe,
  usePendingApprovals,
} from "../../api/queries";
import type { CalendarEventWire, PendingActionWire } from "../../api/wire";
import { formatClock, formatLongDate, formatRelativeFromNow } from "../../i18n/format";
import { useI18n } from "../../i18n/I18nProvider";
import { useLayout } from "../../layout/LayoutContext";
import { RAIL_WIDTH, SIDEBAR_WIDTH } from "../../layout/size-class";
import { openExternal } from "../../platform/external";
import { useLinkProps, useRouter } from "../../router/Router";
import { LIVE_LANES, type Route } from "../../router/routes";
import { Icon } from "../../ui/Icon";
import { EmptyState, OfflineBanner, ProblemState, SkeletonRows } from "../../ui/StateView";
import { useOnline } from "../../ui/useOnline";
import { PULL_THRESHOLD, usePullToRefresh } from "../../ui/usePullToRefresh";
import {
  approvalKind,
  approvalSubtitle,
  type BriefItem,
  briefItems,
  dayRangeInZone,
  initialsOf,
  isKnownZone,
  isOngoing,
  meetingService,
  nextEvent,
  remainingEvents,
  repliesOwed,
} from "./model";
import "./today.css";

/** Re-render every minute so "in 32 min" and the next event stay current. */
function useNow(intervalMs = 60_000): Date {
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    const id = setInterval(() => setNow(new Date()), intervalMs);
    return () => clearInterval(id);
  }, [intervalMs]);
  return now;
}

function deviceZone(): string {
  return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
}

type BlockState = { loading: boolean; failed: boolean; offline: boolean; retry: () => void };

function blockState(q: {
  isPending: boolean;
  isError: boolean;
  error: unknown;
  data: unknown;
  refetch: () => unknown;
}): BlockState {
  const failed = q.isError && q.data === undefined;
  return {
    loading: q.isPending && q.data === undefined && !q.isError,
    failed,
    offline: failed && isApiError(q.error) && q.error.isOffline,
    retry: () => void q.refetch(),
  };
}

function BlockProblem({ state }: { state: BlockState }) {
  return <ProblemState kind={state.offline ? "offline" : "error"} onRetry={state.retry} compact />;
}

// ── Header ──────────────────────────────────────────────────────────────────

function TodayHeader({ now, zone, summary }: { now: Date; zone: string; summary: string | null }) {
  const { t, intlTag } = useI18n();
  const me = useMe();
  const accountLink = useLinkProps({ name: "accounts" });
  const initials = me.data ? initialsOf(me.data.name, me.data.email) : "";
  return (
    <header className="today-header">
      <div className="today-header__text">
        <span className="today-header__date">{formatLongDate(now, intlTag, zone)}</span>
        <h1 className="today-header__title">{t("today.title")}</h1>
        {summary === null ? (
          <span className="skeleton skeleton--strong today-header__summary-skeleton" />
        ) : (
          <p className="today-header__summary">{summary}</p>
        )}
      </div>
      <a className="today-header__account" href={accountLink.href} onClick={accountLink.onClick}>
        <span className="sr-only">{t("nav.accountButton")}</span>
        <span className="avatar" aria-hidden="true">
          {initials}
        </span>
      </a>
    </header>
  );
}

// ── Brief ───────────────────────────────────────────────────────────────────

function BriefCard({
  items,
  state,
  queueCount,
}: {
  items: BriefItem[] | null;
  state: BlockState;
  queueCount: number | null;
}) {
  const { t } = useI18n();
  const { navigate } = useRouter();
  if (state.failed) return <BlockProblem state={state} />;
  return (
    <section className="brief" aria-labelledby="brief-h" aria-busy={items === null || undefined}>
      <h2 id="brief-h" className="brief__title">
        <Icon name="sparkSmall" size={14} />
        {t("today.brief.title")}
      </h2>
      {items === null ? (
        <div className="brief__loading">
          <span className="skeleton brief__skeleton" style={{ width: "28%" }} />
          <span className="skeleton brief__skeleton" style={{ width: "78%" }} />
          <span className="skeleton brief__skeleton" style={{ width: "52%" }} />
        </div>
      ) : items.length === 0 ? (
        <div className="brief__empty">
          <span className="brief__empty-title">{t("today.brief.emptyTitle")}</span>
          <span className="brief__empty-body">{t("today.brief.emptyBody")}</span>
          {queueCount ? (
            <a
              className="brief__empty-cta"
              href="/mail?lane=QUEUE"
              onClick={(e) => {
                e.preventDefault();
                navigate({ name: "mail", lane: "QUEUE" });
              }}
            >
              {t("today.brief.emptyCta", { count: queueCount })}
            </a>
          ) : null}
        </div>
      ) : (
        items.map((item) => <BriefRow key={item.id} item={item} />)
      )}
    </section>
  );
}

function BriefRow({ item }: { item: BriefItem }) {
  const to: Route = item.emailId
    ? { name: "mail", id: item.emailId }
    : { name: "mail", lane: item.lane };
  const link = useLinkProps(to);
  return (
    <a className="brief__row" {...link}>
      <span className="brief__row-text">
        <span className={`lane-chip lane-chip--brief lane-chip--${item.lane.toLowerCase()}`}>
          {item.lane}
        </span>
        <span className="brief__row-title">{item.title}</span>
        {item.why ? <span className="brief__row-why">{item.why}</span> : null}
      </span>
      <Icon name="chevronRight" size={16} strokeWidth={2} className="brief__chevron" />
    </a>
  );
}

// ── Lanes ───────────────────────────────────────────────────────────────────

function LaneStrip({
  counts,
  state,
}: {
  counts: Record<LiveTier, { total: number }> | null;
  state: BlockState;
}) {
  const { t, tn } = useI18n();
  const { navigate } = useRouter();
  if (state.failed) return <BlockProblem state={state} />;
  return (
    <nav
      className="lanes card"
      aria-label={t("today.lanes.label")}
      aria-busy={counts === null || undefined}
    >
      {LIVE_LANES.map((lane) => {
        const count = counts?.[lane].total;
        return (
          <a
            key={lane}
            className="lanes__cell"
            href={`/mail?lane=${lane}`}
            aria-label={count === undefined ? lane : tn("today.lanes.count", count, { lane })}
            onClick={(e) => {
              e.preventDefault();
              navigate({ name: "mail", lane });
            }}
          >
            <span className="lanes__count">
              {count === undefined ? <span className="skeleton lanes__skeleton" /> : count}
            </span>
            <span className={`lanes__name lane-ink--${lane.toLowerCase()}`}>
              <span className="lanes__dot" aria-hidden="true" />
              {lane}
            </span>
          </a>
        );
      })}
    </nav>
  );
}

// ── Next event ──────────────────────────────────────────────────────────────

function NextEventCard({
  event,
  now,
  zone,
  state,
}: {
  event: CalendarEventWire | null | undefined;
  now: Date;
  zone: string;
  state: BlockState;
}) {
  const { t, intlTag } = useI18n();
  const { navigate } = useRouter();
  if (state.failed) return <BlockProblem state={state} />;
  if (event === undefined) {
    return <div className="skeleton skeleton--block next-event--skeleton" aria-busy="true" />;
  }
  if (event === null) {
    return (
      <section className="next-event card" aria-label={t("today.next.label")}>
        <span className="next-event__tile next-event__tile--empty" aria-hidden="true">
          <Icon name="calendar" size={22} />
        </span>
        <span className="next-event__empty">{t("today.next.empty")}</span>
      </section>
    );
  }
  const start = new Date(event.startTime);
  const ongoing = isOngoing(event, now);
  const service = meetingService(event.meetingLink);
  const sub = [event.sourceLabel ?? t("calendar.primary"), service ?? event.location]
    .filter(Boolean)
    .join(" · ");
  const join = Boolean(event.meetingLink && service);
  return (
    <section className="next-event card" aria-label={t("today.next.label")}>
      <span className="next-event__tile">
        <span className="next-event__time">{formatClock(start, intlTag, zone)}</span>
        <span className="next-event__rel">
          {ongoing ? t("today.next.now") : formatRelativeFromNow(start, now, intlTag)}
        </span>
      </span>
      <span className="next-event__text">
        <span className="next-event__title">{event.title}</span>
        {sub ? <span className="next-event__sub">{sub}</span> : null}
      </span>
      {join ? (
        <button
          type="button"
          className="button button--primary next-event__action"
          onClick={() => void openExternal(event.meetingLink ?? "")}
        >
          {t("today.next.join")}
        </button>
      ) : (
        <button
          type="button"
          className="button button--quiet next-event__action"
          onClick={() => navigate({ name: "calendar", id: event.id })}
        >
          {t("today.next.open")}
        </button>
      )}
    </section>
  );
}

// ── Approvals ───────────────────────────────────────────────────────────────

function ApprovalsSection({
  actions,
  state,
  limit,
}: {
  actions: PendingActionWire[] | undefined;
  state: BlockState;
  limit: number;
}) {
  const { t } = useI18n();
  const seeAll = useLinkProps({ name: "assistant", section: "approvals" });
  const count = actions?.length;
  return (
    <section className="approvals" aria-labelledby="appr-h">
      <div className="approvals__head">
        <h2 id="appr-h" className="approvals__title">
          {t("today.approvals.title")}{" "}
          {count ? <span className="approvals__count">{count}</span> : null}
        </h2>
        <a className="approvals__all" {...seeAll}>
          {t("today.approvals.seeAll")}
        </a>
      </div>
      {state.failed ? (
        <BlockProblem state={state} />
      ) : actions === undefined ? (
        <SkeletonRows rows={2} />
      ) : actions.length === 0 ? (
        <EmptyState title={t("today.approvals.empty")} className="approvals__empty" />
      ) : (
        <ul className="approvals__list card">
          {actions.slice(0, limit).map((action) => (
            <ApprovalRow key={action.id} action={action} />
          ))}
        </ul>
      )}
    </section>
  );
}

function ApprovalRow({ action }: { action: PendingActionWire }) {
  const { t } = useI18n();
  const link = useLinkProps({ name: "assistant", section: "approvals", id: action.id });
  const kind = approvalKind(action.toolName);
  const title =
    kind === "email"
      ? action.targetLabel
        ? t("approval.kind.emailTo", { name: action.targetLabel })
        : t("approval.kind.email")
      : (action.targetLabel ??
        t(kind === "calendar" ? "approval.kind.calendar" : "approval.kind.other"));
  const sub = approvalSubtitle(action);
  return (
    <li className="approval">
      <span className={`approval__icon approval__icon--${kind}`} aria-hidden="true">
        <Icon
          name={kind === "email" ? "pen" : kind === "calendar" ? "calendar" : "check"}
          size={18}
        />
      </span>
      <span className="approval__text">
        <span className="approval__title">{title}</span>
        {sub ? <span className="approval__sub">{sub}</span> : null}
      </span>
      <a
        className="approval__review"
        href={link.href}
        onClick={link.onClick}
        aria-label={t("today.approvals.reviewItem", { title })}
      >
        {t("today.approvals.review")}
      </a>
    </li>
  );
}

// ── Screen ──────────────────────────────────────────────────────────────────

function Column({
  children,
  className,
  pullToRefresh,
}: {
  children: ReactNode;
  className?: string;
  pullToRefresh?: () => Promise<unknown>;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const { t } = useI18n();
  const { pull, refreshing } = usePullToRefresh(ref, pullToRefresh ?? (async () => {}));
  const showIndicator = Boolean(pullToRefresh) && (pull > 0 || refreshing);
  return (
    <div ref={ref} className={`screen today__col ${className ?? ""}`}>
      {showIndicator ? (
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
              ? t("state.refreshing")
              : pull >= PULL_THRESHOLD
                ? t("state.release")
                : t("state.pull")}
          </span>
        </div>
      ) : null}
      <div className="today__stack">{children}</div>
    </div>
  );
}

export function TodayScreen() {
  const { t, tn } = useI18n();
  const plan = useLayout();
  const online = useOnline();
  const queryClient = useQueryClient();
  const now = useNow();

  const me = useMe();
  const userZone = me.data?.timezone;
  const zone = isKnownZone(userZone) ? userZone : deviceZone();
  // Recomputed each render; the ISO bounds (the query key) only change at midnight.
  const range = dayRangeInZone(now, zone);

  const firewall = useFirewall();
  const counts = useLaneCounts();
  const events = useEvents(range.start, range.end);
  const approvals = usePendingApprovals();

  const fwState = blockState(firewall);
  const countState = blockState(counts);
  const eventState = blockState(events);
  const approvalState = blockState(approvals);

  const brief = firewall.data ? briefItems(firewall.data) : null;
  const replies = firewall.data ? repliesOwed(firewall.data) : null;
  const meetings = events.data ? remainingEvents(events.data, now).length : null;
  const next = events.data ? nextEvent(events.data, now) : undefined;

  let summary: string | null = null;
  if (replies !== null && meetings !== null) {
    const r = tn("today.replies", replies);
    const m = tn("today.meetings", meetings);
    summary =
      replies && meetings
        ? t("today.summary.both", { replies: r, meetings: m })
        : replies
          ? t("today.summary.repliesOnly", { replies: r })
          : meetings
            ? t("today.summary.meetingsOnly", { meetings: m })
            : t("today.summary.none");
  } else if ((fwState.failed || replies !== null) && (eventState.failed || meetings !== null)) {
    summary = ""; // a block failed; its own card says so
  }

  const allFailedOffline = [fwState, countState, eventState, approvalState].every((s) => s.offline);
  const anyOfflineError = [firewall, counts, events, approvals].some(
    (q) => q.isError && isApiError(q.error) && q.error.isOffline,
  );
  const showBanner = !allFailedOffline && (!online || anyOfflineError);

  const refresh = () => queryClient.refetchQueries({ type: "active" });

  const header = <TodayHeader now={now} zone={zone} summary={summary} />;
  const banner = showBanner ? <OfflineBanner /> : null;

  if (allFailedOffline) {
    return (
      <Column className="today--single" pullToRefresh={refresh}>
        {header}
        <ProblemState kind="offline" onRetry={() => void refresh()} />
      </Column>
    );
  }

  const needsConnection =
    counts.data?.needsConnection === true || me.data?.hasAnyMailSource === false;
  const noAccounts = needsConnection ? (
    <EmptyState
      tone="neutral"
      icon="mail"
      title={t("state.noAccounts.title")}
      body={t("state.noAccounts.body")}
    />
  ) : null;
  const briefCard = noAccounts ?? (
    <BriefCard items={brief} state={fwState} queueCount={counts.data?.counts.QUEUE.total ?? null} />
  );
  const lanes = <LaneStrip counts={counts.data?.counts ?? null} state={countState} />;
  const nextCard = <NextEventCard event={next} now={now} zone={zone} state={eventState} />;

  const navWidth = plan.nav === "sidebar" ? SIDEBAR_WIDTH : plan.nav === "rail" ? RAIL_WIDTH : 0;
  const contentWidth = plan.width - navWidth;

  if (plan.posture === "tabletop") {
    return (
      <div className="today today--tabletop">
        <Column pullToRefresh={refresh}>
          {header}
          {banner}
          {briefCard}
        </Column>
        <div className="today__hinge" aria-hidden="true" />
        <Column>
          {lanes}
          {nextCard}
          <ApprovalsSection actions={approvals.data} state={approvalState} limit={4} />
        </Column>
      </div>
    );
  }

  if (plan.posture === "book") {
    // One scroll column per segment; nothing straddles the hinge.
    return (
      <div className="today today--book">
        <Column pullToRefresh={refresh}>
          {header}
          {banner}
          {briefCard}
          {lanes}
          {nextCard}
        </Column>
        <div className="today__hinge" aria-hidden="true" />
        <Column className="today__col--secondary">
          <ApprovalsSection actions={approvals.data} state={approvalState} limit={6} />
        </Column>
      </div>
    );
  }

  if (contentWidth >= 720) {
    // Wide flat window: the header spans both columns, one scroll.
    return (
      <Column className="today--grid" pullToRefresh={refresh}>
        <div className="today__span">{header}</div>
        {banner ? <div className="today__span">{banner}</div> : null}
        <div className="today__main">
          {briefCard}
          {lanes}
          {nextCard}
        </div>
        <div className="today__side">
          <ApprovalsSection actions={approvals.data} state={approvalState} limit={6} />
        </div>
      </Column>
    );
  }

  return (
    <Column className="today--single" pullToRefresh={refresh}>
      {header}
      {banner}
      {briefCard}
      {lanes}
      {nextCard}
      <ApprovalsSection
        actions={approvals.data}
        state={approvalState}
        limit={plan.sizeClass === "compact" ? 2 : 4}
      />
    </Column>
  );
}
