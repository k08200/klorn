/**
 * The three navigation chromes, one per size class:
 *   TabBar  (compact)  — 49pt bar + home-indicator inset, translucent blur
 *   NavRail (medium, and expanded below 1024) — 76px rail, FoldOpen artboard
 *   Sidebar (expanded ≥1024) — 248px, lanes + accounts, TabletLandscape artboard
 */
import type { LiveTier } from "@klorn/contract";
import { lazy, type MouseEvent, Suspense, useEffect, useState } from "react";
import { useInboxes, useLaneCounts, usePendingApprovals } from "../api/queries";
import { useI18n } from "../i18n/I18nProvider";
import { useRouter } from "../router/Router";
import { formatRoute, LIVE_LANES, type Tab, tabOf } from "../router/routes";
import { Icon } from "../ui/Icon";
import { SourceBadge } from "../ui/SourceBadge";
import { NAV_ITEMS } from "./nav-items";

function useTabLink() {
  const { route, selectTab } = useRouter();
  const current = tabOf(route);
  return (tab: Tab) => ({
    href: formatRoute({ name: tab }),
    "aria-current": current === tab ? ("page" as const) : undefined,
    onClick: (e: MouseEvent<HTMLAnchorElement>) => {
      e.preventDefault();
      selectTab(tab);
    },
    active: current === tab,
  });
}

export function TabBar() {
  const { t } = useI18n();
  const link = useTabLink();
  return (
    <nav className="tabbar" aria-label={t("nav.primary")}>
      {NAV_ITEMS.map((item) => {
        const { active, ...props } = link(item.tab);
        return (
          <a key={item.tab} className="tabbar__item" data-active={active || undefined} {...props}>
            <Icon name={item.icon} fill={active ? "var(--accent-tab-fill)" : "none"} />
            <span>{t(item.label)}</span>
          </a>
        );
      })}
    </nav>
  );
}

function Brand({ withName }: { withName: boolean }) {
  const { t } = useI18n();
  return (
    <span className="brand">
      <span className="brand__mark" aria-hidden="true">
        K
      </span>
      {withName ? (
        <span className="brand__name">{t("app.name")}</span>
      ) : (
        <span className="sr-only">{t("app.name")}</span>
      )}
    </span>
  );
}

export function NavRail() {
  const { t } = useI18n();
  const link = useTabLink();
  return (
    <nav className="rail" aria-label={t("nav.primary")}>
      <Brand withName={false} />
      {NAV_ITEMS.map((item) => {
        const { active, ...props } = link(item.tab);
        return (
          <a key={item.tab} className="rail__item" data-active={active || undefined} {...props}>
            <span className="rail__pill">
              <Icon name={item.icon} size={20} strokeWidth={1.9} />
            </span>
            <span>{t(item.label)}</span>
          </a>
        );
      })}
    </nav>
  );
}

const LANE_DOT: Record<LiveTier, string> = {
  PUSH: "var(--lane-push-dot)",
  MEETING: "var(--lane-meeting-dot)",
  QUEUE: "var(--lane-queue-dot)",
  INFO: "var(--lane-info-dot)",
  SILENT: "var(--lane-silent-dot)",
};

export function Sidebar() {
  const { t, tn } = useI18n();
  const link = useTabLink();
  const { navigate } = useRouter();
  const counts = useLaneCounts().data?.counts;
  const approvals = usePendingApprovals().data?.length ?? 0;
  const inboxes = useInboxes().data?.inboxes ?? [];
  const mailTotal = counts
    ? LIVE_LANES.reduce((n, l) => n + (l === "SILENT" ? 0 : counts[l].total), 0)
    : null;

  const badge = (tab: Tab): string => {
    if (tab === "mail" && mailTotal !== null) return String(mailTotal);
    if (tab === "assistant" && approvals > 0) return t("nav.approvalsBadge", { count: approvals });
    return "";
  };

  return (
    <aside className="sidebar">
      <Brand withName />
      <nav className="sidebar__nav" aria-label={t("nav.primary")}>
        {NAV_ITEMS.map((item) => {
          const { active, ...props } = link(item.tab);
          return (
            <a
              key={item.tab}
              className="sidebar__item"
              data-active={active || undefined}
              {...props}
            >
              <Icon name={item.icon} size={20} strokeWidth={1.9} />
              {t(item.label)}
              <span className="sidebar__badge">{badge(item.tab)}</span>
            </a>
          );
        })}
      </nav>
      <section className="sidebar__section" aria-labelledby="sidebar-lanes">
        <h2 id="sidebar-lanes" className="sidebar__heading">
          {t("nav.lanes")}
        </h2>
        {LIVE_LANES.map((lane) => {
          const count = counts?.[lane].total;
          return (
            <a
              key={lane}
              className="sidebar__lane"
              href={formatRoute({ name: "mail", lane })}
              aria-label={count === undefined ? lane : tn("today.lanes.count", count, { lane })}
              onClick={(e) => {
                e.preventDefault();
                navigate({ name: "mail", lane });
              }}
            >
              <span
                className="sidebar__dot"
                style={{ background: LANE_DOT[lane] }}
                aria-hidden="true"
              />
              {lane}
              <span className="sidebar__badge">{count ?? ""}</span>
            </a>
          );
        })}
      </section>
      {inboxes.length > 0 ? (
        <section className="sidebar__section" aria-labelledby="sidebar-accounts">
          <h2 id="sidebar-accounts" className="sidebar__heading">
            {t("nav.accounts")}
          </h2>
          {inboxes.map((inbox) => (
            <span key={inbox.id ?? "primary"} className="sidebar__account">
              <SourceBadge inbox={inbox} />
              <span className="sidebar__account-name">{inbox.email ?? inbox.provider}</span>
            </span>
          ))}
        </section>
      ) : null}
    </aside>
  );
}

// The Assistant is its own chunk (app/App.tsx); the sheet loads it on first open.
const AssistantSheet = lazy(() =>
  import("../screens/assistant/AssistantSheet").then((m) => ({ default: m.AssistantSheet })),
);

/** Expanded only: opens the assistant thread in a side sheet beside the content. */
export function AssistantFab() {
  const { t } = useI18n();
  const { route } = useRouter();
  const [open, setOpen] = useState(false);
  const [used, setUsed] = useState(false);
  // A link inside the thread (See plans) navigates: the sheet must not stay over the new screen.
  const here = formatRoute(route);
  // biome-ignore lint/correctness/useExhaustiveDependencies: close on every route change
  useEffect(() => setOpen(false), [here]);
  if (route.name === "assistant") return null;
  return (
    <>
      <button
        type="button"
        className="assistant-fab"
        aria-haspopup="dialog"
        aria-expanded={open}
        onClick={() => {
          setUsed(true);
          setOpen(true);
        }}
      >
        <Icon name="sparkSmall" size={18} strokeWidth={2} className="assistant-fab__icon" />
        {t("nav.assistantFab")}
      </button>
      {used ? (
        <Suspense fallback={null}>
          <AssistantSheet open={open} onClose={() => setOpen(false)} />
        </Suspense>
      ) : null}
    </>
  );
}
