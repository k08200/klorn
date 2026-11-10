/**
 * Assistant (Assistant artboard): one large title and a segmented control —
 * 대화 (chat) / 승인 N (Approvals) / 활동 (Activity, the day's receipt). The
 * section lives in the route (/assistant/chat | approvals[/:id] | activity);
 * /assistant/briefing opens Activity, where the morning briefing sits on top.
 */

import { useQuery } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { qk, useMe, usePendingApprovals } from "../../api/queries";
import { useReceipt } from "../../api/queries-hub";
import { getServices } from "../../app/services";
import type { MessageKey } from "../../i18n";
import { formatClock } from "../../i18n/format";
import { useI18n } from "../../i18n/I18nProvider";
import { useLayout } from "../../layout/LayoutContext";
import { useRouter } from "../../router/Router";
import type { AssistantSection } from "../../router/routes";
import { Icon } from "../../ui/Icon";
import { EmptyState, OfflineBanner, ProblemState, SkeletonRows } from "../../ui/StateView";
import { useOnline } from "../../ui/useOnline";
import { isKnownZone } from "../today/model";
import { ApprovalsView } from "./Approvals";
import { ChatThread } from "./ChatThread";
import {
  type ActivityKind,
  activityEntries,
  activityReason,
  activityTitle,
  type DayPart,
  groupByDayPart,
} from "./model";
import "./assistant.css";

type Segment = "chat" | "approvals" | "activity";

function segmentOf(section: AssistantSection | undefined): Segment {
  if (section === "approvals") return "approvals";
  if (section === "activity" || section === "briefing") return "activity";
  return "chat";
}

function Header({
  segment,
  approvals,
  onNewChat,
}: {
  segment: Segment;
  approvals: number;
  onNewChat?: () => void;
}) {
  const { t } = useI18n();
  const { navigate } = useRouter();
  const segments: Array<{ id: Segment; label: string }> = [
    { id: "chat", label: t("assistant.segment.chat") },
    {
      id: "approvals",
      label: approvals
        ? t("assistant.segment.approvals", { count: approvals })
        : t("assistant.segment.approvalsShort"),
    },
    { id: "activity", label: t("assistant.segment.activity") },
  ];
  return (
    <header className="assistant-head">
      <div className="assistant-head__row">
        <h1 className="screen-title">{t("tab.assistant")}</h1>
        {onNewChat ? (
          <button type="button" className="assistant-head__new" onClick={onNewChat}>
            <Icon name="plus" size={16} strokeWidth={2} />
            {t("assistant.chat.new")}
          </button>
        ) : null}
      </div>
      <div className="segmented" role="tablist" aria-label={t("assistant.segment.label")}>
        {segments.map((s) => (
          <button
            key={s.id}
            type="button"
            role="tab"
            aria-selected={segment === s.id}
            className="segmented__item"
            onClick={() => navigate({ name: "assistant", section: s.id }, { replace: true })}
          >
            {s.label}
          </button>
        ))}
      </div>
    </header>
  );
}

const KIND_KEYS: Record<ActivityKind, MessageKey> = {
  handled: "assistant.activity.kind.handled",
  notified: "assistant.activity.kind.notified",
  queued: "assistant.activity.kind.queued",
  silenced: "assistant.activity.kind.silenced",
};

const PART_KEYS: Record<DayPart, MessageKey> = {
  night: "assistant.activity.part.night",
  morning: "assistant.activity.part.morning",
  afternoon: "assistant.activity.part.afternoon",
  evening: "assistant.activity.part.evening",
};

function useBriefing() {
  return useQuery({
    queryKey: qk.briefing,
    queryFn: ({ signal }) => getServices().ep.assistant.briefingStatus({ signal }),
    staleTime: 5 * 60_000,
  });
}

function Activity({ zone }: { zone: string }) {
  const { t, tn, intlTag } = useI18n();
  const receipt = useReceipt();
  const briefing = useBriefing();
  if (receipt.isError && !receipt.data) {
    return <ProblemState kind="error" onRetry={() => void receipt.refetch()} />;
  }
  if (!receipt.data) return <SkeletonRows rows={3} />;
  const entries = activityEntries(receipt.data);
  const groups = groupByDayPart(entries, zone);
  const summary = receipt.data.summary;
  const note = briefing.data?.generated ? briefing.data.note : null;
  const text = (v: { key: MessageKey } | { text: string }) => ("key" in v ? t(v.key) : v.text);
  return (
    <div className="activity">
      {note ? (
        <section className="activity-brief" aria-labelledby="brief-note-h">
          <h2 id="brief-note-h" className="activity-brief__title">
            <Icon name="sparkSmall" size={14} />
            {t("assistant.activity.briefing")}
          </h2>
          <p className="activity-brief__text selectable">{note.preview || note.content}</p>
        </section>
      ) : null}
      {summary.totalSeen > 0 ? (
        <section className="activity-summary card" aria-label={t("assistant.activity.summary")}>
          {summary.narrative ? <p className="activity-summary__text">{summary.narrative}</p> : null}
          <dl className="activity-summary__stats">
            <div>
              <dt>{t("assistant.activity.stat.seen")}</dt>
              <dd>{summary.totalSeen}</dd>
            </div>
            <div>
              <dt>{t("assistant.activity.stat.interrupted")}</dt>
              <dd>{summary.totalInterrupted}</dd>
            </div>
            <div>
              <dt>{t("assistant.activity.stat.quiet")}</dt>
              <dd>{summary.savedFromInbox}</dd>
            </div>
          </dl>
        </section>
      ) : null}
      {entries.length === 0 ? (
        <EmptyState tone="neutral" icon="clock" title={t("assistant.activity.empty")} />
      ) : (
        groups.map((group, gi) => (
          <section
            key={`${group.part}-${gi}`}
            className="activity-group"
            aria-label={t(PART_KEYS[group.part])}
          >
            <h2 className="activity-group__title">
              {t(PART_KEYS[group.part])}
              <span>{tn("assistant.activity.count", group.entries.length)}</span>
            </h2>
            <ul className="activity-group__list card">
              {group.entries.map((entry) => {
                const reason = activityReason(entry.item.tierReason);
                return (
                  <li key={entry.key} className="activity-row">
                    <span className={`activity-kind activity-kind--${entry.kind}`}>
                      {t(KIND_KEYS[entry.kind])}
                    </span>
                    <span className="activity-row__text">
                      <span className="activity-row__title">{text(activityTitle(entry.item))}</span>
                      {reason ? <span className="activity-row__why">{text(reason)}</span> : null}
                    </span>
                    <span className="activity-row__time">
                      {formatClock(new Date(entry.item.surfacedAt), intlTag, zone)}
                    </span>
                  </li>
                );
              })}
            </ul>
          </section>
        ))
      )}
      <p className="activity__foot">{t("assistant.activity.readOnly")}</p>
    </div>
  );
}

export function AssistantScreen({ section, id }: { section?: AssistantSection; id?: string }) {
  const online = useOnline();
  const plan = useLayout();
  const segment = segmentOf(section);
  const approvals = usePendingApprovals();
  const me = useMe();
  const tz = me.data?.timezone;
  const zone = isKnownZone(tz) ? tz : Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
  const count = approvals.data?.length ?? 0;
  const [chatKey, setChatKey] = useState(0);

  // Keep the URL canonical: /assistant is the chat.
  const { navigate } = useRouter();
  useEffect(() => {
    if (!section) navigate({ name: "assistant", section: "chat" }, { replace: true });
  }, [section, navigate]);

  const header = (
    <Header
      segment={segment}
      approvals={count}
      onNewChat={segment === "chat" ? () => setChatKey((k) => k + 1) : undefined}
    />
  );
  const banner = online ? null : <OfflineBanner />;

  if (segment === "approvals") {
    return (
      <ApprovalsView
        id={id}
        zone={zone}
        header={
          <>
            {header}
            {banner}
          </>
        }
      />
    );
  }
  const chat = <ChatThread key={chatKey} newChat={chatKey > 0} />;
  const activity = (
    <div className="assistant-scroll">
      <Activity zone={zone} />
    </div>
  );

  // A vertical hinge: the chosen view on the left segment, the other on the
  // right, so nothing is laid across the fold.
  if (plan.posture === "book") {
    return (
      <div className="assistant-book">
        <div className="assistant-pane">
          {header}
          {banner}
          {segment === "chat" ? chat : activity}
        </div>
        <div className="assistant-book__hinge" aria-hidden="true" />
        <div className="assistant-pane assistant-pane--secondary">
          {segment === "chat" ? activity : chat}
        </div>
      </div>
    );
  }

  return (
    <div className="assistant-pane assistant-pane--full">
      {header}
      {banner}
      {segment === "chat" ? chat : activity}
    </div>
  );
}
