"use client";

import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import AuthGuard from "../../components/auth-guard";
import { apiFetch } from "../../lib/api";
import { captureClientError } from "../../lib/sentry";

type Filter = "all" | "reply-needed" | "urgent" | "unread" | "automated";

interface EmailRow {
  id: string;
  gmailId: string;
  from: string;
  subject: string;
  snippet: string | null;
  date: string;
  isRead: boolean;
  priority: "URGENT" | "NORMAL" | "LOW";
  category: string | null;
  summary: string | null;
  needsReply?: boolean;
}

interface ListResponse {
  emails: EmailRow[];
  source: "gmail" | "demo";
  total: number;
  unread: number;
}

const FILTERS: { key: Filter; label: string; query: string }[] = [
  { key: "all", label: "전체 신호", query: "" },
  { key: "reply-needed", label: "답장 필요", query: "filter=reply-needed" },
  { key: "urgent", label: "긴급", query: "filter=urgent" },
  { key: "unread", label: "읽지 않음", query: "filter=unread" },
  { key: "automated", label: "자동화", query: "category=automated" },
];

export default function EmailPage() {
  return (
    <AuthGuard>
      <EmailView />
    </AuthGuard>
  );
}

function EmailView() {
  const [filter, setFilter] = useState<Filter>("all");
  const [emails, setEmails] = useState<EmailRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [syncing, setSyncing] = useState(false);
  const [source, setSource] = useState<"gmail" | "demo" | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async (f: Filter) => {
    setLoading(true);
    setError(null);
    try {
      const q = FILTERS.find((x) => x.key === f)?.query || "";
      const path = `/api/email${q ? `?${q}` : ""}`;
      const data = await apiFetch<ListResponse>(path);
      setEmails(data.emails);
      setSource(data.source);
    } catch (err) {
      captureClientError(err, { scope: "email.load", filter: f });
      setError("메일을 불러오지 못했어요.");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load(filter);
  }, [filter, load]);

  const syncNow = async () => {
    setSyncing(true);
    setError(null);
    try {
      await apiFetch("/api/email/sync", { method: "POST", body: JSON.stringify({}) });
      await load(filter);
    } catch (err) {
      captureClientError(err, { scope: "email.sync" });
      setError("Gmail 동기화에 실패했어요.");
    } finally {
      setSyncing(false);
    }
  };

  const unreadCount = emails.filter((email) => !email.isRead).length;
  const urgentCount = emails.filter((email) => email.priority === "URGENT").length;
  const replyCount = emails.filter((email) => email.needsReply).length;

  return (
    <div className="mx-auto w-full max-w-5xl px-4 pb-28 pt-6 md:py-10">
      <header className="mb-5 overflow-hidden rounded-2xl border border-stone-700/45 bg-stone-950/55 shadow-2xl shadow-black/10">
        <div className="h-1 bg-gradient-to-r from-sky-300 via-amber-300 to-stone-600" />
        <div className="p-5 md:p-6">
          <div className="flex items-start justify-between gap-4">
            <div>
              <p className="mb-2 text-[11px] font-semibold uppercase tracking-[0.18em] text-amber-300/80">
                시그널 메일
              </p>
              <h1 className="text-2xl font-semibold tracking-tight text-stone-50">
                메일 신호를 결정 단위로 정리
              </h1>
              <p className="mt-2 max-w-xl text-sm leading-6 text-stone-500">
                EVE가 긴급도, 답장 필요 여부, 자동화 신호를 먼저 드러내고 실행 전 맥락으로 묶습니다.
                {source === "demo" && <span className="ml-2 text-amber-300">데모 데이터</span>}
              </p>
            </div>
            <button
              type="button"
              onClick={syncNow}
              disabled={syncing}
              className="shrink-0 rounded-lg border border-stone-700/60 px-3 py-1.5 text-xs text-stone-300 transition hover:border-amber-500/40 hover:bg-amber-500/10 hover:text-amber-100 disabled:opacity-50"
            >
              {syncing ? "동기화 중..." : "지금 동기화"}
            </button>
          </div>
          <div className="mt-5 grid grid-cols-3 overflow-hidden rounded-xl border border-stone-800 bg-black/20">
            <SignalStat label="읽지 않음" value={unreadCount} />
            <SignalStat label="긴급" value={urgentCount} />
            <SignalStat label="답장" value={replyCount} />
          </div>
        </div>
      </header>

      <FilterTabs current={filter} onChange={setFilter} />

      {loading && <p className="px-1 py-3 text-sm text-stone-500">로딩 중...</p>}

      {error && (
        <div className="mt-3 rounded-lg border border-red-900/60 bg-red-950/30 px-4 py-3 text-sm text-red-300">
          {error}
        </div>
      )}

      {!loading && !error && emails.length === 0 && (
        <div className="mt-4 rounded-xl border border-stone-700/45 bg-stone-950/35 p-6 text-center">
          <p className="text-sm text-stone-300">
            {filter === "all" ? "아직 들어온 메일 신호가 없어요." : "조건에 맞는 신호가 없어요."}
          </p>
          <p className="mt-1 text-xs text-stone-600">
            동기화가 끝나면 실행이 필요한 메일만 먼저 떠오릅니다.
          </p>
        </div>
      )}

      {!loading && emails.length > 0 && (
        <ul className="mt-3 space-y-2.5">
          {emails.map((e) => (
            <EmailRowItem key={e.id} email={e} />
          ))}
        </ul>
      )}
    </div>
  );
}

function SignalStat({ label, value }: { label: string; value: number }) {
  return (
    <div className="border-r border-stone-800 px-4 py-3 last:border-r-0">
      <p className="text-[10px] font-semibold uppercase tracking-[0.14em] text-stone-600">
        {label}
      </p>
      <p className="mt-1 text-2xl font-semibold text-stone-100">{value}</p>
    </div>
  );
}

function FilterTabs({ current, onChange }: { current: Filter; onChange: (f: Filter) => void }) {
  return (
    <div className="-mx-4 flex gap-2 overflow-x-auto px-4 pb-2 scrollbar-hide">
      {FILTERS.map((f) => {
        const active = f.key === current;
        return (
          <button
            key={f.key}
            type="button"
            onClick={() => onChange(f.key)}
            className={`min-h-[32px] shrink-0 rounded-full px-3 py-1.5 text-xs transition ${
              active
                ? "bg-amber-300 text-stone-950"
                : "border border-stone-700/55 bg-stone-950/45 text-stone-400 hover:bg-stone-900/70 hover:text-stone-200"
            }`}
          >
            {f.label}
          </button>
        );
      })}
    </div>
  );
}

function EmailRowItem({ email }: { email: EmailRow }) {
  const unread = !email.isRead;
  return (
    <li>
      <Link
        href={`/email/${email.id}`}
        className="block overflow-hidden rounded-xl border border-stone-700/45 bg-stone-950/45 transition hover:border-amber-500/30 hover:bg-amber-500/5 active:bg-stone-900/70"
      >
        <div className="grid gap-3 p-4 md:grid-cols-[1fr_auto] md:items-start">
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-2">
              <PriorityBadge priority={email.priority} />
              {email.needsReply && <ReplyNeededBadge />}
              {email.category && <CategoryBadge category={email.category} />}
              {unread && <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-amber-300" />}
            </div>
            <p
              className={`mt-2 truncate text-sm ${unread ? "font-semibold text-stone-100" : "text-stone-300"}`}
            >
              {senderName(email.from)}
            </p>
            <p className="mt-1 truncate text-[13px] text-stone-400">
              {email.subject || "제목 없음"}
            </p>
            {email.summary ? (
              <p className="mt-2 line-clamp-2 text-xs leading-5 text-amber-200/85">
                <span className="mr-1 text-amber-300">EVE:</span>
                {email.summary}
              </p>
            ) : email.snippet ? (
              <p className="mt-2 line-clamp-2 text-xs leading-5 text-stone-600">{email.snippet}</p>
            ) : null}
          </div>
          <time className="shrink-0 text-[11px] tabular-nums text-stone-500 md:pt-1">
            {formatRelative(email.date)}
          </time>
        </div>
      </Link>
    </li>
  );
}
function ReplyNeededBadge() {
  return (
    <span className="text-[10px] px-1.5 py-0.5 rounded border border-amber-400/30 bg-amber-400/10 text-amber-300 font-medium shrink-0">
      답장 필요
    </span>
  );
}

function PriorityBadge({ priority }: { priority: EmailRow["priority"] }) {
  const styles = {
    URGENT: "bg-red-500/15 text-red-300 border-red-500/30",
    NORMAL: "bg-stone-800 text-stone-400 border-stone-700",
    LOW: "bg-stone-900 text-stone-500 border-stone-800",
  } as const;
  const labels = { URGENT: "긴급", NORMAL: "일반", LOW: "낮음" } as const;
  if (priority === "NORMAL") return null;
  return (
    <span
      className={`text-[10px] px-1.5 py-0.5 rounded border ${styles[priority]} font-medium shrink-0`}
    >
      {labels[priority]}
    </span>
  );
}

function CategoryBadge({ category }: { category: string }) {
  const labelMap: Record<string, string> = {
    business: "비즈니스",
    engineering: "엔지니어링",
    automated: "자동화",
    newsletter: "뉴스레터",
    meeting: "미팅",
    billing: "청구",
    conversation: "대화",
    other: "기타",
  };
  const label = labelMap[category] || category;
  return (
    <span className="text-[10px] px-1.5 py-0.5 rounded border border-stone-700 bg-stone-900/60 text-stone-400 shrink-0">
      {label}
    </span>
  );
}

function senderName(raw: string): string {
  const match = raw.match(/^([^<]+?)\s*</);
  if (match?.[1]) return match[1].trim();
  return raw.replace(/[<>]/g, "").trim();
}

function formatRelative(iso: string): string {
  const d = new Date(iso);
  const now = new Date();
  const diffMs = now.getTime() - d.getTime();
  const diffMin = Math.floor(diffMs / 60_000);
  if (diffMin < 1) return "방금";
  if (diffMin < 60) return `${diffMin}분 전`;
  const diffHr = Math.floor(diffMin / 60);
  if (diffHr < 24) return `${diffHr}시간 전`;
  const sameYear = d.getFullYear() === now.getFullYear();
  return d.toLocaleDateString("ko-KR", {
    month: "short",
    day: "numeric",
    ...(sameYear ? {} : { year: "2-digit" }),
  });
}
