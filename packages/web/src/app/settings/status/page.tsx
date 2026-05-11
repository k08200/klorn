"use client";

import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import AuthGuard from "../../../components/auth-guard";
import { useToast } from "../../../components/toast";
import { apiFetch } from "../../../lib/api";
import { captureClientError } from "../../../lib/sentry";

type CheckStatus = "ok" | "warning" | "error";

interface ReadinessCheck {
  key: string;
  label: string;
  status: CheckStatus;
  message: string;
  detail?: Record<string, unknown>;
}

interface ReadinessResponse {
  status: CheckStatus;
  generatedAt: string;
  system: {
    commit: string | null;
    uptime: number;
    environment: string;
    apiUrl: string | null;
  };
  checks: ReadinessCheck[];
}

interface ReminderDiagnostics {
  now: string;
  subscriptions: number;
  reminders: Array<{
    id: string;
    title: string;
    status: string;
    remindAt: string;
    due: boolean;
  }>;
  notifications: Array<{ id: string; title: string; createdAt: string }>;
  pushDeliveries: Array<{
    id: string;
    notificationId: string | null;
    category: string;
    title: string;
    status: string;
    skipReason: string | null;
    acceptedAt: string | null;
    receivedAt: string | null;
    clickedAt: string | null;
    createdAt: string;
  }>;
}

const STATUS_LABELS: Record<CheckStatus, string> = {
  ok: "정상",
  warning: "설정 필요",
  error: "점검 필요",
};

const STATUS_CLASSES: Record<CheckStatus, string> = {
  ok: "border-emerald-500/30 bg-emerald-500/10 text-emerald-300",
  warning: "border-amber-500/30 bg-amber-500/10 text-amber-300",
  error: "border-red-500/30 bg-red-500/10 text-red-300",
};

export default function SettingsStatusPage() {
  const [readiness, setReadiness] = useState<ReadinessResponse | null>(null);
  const [diagnostics, setDiagnostics] = useState<ReminderDiagnostics | null>(null);
  const [loading, setLoading] = useState(true);
  const [delivering, setDelivering] = useState(false);
  const { toast } = useToast();

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const [nextReadiness, nextDiagnostics] = await Promise.all([
        apiFetch<ReadinessResponse>("/api/ops/readiness"),
        apiFetch<ReminderDiagnostics>("/api/reminders/diagnostics"),
      ]);
      setReadiness(nextReadiness);
      setDiagnostics(nextDiagnostics);
    } catch (err) {
      captureClientError(err, { scope: "settings.status.load" });
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  const deliverDue = async () => {
    setDelivering(true);
    try {
      const result = await apiFetch<{ found: number; delivered: number; failed: number }>(
        "/api/reminders/deliver-due",
        { method: "POST" },
      );
      toast(
        `리마인더 확인 완료: ${result.delivered}/${result.found}건 전달`,
        result.failed > 0 ? "error" : "success",
      );
      await load();
    } catch (err) {
      captureClientError(err, { scope: "settings.status.deliver-due" });
      toast("리마인더 전달 확인에 실패했습니다.", "error");
    } finally {
      setDelivering(false);
    }
  };

  return (
    <AuthGuard>
      <main className="mx-auto max-w-4xl px-4 pb-28 pt-6 sm:px-6 md:py-10">
        <header className="mb-6 rounded-2xl border border-stone-700/45 bg-stone-950/35 p-5 shadow-2xl shadow-black/10">
          <div className="flex items-start justify-between gap-4">
            <div>
              <Link
                href="/settings"
                className="mb-3 inline-flex rounded-full border border-stone-700/45 px-3 py-1.5 text-xs text-stone-400 transition hover:border-amber-500/35 hover:text-stone-100"
              >
                설정으로 돌아가기
              </Link>
              <p className="mb-2 text-[11px] font-semibold uppercase tracking-[0.18em] text-amber-300/80">
                운영 상태
              </p>
              <h1 className="text-2xl font-semibold tracking-tight text-stone-50">EVE 상태</h1>
              <p className="mt-2 max-w-xl text-sm leading-6 text-stone-500">
                배포, 연동, 푸시, 리마인더, 브리핑 준비 상태를 한 곳에서 확인합니다.
              </p>
            </div>
            <button
              type="button"
              onClick={load}
              className="shrink-0 rounded-lg border border-stone-700/60 px-3 py-2 text-sm text-stone-300 transition hover:border-amber-500/40 hover:bg-amber-500/10 hover:text-amber-100"
            >
              새로고침
            </button>
          </div>
        </header>

        {loading && !readiness ? (
          <div className="py-20 text-center text-sm text-stone-500">상태를 확인하는 중...</div>
        ) : readiness ? (
          <>
            <section className="mb-6 grid gap-3 sm:grid-cols-3">
              <SummaryTile
                label="전체 상태"
                value={STATUS_LABELS[readiness.status]}
                status={readiness.status}
              />
              <SummaryTile
                label="API 커밋"
                value={readiness.system.commit ? readiness.system.commit.slice(0, 8) : "알 수 없음"}
                status={readiness.system.commit ? "ok" : "warning"}
              />
              <SummaryTile
                label="가동 시간"
                value={formatDuration(readiness.system.uptime)}
                status="ok"
              />
            </section>

            <section className="mb-8">
              <h2 className="mb-3 text-sm font-semibold text-stone-300">준비 상태 점검</h2>
              <div className="grid gap-3 sm:grid-cols-2">
                {readiness.checks.map((check) => (
                  <div
                    key={check.key}
                    className="rounded-xl border border-stone-700/45 bg-stone-950/35 p-4"
                  >
                    <div className="mb-2 flex items-center justify-between gap-3">
                      <h3 className="text-sm font-medium text-stone-100">
                        {readinessCheckLabel(check)}
                      </h3>
                      <StatusPill status={check.status} />
                    </div>
                    <p className="text-sm text-stone-400">{readinessCheckMessage(check)}</p>
                    {check.detail ? (
                      <pre className="mt-3 max-h-32 overflow-auto rounded-md bg-black/20 p-3 text-[11px] leading-relaxed text-stone-500">
                        {JSON.stringify(check.detail, null, 2)}
                      </pre>
                    ) : null}
                  </div>
                ))}
              </div>
            </section>

            <section className="mb-8">
              <div className="mb-3 flex items-center justify-between gap-4">
                <h2 className="text-sm font-semibold text-stone-300">리마인더 진단</h2>
                <button
                  type="button"
                  onClick={deliverDue}
                  disabled={delivering}
                  className="rounded-lg border border-stone-700/60 px-3 py-1.5 text-sm text-stone-300 transition hover:border-amber-500/40 hover:bg-amber-500/10 hover:text-amber-100 disabled:cursor-not-allowed disabled:opacity-50"
                >
                  {delivering ? "확인 중..." : "마감 리마인더 확인"}
                </button>
              </div>
              {diagnostics ? (
                <div className="rounded-xl border border-stone-700/45 bg-stone-950/35 p-4">
                  <div className="mb-4 grid gap-3 sm:grid-cols-3">
                    <Metric label="푸시 구독" value={String(diagnostics.subscriptions)} />
                    <Metric label="최근 리마인더" value={String(diagnostics.reminders.length)} />
                    <Metric label="푸시 전달" value={String(diagnostics.pushDeliveries.length)} />
                  </div>
                  <div className="grid gap-4 lg:grid-cols-3">
                    <DiagnosticsList
                      title="리마인더"
                      empty="최근 리마인더가 없습니다"
                      rows={diagnostics.reminders.map((r) => ({
                        id: r.id,
                        title: r.title,
                        meta: `${r.status}${r.due ? " | 마감" : ""} | ${formatDate(r.remindAt)}`,
                      }))}
                    />
                    <DiagnosticsList
                      title="알림"
                      empty="리마인더 알림이 없습니다"
                      rows={diagnostics.notifications.map((n) => ({
                        id: n.id,
                        title: n.title,
                        meta: formatDate(n.createdAt),
                      }))}
                    />
                    <DiagnosticsList
                      title="푸시"
                      empty="최근 푸시 전달이 없습니다"
                      rows={diagnostics.pushDeliveries.map((d) => ({
                        id: d.id,
                        title: d.title,
                        meta: `${d.status}${d.skipReason ? ` | ${d.skipReason}` : ""} | ${
                          d.receivedAt ? "수신" : d.acceptedAt ? "접수" : formatDate(d.createdAt)
                        }`,
                      }))}
                    />
                  </div>
                </div>
              ) : (
                <div className="rounded-xl border border-stone-700/45 bg-stone-950/35 p-6 text-sm text-stone-500">
                  리마인더 진단 정보를 불러올 수 없습니다.
                </div>
              )}
            </section>
          </>
        ) : (
          <div className="rounded-lg border border-red-900/50 bg-red-950/20 p-6 text-sm text-red-300">
            EVE 상태를 불러오지 못했습니다.
          </div>
        )}
      </main>
    </AuthGuard>
  );
}

function SummaryTile({
  label,
  value,
  status,
}: {
  label: string;
  value: string;
  status: CheckStatus;
}) {
  return (
    <div className="rounded-xl border border-stone-700/45 bg-stone-950/35 p-4">
      <p className="mb-1 text-xs text-stone-500">{label}</p>
      <p
        className={
          status === "ok"
            ? "text-lg font-semibold text-stone-100"
            : "text-lg font-semibold text-amber-300"
        }
      >
        {value}
      </p>
    </div>
  );
}

function StatusPill({ status }: { status: CheckStatus }) {
  return (
    <span
      className={`rounded-full border px-2 py-0.5 text-[11px] font-medium ${STATUS_CLASSES[status]}`}
    >
      {STATUS_LABELS[status]}
    </span>
  );
}

function detailNumber(check: ReadinessCheck, key: string): number | null {
  const value = check.detail?.[key];
  return typeof value === "number" ? value : null;
}

function readinessCheckLabel(check: ReadinessCheck): string {
  const labels: Record<string, string> = {
    db: "데이터베이스",
    devices: "로그인 기기",
    push: "푸시 알림",
    google: "Google 계정",
    automations: "자동화 설정",
    reminders: "리마인더",
    briefing: "일일 브리핑",
    data: "동기화 데이터",
  };
  return labels[check.key] ?? check.label;
}

function readinessCheckMessage(check: ReadinessCheck): string {
  switch (check.key) {
    case "db":
      return check.status === "ok" ? "연결됨" : "연결할 수 없습니다";
    case "devices": {
      const count = detailNumber(check, "count") ?? 0;
      return count > 0 ? `활성 기기 ${count}대` : "로그인된 기기가 없습니다";
    }
    case "push": {
      const subscriptions = detailNumber(check, "subscriptions") ?? 0;
      if (check.status === "error") return "VAPID 키 설정이 필요합니다";
      return subscriptions > 0 ? `푸시 구독 ${subscriptions}건 등록됨` : "푸시 구독이 없습니다";
    }
    case "google":
      return check.status === "ok" ? "연결됨" : "연결되지 않았습니다";
    case "automations":
      return check.status === "ok" ? "설정됨" : "자동화 설정이 필요합니다";
    case "reminders": {
      const overdue = detailNumber(check, "overdue") ?? 0;
      return overdue > 0 ? `마감 리마인더 ${overdue}건 대기 중` : "지난 리마인더가 없습니다";
    }
    case "briefing":
      if (check.message.startsWith("Generated today")) return "오늘 브리핑이 생성되었습니다";
      if (check.message.startsWith("Enabled for")) return "브리핑 자동화가 켜져 있습니다";
      return "브리핑 자동화가 꺼져 있습니다";
    case "data": {
      const emails = detailNumber(check, "emails") ?? 0;
      const events = detailNumber(check, "upcomingCalendarEvents") ?? 0;
      return emails > 0 || events > 0
        ? `이메일 ${emails}건, 예정된 일정 ${events}건`
        : "동기화된 이메일이나 일정이 아직 없습니다";
    }
    default:
      return check.message;
  }
}

function Metric({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <p className="text-xs text-stone-500">{label}</p>
      <p className="text-lg font-semibold text-stone-100">{value}</p>
    </div>
  );
}

function DiagnosticsList({
  title,
  empty,
  rows,
}: {
  title: string;
  empty: string;
  rows: Array<{ id: string; title: string; meta: string }>;
}) {
  return (
    <div>
      <h3 className="mb-2 text-xs font-medium uppercase tracking-wide text-stone-500">{title}</h3>
      {rows.length === 0 ? (
        <p className="text-sm text-stone-600">{empty}</p>
      ) : (
        <div className="space-y-2">
          {rows.slice(0, 5).map((row) => (
            <div key={row.id} className="rounded-md border border-stone-700/45 bg-black/15 p-3">
              <p className="truncate text-sm text-stone-300">{row.title}</p>
              <p className="mt-1 truncate text-xs text-stone-500">{row.meta}</p>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function formatDuration(seconds: number): string {
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  return `${hours}h ${minutes % 60}m`;
}

function formatDate(value: string): string {
  return new Intl.DateTimeFormat("ko-KR", {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  }).format(new Date(value));
}
