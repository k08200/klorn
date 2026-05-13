"use client";

import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import { apiFetch } from "../lib/api";
import type { AttentionItem, InboxSummary, TodaySection } from "../lib/inbox-summary";

const EMPTY_SUMMARY: InboxSummary = {
  top3: [],
  today: { events: [], overdueTasks: [], todayTasks: [] },
};

function normalizeSummary(summary: Partial<InboxSummary> | null | undefined): InboxSummary {
  return {
    top3: Array.isArray(summary?.top3) ? summary.top3 : [],
    today: {
      events: Array.isArray(summary?.today?.events) ? summary.today.events : [],
      overdueTasks: Array.isArray(summary?.today?.overdueTasks) ? summary.today.overdueTasks : [],
      todayTasks: Array.isArray(summary?.today?.todayTasks) ? summary.today.todayTasks : [],
    },
  };
}

export default function CommandCenterSummary() {
  const [data, setData] = useState<InboxSummary>(EMPTY_SUMMARY);
  const [loading, setLoading] = useState(true);

  const refresh = useCallback(async () => {
    try {
      const summary = await apiFetch<InboxSummary>("/api/inbox/summary").catch(() => EMPTY_SUMMARY);
      setData(normalizeSummary(summary));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    refresh();
  }, [refresh]);

  useEffect(() => {
    const handler = () => refresh();
    window.addEventListener("conversations-updated", handler);
    return () => window.removeEventListener("conversations-updated", handler);
  }, [refresh]);

  const todayHasContent =
    data.today.events.length + data.today.overdueTasks.length + data.today.todayTasks.length > 0;

  if (loading && data.top3.length === 0 && !todayHasContent) {
    return null;
  }

  if (data.top3.length === 0 && !todayHasContent) {
    return null;
  }

  return (
    <section className="mb-6 space-y-4" aria-label="결정 센터 요약">
      {data.top3.length > 0 && <Top3Section items={data.top3} />}
      {todayHasContent && <TodaySectionView section={data.today} />}
    </section>
  );
}

function Top3Section({ items }: { items: AttentionItem[] }) {
  return (
    <div className="rounded-xl border border-stone-800 bg-stone-900/40 p-4">
      <div className="flex items-center justify-between mb-3">
        <h2 className="text-sm font-semibold text-stone-100">지금 봐야 할 일</h2>
        <span className="text-[11px] text-stone-500">상위 {items.length}개</span>
      </div>
      <ol className="space-y-2">
        {items.map((item, idx) => (
          <li key={`${item.kind}_${item.id}`}>
            <AttentionRow item={item} index={idx + 1} />
          </li>
        ))}
      </ol>
    </div>
  );
}

function AttentionRow({ item, index }: { item: AttentionItem; index: number }) {
  const badge = badgeFor(item);
  const body = bodyFor(item);
  const href = hrefFor(item);
  const content = (
    <div className="flex items-start gap-3 px-3 py-2.5 rounded-lg border border-stone-800/60 bg-stone-900/40 hover:bg-stone-800/40 transition">
      <span className="text-[11px] font-semibold text-stone-500 mt-0.5 shrink-0 w-4 text-center">
        {index}
      </span>
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2 flex-wrap">
          <span
            className={`text-[10px] font-medium border rounded px-1.5 py-0.5 ${badge.className}`}
          >
            {badge.label}
          </span>
          <span className="text-sm text-stone-100 truncate">{body.title}</span>
        </div>
        {body.subtitle && (
          <p className="mt-1 text-[11px] text-stone-400 line-clamp-1">{body.subtitle}</p>
        )}
        <DecisionTrace item={item} />
      </div>
    </div>
  );
  return href ? (
    <Link href={href} className="block">
      {content}
    </Link>
  ) : (
    content
  );
}

function DecisionTrace({ item }: { item: AttentionItem }) {
  const decision = item.decision;
  const facts = decision.evidence.slice(0, 2);
  if (!decision.costOfIgnoring && facts.length === 0) return null;

  return (
    <div className="mt-2 grid gap-1.5 rounded-md border border-stone-800/70 bg-black/20 p-2">
      {decision.costOfIgnoring && (
        <p className="line-clamp-2 text-[11px] leading-4 text-stone-400">
          놓치면: {displayText(decision.costOfIgnoring)}
        </p>
      )}
      <div className="flex flex-wrap items-center gap-1.5">
        <span className="rounded border border-stone-800 px-1.5 py-0.5 text-[10px] text-stone-500">
          신뢰도 {Math.round(decision.confidence * 100)}%
        </span>
        {decision.suggestedAction && (
          <span className="rounded border border-amber-300/20 bg-amber-300/10 px-1.5 py-0.5 text-[10px] text-amber-200">
            {displayText(decision.suggestedAction)}
          </span>
        )}
        {facts.map((fact) => (
          <span
            key={`${fact.label}:${fact.value}`}
            className="max-w-full truncate rounded border border-stone-800 px-1.5 py-0.5 text-[10px] text-stone-500"
          >
            {displayText(fact.label)}: {displayText(fact.value)}
          </span>
        ))}
      </div>
    </div>
  );
}

function badgeFor(item: AttentionItem): { label: string; className: string } {
  switch (item.kind) {
    case "pending_action":
      return {
        label: "승인 필요",
        className: "text-amber-300 bg-amber-400/10 border-amber-400/20",
      };
    case "overdue_task":
      return { label: "지난 항목", className: "text-red-300 bg-red-500/10 border-red-500/20" };
    case "today_event":
      return {
        label: "곧 시작",
        className: "text-amber-200 bg-amber-300/10 border-amber-300/20",
      };
    case "agent_proposal":
      return {
        label: "결정 제안",
        className: "text-amber-200 bg-amber-300/10 border-amber-300/20",
      };
    case "commitment":
      if (item.attentionType === "COMMITMENT_OVERDUE") {
        return {
          label: "지난 약속",
          className: "text-red-300 bg-red-500/10 border-red-500/20",
        };
      }
      if (item.attentionType === "COMMITMENT_UNCONFIRMED") {
        return {
          label: "확인 필요",
          className: "text-violet-300 bg-violet-400/10 border-violet-400/20",
        };
      }
      return {
        label: "약속 예정",
        className: "text-emerald-300 bg-emerald-400/10 border-emerald-400/20",
      };
  }
}

function bodyFor(item: AttentionItem): { title: string; subtitle: string | null } {
  switch (item.kind) {
    case "pending_action":
      return {
        title: displayText(item.label),
        subtitle: item.reasoning ? displayText(item.reasoning) : null,
      };
    case "overdue_task":
      return {
        title: displayText(item.title),
        subtitle: `${item.daysOverdue}일 지남`,
      };
    case "today_event":
      return {
        title: displayText(item.title),
        subtitle: formatEventSubtitle(item.startTime, item.minutesAway, item.location),
      };
    case "agent_proposal":
      return { title: stripEvePrefix(item.title), subtitle: displayText(item.message) };
    case "commitment":
      return {
        title: displayText(item.title),
        subtitle:
          [
            ownerLabel(item.owner),
            dueLabel(item),
            item.description ? displayText(item.description) : null,
          ]
            .filter(Boolean)
            .join(" · ") || null,
      };
  }
}

function hrefFor(item: AttentionItem): string | null {
  switch (item.kind) {
    case "pending_action":
      return `/chat/${item.conversationId}`;
    case "overdue_task":
      return null;
    case "today_event":
      return "/calendar";
    case "agent_proposal":
      return item.link ?? null;
    case "commitment":
      return null;
  }
}

function ownerLabel(owner: string): string | null {
  switch (owner) {
    case "USER":
      return "내 약속";
    case "COUNTERPARTY":
      return "상대방 약속";
    case "TEAM":
      return "팀 약속";
    case "UNKNOWN":
      return "담당자 미확인";
    default:
      return null;
  }
}

function dueLabel(item: Extract<AttentionItem, { kind: "commitment" }>): string | null {
  if (item.dueText) return item.dueText;
  if (!item.dueAt) return null;
  return formatDate(item.dueAt);
}

function stripEvePrefix(title: string): string {
  const legacyPrefix = "[EV" + "E]";
  if (title.startsWith("[Eve]")) return title.slice(5).trim();
  if (title.startsWith(legacyPrefix)) return title.slice(5).trim();
  return displayText(title);
}

function displayText(value: string | null | undefined): string {
  const text = value ?? "";
  if (/^\d{4}-\d{2}-\d{2}T/.test(text)) {
    return new Date(text).toLocaleString("ko-KR", {
      month: "short",
      day: "numeric",
      hour: "2-digit",
      minute: "2-digit",
    });
  }
  return text
    .replace(
      /The due date is unclear, so it is easy to miss unless it is confirmed now\./g,
      "기한이 불명확해서 지금 확인하지 않으면 놓치기 쉽습니다.",
    )
    .replace(
      /The commitment is overdue and may affect trust or downstream timing\./g,
      "약속 기한이 지나 신뢰나 후속 일정에 영향을 줄 수 있습니다.",
    )
    .replace(
      /If the counterparty does not deliver on time, the next decision may stall\./g,
      "상대방이 제때 전달하지 않으면 다음 결정이 멈출 수 있습니다.",
    )
    .replace(
      /If this slips, the other side may be blocked on their next step\./g,
      "이 일이 밀리면 상대방의 다음 단계가 막힐 수 있습니다.",
    )
    .replace(
      /A late reply could create relationship or scheduling risk\./g,
      "답장이 늦어지면 관계나 일정 리스크가 생길 수 있습니다.",
    )
    .replace(
      /If the time is not confirmed, prep and follow-up work may slip\./g,
      "시간을 확정하지 않으면 준비와 후속 작업이 밀릴 수 있습니다.",
    )
    .replace(
      /Confirm the delete decision first because it may be hard to undo\./g,
      "되돌리기 어려울 수 있으니 삭제 결정부터 확인하세요.",
    )
    .replace(
      /If the decision stays pending, the related workstream may stall\./g,
      "결정이 보류되면 관련 업무 흐름이 멈출 수 있습니다.",
    )
    .replace(
      /The due date has passed, so related follow-ups may slip\./g,
      "기한이 지나 관련 후속 조치가 밀릴 수 있습니다.",
    )
    .replace(
      /If it is not handled today, high-priority work rolls into tomorrow\./g,
      "오늘 처리하지 않으면 높은 우선순위 일이 내일로 넘어갑니다.",
    )
    .replace(
      /It is due today, so missing it can back up the work queue\./g,
      "오늘까지라 놓치면 작업 대기열이 밀릴 수 있습니다.",
    )
    .replace(
      /If meeting context is missed, replies, materials, and commitments may be delayed\./g,
      "회의 맥락을 놓치면 답장, 자료, 약속이 늦어질 수 있습니다.",
    )
    .replace(
      /If it is not reviewed, the prepared follow-up stays waiting\./g,
      "검토하지 않으면 준비된 후속 조치가 계속 대기합니다.",
    )
    .replace(/Review and approve the draft reply/g, "답장 초안 검토 및 승인")
    .replace(/Review investor-facing risks/g, "투자자 대응 리스크 검토")
    .replace(/Prepare update pack/g, "업데이트 자료 준비")
    .replace(/review task/g, "검토 작업")
    .replace(/Decision Card/g, "결정 카드")
    .replace(/Work Graph/g, "업무 그래프")
    .replace(/Priority/g, "우선순위")
    .replace(/Due date/g, "기한")
    .replace(/\bURGENT\b/g, "긴급")
    .replace(/\bHIGH\b/g, "높음")
    .replace(/\bMEDIUM\b/g, "보통")
    .replace(/\bLOW\b/g, "낮음")
    .replace(/Evidence/g, "근거")
    .replace(/Awaiting approval/g, "승인 대기")
    .replace(/Unread mail/g, "읽지 않은 메일")
    .replace(/Urgent mail/g, "긴급 메일")
    .replace(/Overdue commitment/g, "지난 약속")
    .replace(/Open commitment/g, "열린 약속")
    .replace(/Counterparty/g, "상대방")
    .replace(/Your commitment/g, "내 약속")
    .replace(/\bEVE\b/g, "Jigeum")
    .replace(/\bEve\b/g, "Jigeum");
}

function formatEventSubtitle(
  startTime: string,
  minutesAway: number,
  location: string | null,
): string {
  const time = new Date(startTime).toLocaleTimeString("en-US", {
    hour: "2-digit",
    minute: "2-digit",
  });
  const inMin =
    minutesAway <= 0
      ? "진행 중"
      : minutesAway < 60
        ? `${minutesAway}분 후`
        : `${Math.round(minutesAway / 60)}시간 후`;
  return location ? `${time} · ${inMin} · ${location}` : `${time} · ${inMin}`;
}

function TodaySectionView({ section }: { section: TodaySection }) {
  return (
    <div className="rounded-xl border border-stone-800 bg-stone-900/40 p-4">
      <h2 className="text-sm font-semibold text-stone-100 mb-3">오늘 한눈에 보기</h2>
      <div className="space-y-3">
        {section.events.length > 0 && (
          <SubList
            label="오늘"
            items={section.events.map((e) => ({
              key: e.id,
              primary: e.title,
              secondary: formatTime(e.startTime),
            }))}
          />
        )}
        {section.overdueTasks.length > 0 && (
          <SubList
            label="지난 항목"
            tone="warn"
            items={section.overdueTasks.map((t) => ({
              key: t.id,
              primary: t.title,
              secondary: t.dueDate ? formatDate(t.dueDate) : null,
            }))}
          />
        )}
        {section.todayTasks.length > 0 && (
          <SubList
            label="오늘 마감"
            items={section.todayTasks.map((t) => ({
              key: t.id,
              primary: t.title,
              secondary: priorityLabel(t.priority),
            }))}
          />
        )}
      </div>
    </div>
  );
}

interface SubListItem {
  key: string;
  primary: string;
  secondary: string | null;
}

function SubList({ label, items, tone }: { label: string; items: SubListItem[]; tone?: "warn" }) {
  const labelClass = tone === "warn" ? "text-red-300" : "text-stone-400";
  return (
    <div>
      <p className={`text-[11px] font-medium mb-1.5 ${labelClass}`}>
        {label} · {items.length}
      </p>
      <ul className="space-y-1">
        {items.slice(0, 3).map((it) => (
          <li
            key={it.key}
            className="flex items-center gap-2 text-sm text-stone-200 px-2 py-1 rounded border border-transparent hover:border-stone-800/80"
          >
            <span className="truncate flex-1">{it.primary}</span>
            {it.secondary && (
              <span className="text-[11px] text-stone-500 shrink-0">{it.secondary}</span>
            )}
          </li>
        ))}
        {items.length > 3 && (
          <li className="text-[11px] text-stone-600 px-2">+{items.length - 3}개 더</li>
        )}
      </ul>
    </div>
  );
}

function formatTime(iso: string): string {
  return new Date(iso).toLocaleTimeString("ko-KR", { hour: "2-digit", minute: "2-digit" });
}

function formatDate(iso: string): string {
  return new Date(iso).toLocaleDateString("ko-KR", { month: "short", day: "numeric" });
}

function priorityLabel(p: string): string | null {
  const up = p.toUpperCase();
  if (up === "URGENT") return "긴급";
  if (up === "HIGH") return "높음";
  if (up === "MEDIUM") return "보통";
  if (up === "LOW") return "낮음";
  return null;
}
