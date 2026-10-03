"use client";

/**
 * Mail v2 header (productization plan §1, P5): the lane control is the primary
 * filter; the account facet, the legacy filters and "Show silenced" are
 * secondary menus. Presentation only — the view state lives in mail-v2.tsx.
 */

import type { EmailLaneCounts, LiveTier } from "@klorn/contract";
import type { FormEvent, KeyboardEvent, RefObject } from "react";
import Button from "../../../components/ui/button";
import { Menu, type MenuSection } from "../../../components/ui/menu";
import { type Segment, SegmentedControl } from "../../../components/ui/segmented-control";
import { SourceBadge } from "../../../components/ui/source-badge";
import { useT } from "../../../lib/i18n";
import { sourceGlyph } from "../../../lib/source-provider";
import { ComposeIcon, MoreIcon, SearchIcon, SyncIcon } from "./icons";
import {
  type AccountOption,
  ALL_ACCOUNTS,
  DEFAULT_LANE,
  type LaneView,
  type ListView,
  laneSegments,
  SECONDARY_FILTERS,
  type SecondaryFilter,
} from "./model";

const LANE_DOT: Record<LiveTier, string> = {
  PUSH: "bg-tier-push-ink",
  MEETING: "bg-tier-meeting-ink",
  QUEUE: "bg-tier-queue-ink",
  INFO: "bg-tier-info-ink",
  SILENT: "bg-tier-silent-ink",
};

const FILTER_LABEL_KEYS: Record<SecondaryFilter, string> = {
  none: "mailV2.filter.none",
  "reply-needed": "mail.filterReplyNeeded",
  unread: "mail.filterUnread",
  attachments: "mail.filterAttachments",
  threads: "mail.filterThreads",
};

interface MailHeaderProps {
  view: ListView;
  onChange: (patch: Partial<ListView>) => void;
  searchDraft: string;
  onSearchDraft: (value: string) => void;
  searchRef: RefObject<HTMLInputElement | null>;
  counts: EmailLaneCounts | null;
  accounts: readonly AccountOption[];
  isDemo: boolean;
  syncing: boolean;
  onCompose: () => void;
  onSync: () => void;
  onReanalyze: () => void;
}

export function MailHeader(props: MailHeaderProps) {
  const { view, onChange, counts, accounts, isDemo } = props;
  const { t } = useT();
  const threads = view.filter === "threads";

  const segments = laneSegments(view.lane).map((lane): Segment<LaneView> => {
    if (lane === "ALL") return { id: lane, label: t("mailV2.lane.all") };
    const unread = counts?.[lane].unread ?? 0;
    return {
      id: lane,
      label: lane,
      leading: <span aria-hidden="true" className={`size-2 rounded-full ${LANE_DOT[lane]}`} />,
      count: unread,
      ariaLabel: unread > 0 ? t("mailV2.lane.unread", { lane, count: String(unread) }) : undefined,
    };
  });

  const current = accounts.find((account) => account.scope === view.account) ?? null;
  const accountName = (account: AccountOption) =>
    account.email ?? sourceGlyph(account.provider).name;
  const accountSections: MenuSection[] = [
    {
      id: "accounts",
      items: [
        {
          id: ALL_ACCOUNTS,
          label: t("mailV2.accounts.all"),
          kind: "radio",
          checked: view.account === ALL_ACCOUNTS,
          onSelect: () => onChange({ account: ALL_ACCOUNTS }),
        },
        ...accounts.map((account) => ({
          id: account.scope,
          label: accountName(account),
          leading: <SourceBadge provider={account.provider} />,
          hint: account.needsReconnect ? t("mailV2.accounts.needsReconnect") : undefined,
          kind: "radio" as const,
          checked: view.account === account.scope,
          onSelect: () => onChange({ account: account.scope }),
        })),
      ],
    },
  ];

  const filterSections: MenuSection[] = [
    {
      id: "filter",
      items: SECONDARY_FILTERS.map((filter) => ({
        id: filter,
        label: t(FILTER_LABEL_KEYS[filter]),
        kind: "radio" as const,
        checked: view.filter === filter,
        onSelect: () => onChange({ filter }),
      })),
    },
  ];

  const silenced = view.lane === "SILENT";
  const moreSections: MenuSection[] = [
    {
      id: "lanes",
      items: [
        {
          id: "silenced",
          label: t("mailV2.more.showSilenced"),
          kind: "checkbox",
          checked: silenced,
          disabled: threads,
          onSelect: () => onChange({ lane: silenced ? DEFAULT_LANE : "SILENT" }),
        },
      ],
    },
    {
      id: "tools",
      items: [
        { id: "candidates", label: t("mail.filterCandidates"), href: "/email/candidates" },
        {
          id: "reanalyze",
          label: t("mailV2.more.reanalyze"),
          disabled: isDemo,
          onSelect: props.onReanalyze,
        },
      ],
    },
  ];

  const submitSearch = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    onChange({ search: props.searchDraft.trim() });
  };
  const onSearchKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key !== "Escape") return;
    // Escape leaves the field; a second Escape (now empty) is the list's own.
    event.preventDefault();
    props.onSearchDraft("");
    onChange({ search: "" });
    event.currentTarget.blur();
  };

  return (
    <header className="flex flex-col gap-2">
      <div className="flex flex-wrap items-center gap-x-2 gap-y-3">
        <h1 className="mr-auto text-display text-ink">{t("nav.mail")}</h1>
        {/* biome-ignore lint/a11y/useSemanticElements: <search> is not yet in the JSX types this repo targets; role="search" names the same landmark */}
        <form
          role="search"
          onSubmit={submitSearch}
          className="relative max-md:order-last max-md:basis-full md:w-72"
        >
          <SearchIcon className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-ink-muted" />
          <input
            ref={props.searchRef}
            type="search"
            value={props.searchDraft}
            onChange={(event) => {
              props.onSearchDraft(event.target.value);
              if (event.target.value === "") onChange({ search: "" });
            }}
            onKeyDown={onSearchKeyDown}
            placeholder={t("mail.searchMail")}
            aria-label={t("mail.searchMail")}
            className="focus-ring h-11 w-full rounded-control border border-line bg-surface-panel pl-9 pr-3 text-body text-ink placeholder:text-ink-muted"
          />
        </form>
        <Button
          variant="primary"
          size="sm"
          icon={<ComposeIcon />}
          onClick={props.onCompose}
          disabled={isDemo}
          className="max-md:hidden"
        >
          {t("mail.compose")}
        </Button>
        <Button
          variant="primary"
          size="icon"
          aria-label={t("mail.compose")}
          onClick={props.onCompose}
          disabled={isDemo}
          className="md:hidden"
        >
          <ComposeIcon />
        </Button>
        <Button
          variant="ghost"
          size="icon"
          aria-label={props.syncing ? t("common.syncing") : t("common.syncNow")}
          title={t("common.syncNow")}
          onClick={props.onSync}
          disabled={props.syncing || isDemo}
        >
          <SyncIcon spinning={props.syncing} />
        </Button>
        <Menu label={t("mailV2.more.label")} variant="icon" align="end" sections={moreSections}>
          <MoreIcon />
        </Menu>
      </div>

      <div className="flex items-center gap-2 max-md:flex-col max-md:items-stretch max-md:gap-0">
        <SegmentedControl
          ariaLabel={t("mailV2.lanes.label")}
          segments={segments}
          // Threads are not a lane view, so no segment claims to be the current one.
          value={threads ? null : view.lane}
          onChange={(lane) => onChange({ lane })}
          disabled={threads}
          className="flex-1 max-md:-mx-4 max-md:px-4"
        />
        <div className="flex items-center gap-2">
          {accounts.length > 1 && (
            <Menu
              label={t("mailV2.accounts.label")}
              sections={accountSections}
              active={view.account !== ALL_ACCOUNTS}
              disabled={threads}
              align="end-from-md"
            >
              <AccountChip account={current} fallback={t("mailV2.accounts.all")} />
            </Menu>
          )}
          <Menu
            label={t("mailV2.filter.label")}
            sections={filterSections}
            active={view.filter !== "none"}
            align="end-from-md"
          >
            {view.filter === "none" ? t("mailV2.filter.label") : t(FILTER_LABEL_KEYS[view.filter])}
          </Menu>
        </div>
      </div>
      {threads && <p className="text-caption text-ink-muted">{t("mailV2.threads.note")}</p>}
    </header>
  );
}

function AccountChip({ account, fallback }: { account: AccountOption | null; fallback: string }) {
  if (!account) return <>{fallback}</>;
  return (
    <>
      <SourceBadge provider={account.provider} />
      <span className="truncate">{account.email ?? sourceGlyph(account.provider).name}</span>
    </>
  );
}
