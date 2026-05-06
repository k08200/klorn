"use client";

import { useCallback, useEffect, useState } from "react";
import AuthGuard from "../../../components/auth-guard";
import { useToast } from "../../../components/toast";
import { apiFetch } from "../../../lib/api";

interface WaitlistEntry {
  id: string;
  email: string;
  name: string | null;
  useCase: string | null;
  status: "PENDING" | "APPROVED" | "REJECTED";
  approvedAt: string | null;
  createdAt: string;
}

interface WaitlistResponse {
  entries: WaitlistEntry[];
  counts: Record<string, number>;
}

type Filter = "PENDING" | "APPROVED" | "REJECTED" | "ALL";

const FILTERS: Array<{ key: Filter; label: string }> = [
  { key: "PENDING", label: "대기" },
  { key: "APPROVED", label: "승인됨" },
  { key: "REJECTED", label: "거절됨" },
  { key: "ALL", label: "전체" },
];

function formatDate(iso: string): string {
  try {
    return new Date(iso).toLocaleString("ko-KR", {
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
    });
  } catch {
    return iso;
  }
}

export default function AdminWaitlistPage() {
  return (
    <AuthGuard>
      <WaitlistPageInner />
    </AuthGuard>
  );
}

function WaitlistPageInner() {
  const { toast } = useToast();
  const [entries, setEntries] = useState<WaitlistEntry[]>([]);
  const [counts, setCounts] = useState<Record<string, number>>({});
  const [filter, setFilter] = useState<Filter>("PENDING");
  const [loading, setLoading] = useState(true);
  const [updating, setUpdating] = useState<string | null>(null);
  const [copiedId, setCopiedId] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const qs = filter === "ALL" ? "" : `?status=${filter}`;
      const data = await apiFetch<WaitlistResponse>(`/api/admin/waitlist${qs}`);
      setEntries(data.entries);
      setCounts(data.counts);
    } catch (err) {
      toast(err instanceof Error ? err.message : "Failed to load waitlist", "error");
    } finally {
      setLoading(false);
    }
  }, [filter, toast]);

  useEffect(() => {
    load();
  }, [load]);

  const updateStatus = async (id: string, status: "APPROVED" | "REJECTED" | "PENDING") => {
    setUpdating(id);
    try {
      await apiFetch(`/api/admin/waitlist/${id}`, {
        method: "PATCH",
        body: JSON.stringify({ status }),
      });
      toast(
        status === "APPROVED" ? "승인됨" : status === "REJECTED" ? "거절됨" : "대기로 되돌림",
        "success",
      );
      await load();
    } catch (err) {
      toast(err instanceof Error ? err.message : "Update failed", "error");
    } finally {
      setUpdating(null);
    }
  };

  const copyEmail = async (entry: WaitlistEntry) => {
    try {
      await navigator.clipboard.writeText(entry.email);
      setCopiedId(entry.id);
      setTimeout(() => setCopiedId((id) => (id === entry.id ? null : id)), 1500);
    } catch {
      toast("클립보드 접근 실패", "error");
    }
  };

  return (
    <main className="min-h-dvh bg-[#06060a] p-6 text-white md:p-10">
      <div className="mx-auto max-w-5xl">
        <header className="mb-8">
          <h1 className="text-2xl font-semibold">Early Access Waitlist</h1>
          <p className="mt-2 text-sm text-gray-400">
            새 신청 검토 → 이메일 복사 → Google Cloud Console Test users에 추가 → “승인됨”으로 마킹.
          </p>
        </header>

        <section className="mb-6 grid grid-cols-3 gap-3 md:grid-cols-4">
          {FILTERS.map((f) => {
            const value = f.key === "ALL" ? entries.length : (counts[f.key] ?? 0);
            const isActive = filter === f.key;
            return (
              <button
                key={f.key}
                type="button"
                onClick={() => setFilter(f.key)}
                className={`rounded-xl border px-4 py-3 text-left transition ${
                  isActive
                    ? "border-blue-400 bg-blue-500/10 text-white"
                    : "border-gray-800 bg-gray-900/30 text-gray-400 hover:border-gray-700 hover:text-white"
                }`}
              >
                <div className="text-xs uppercase tracking-wide">{f.label}</div>
                <div className="mt-1 text-2xl font-semibold">{value}</div>
              </button>
            );
          })}
        </section>

        {loading ? (
          <p className="text-sm text-gray-500">로딩 중…</p>
        ) : entries.length === 0 ? (
          <p className="rounded-xl border border-gray-800 bg-gray-900/30 p-6 text-sm text-gray-400">
            해당 상태의 신청이 없어요.
          </p>
        ) : (
          <ul className="space-y-3">
            {entries.map((entry) => (
              <li
                key={entry.id}
                className="rounded-xl border border-gray-800 bg-gray-900/30 p-4 md:p-5"
              >
                <div className="flex flex-col gap-2 md:flex-row md:items-start md:justify-between">
                  <div className="min-w-0">
                    <div className="flex flex-wrap items-center gap-2">
                      <button
                        type="button"
                        onClick={() => copyEmail(entry)}
                        className="break-all text-base font-semibold text-white transition hover:text-blue-300"
                        title="클릭해서 이메일 복사"
                      >
                        {entry.email}
                      </button>
                      <StatusBadge status={entry.status} />
                      {copiedId === entry.id && (
                        <span className="text-xs text-blue-300">copied</span>
                      )}
                    </div>
                    <div className="mt-1 text-xs text-gray-500">
                      {entry.name ? `${entry.name} · ` : ""}
                      {formatDate(entry.createdAt)}
                      {entry.approvedAt ? ` · approved ${formatDate(entry.approvedAt)}` : ""}
                    </div>
                    {entry.useCase && (
                      <p className="mt-3 max-w-3xl text-sm leading-6 text-gray-300">
                        {entry.useCase}
                      </p>
                    )}
                  </div>

                  <div className="flex shrink-0 flex-wrap gap-2">
                    {entry.status !== "APPROVED" && (
                      <button
                        type="button"
                        onClick={() => updateStatus(entry.id, "APPROVED")}
                        disabled={updating === entry.id}
                        className="rounded-lg bg-blue-600 px-3 py-1.5 text-sm font-medium text-white transition hover:bg-blue-500 disabled:opacity-60"
                      >
                        승인
                      </button>
                    )}
                    {entry.status !== "REJECTED" && (
                      <button
                        type="button"
                        onClick={() => updateStatus(entry.id, "REJECTED")}
                        disabled={updating === entry.id}
                        className="rounded-lg border border-gray-700 px-3 py-1.5 text-sm text-gray-300 transition hover:bg-gray-800 disabled:opacity-60"
                      >
                        거절
                      </button>
                    )}
                    {entry.status !== "PENDING" && (
                      <button
                        type="button"
                        onClick={() => updateStatus(entry.id, "PENDING")}
                        disabled={updating === entry.id}
                        className="rounded-lg border border-gray-700 px-3 py-1.5 text-sm text-gray-300 transition hover:bg-gray-800 disabled:opacity-60"
                      >
                        되돌리기
                      </button>
                    )}
                  </div>
                </div>
              </li>
            ))}
          </ul>
        )}
      </div>
    </main>
  );
}

function StatusBadge({ status }: { status: WaitlistEntry["status"] }) {
  const map: Record<WaitlistEntry["status"], { label: string; cls: string }> = {
    PENDING: { label: "대기", cls: "border-amber-500/40 bg-amber-500/10 text-amber-200" },
    APPROVED: { label: "승인됨", cls: "border-emerald-500/40 bg-emerald-500/10 text-emerald-200" },
    REJECTED: { label: "거절됨", cls: "border-gray-600 bg-gray-700/30 text-gray-400" },
  };
  const s = map[status];
  return (
    <span className={`rounded-full border px-2 py-0.5 text-[11px] font-medium ${s.cls}`}>
      {s.label}
    </span>
  );
}
