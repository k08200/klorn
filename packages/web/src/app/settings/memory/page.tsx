"use client";

import { useEffect, useState } from "react";
import { apiFetch } from "../../../lib/api";
import { captureClientError } from "../../../lib/sentry";

interface Memory {
  id: string;
  type: string;
  key: string;
  content: string;
  source?: string;
  confidence: number;
  updatedAt: string;
}

const TYPE_LABELS: Record<string, { label: string; color: string }> = {
  PREFERENCE: { label: "선호", color: "text-amber-200 bg-amber-500/10 border-amber-500/25" },
  FACT: { label: "사실", color: "text-teal-200 bg-teal-500/10 border-teal-500/25" },
  DECISION: { label: "결정", color: "text-rose-200 bg-rose-500/10 border-rose-500/25" },
  CONTEXT: { label: "맥락", color: "text-emerald-200 bg-emerald-500/10 border-emerald-500/25" },
  FEEDBACK: { label: "피드백", color: "text-stone-200 bg-stone-500/10 border-stone-500/25" },
};

export default function MemoryPage() {
  const [memories, setMemories] = useState<Memory[]>([]);
  const [filter, setFilter] = useState<string>("all");
  const [search, setSearch] = useState("");
  const [stats, setStats] = useState<{ total: number; byType: { type: string; _count: number }[] }>(
    { total: 0, byType: [] },
  );

  const load = () => {
    const params = new URLSearchParams();
    if (filter !== "all") params.set("type", filter);
    if (search) params.set("search", search);
    apiFetch<{ memories: Memory[] }>(`/api/memories?${params}`)
      .then((d) => setMemories(d.memories))
      .catch((err) => captureClientError(err, { scope: "memory.load-list" }));
    apiFetch<{ total: number; byType: { type: string; _count: number }[] }>("/api/memories/stats")
      .then(setStats)
      .catch((err) => captureClientError(err, { scope: "memory.load-stats" }));
  };

  useEffect(() => {
    load();
  }, [filter, search]);

  const deleteMemory = async (id: string) => {
    await apiFetch(`/api/memories/${id}`, { method: "DELETE" });
    setMemories((prev) => prev.filter((m) => m.id !== id));
  };

  return (
    <div className="mx-auto max-w-3xl px-4 pb-28 pt-6 sm:px-6 md:py-10">
      <header className="mb-5 rounded-2xl border border-stone-700/45 bg-stone-950/35 p-5 shadow-2xl shadow-black/10">
        <p className="mb-2 text-[11px] font-semibold uppercase tracking-[0.18em] text-amber-300/80">
          Memory Graph
        </p>
        <h1 className="text-2xl font-semibold tracking-tight text-stone-50">
          EVE가 판단에 쓰는 기억
        </h1>
        <p className="mt-2 max-w-xl text-sm leading-6 text-stone-500">
          승인 방식, 선호, 반복되는 업무 맥락을 확인하고 필요 없는 기억은 지웁니다.
        </p>
        <div className="mt-5 grid grid-cols-3 gap-2">
          <MemoryStat label="전체" value={stats.total} />
          <MemoryStat label="표시" value={memories.length} />
          <MemoryStat label="유형" value={stats.byType.length} />
        </div>
      </header>

      {/* Stats */}
      <div className="mb-4 flex flex-wrap gap-2">
        <button
          type="button"
          onClick={() => setFilter("all")}
          className={`rounded-full border px-3 py-1.5 text-xs transition ${
            filter === "all"
              ? "border-amber-300 bg-amber-300 text-stone-950"
              : "border-stone-700/55 bg-stone-950/45 text-stone-400 hover:bg-stone-900/70 hover:text-stone-200"
          }`}
        >
          전체 ({stats.total})
        </button>
        {Object.entries(TYPE_LABELS).map(([type, { label, color }]) => {
          const count = stats.byType.find((b) => b.type === type)?._count || 0;
          return (
            <button
              key={type}
              type="button"
              onClick={() => setFilter(type)}
              className={`rounded-full border px-3 py-1.5 text-xs transition ${
                filter === type
                  ? `${color} border-current`
                  : "border-stone-700/55 bg-stone-950/45 text-stone-400 hover:bg-stone-900/70 hover:text-stone-200"
              }`}
            >
              {label} ({count})
            </button>
          );
        })}
      </div>

      {/* Search */}
      <div className="mb-6">
        <input
          type="text"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="기억 검색..."
          className="w-full rounded-xl border border-stone-700/60 bg-stone-950/45 px-4 py-2.5 text-sm text-stone-300 placeholder-stone-600 transition focus:border-amber-500/50 focus:outline-none"
        />
      </div>

      {/* Memory list */}
      <div className="space-y-3">
        {memories.map((m) => {
          const typeInfo = TYPE_LABELS[m.type] || {
            label: m.type,
            color: "text-stone-400 bg-stone-500/10 border-stone-500/20",
          };
          return (
            <div
              key={m.id}
              className="group rounded-xl border border-stone-700/45 bg-stone-950/35 p-4 transition hover:border-amber-500/30 hover:bg-amber-500/5"
            >
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0 flex-1">
                  <div className="mb-1.5 flex items-center gap-2">
                    <span
                      className={`inline-flex items-center rounded-full border px-2 py-0.5 text-[10px] font-medium ${typeInfo.color}`}
                    >
                      {typeInfo.label}
                    </span>
                    <span className="font-mono text-[12px] text-stone-500">{m.key}</span>
                  </div>
                  <p className="text-sm leading-relaxed text-stone-200">{m.content}</p>
                  <p className="mt-2 text-[11px] text-stone-600">
                    업데이트: {new Date(m.updatedAt).toLocaleDateString("ko-KR")}
                    {m.source && ` | 출처: ${m.source}`}
                  </p>
                </div>
                <button
                  type="button"
                  onClick={() => deleteMemory(m.id)}
                  className="rounded-md p-1.5 text-stone-600 opacity-0 transition hover:bg-red-500/10 hover:text-red-400 group-hover:opacity-100"
                  title="기억 삭제"
                >
                  <svg
                    aria-hidden="true"
                    width="14"
                    height="14"
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="2"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                  >
                    <polyline points="3 6 5 6 21 6" />
                    <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" />
                  </svg>
                </button>
              </div>
            </div>
          );
        })}

        {memories.length === 0 && (
          <div className="rounded-xl border border-stone-700/45 bg-stone-950/35 py-12 text-center">
            <p className="mb-1 text-sm text-stone-400">아직 저장된 기억이 없습니다</p>
            <p className="text-xs text-stone-600">
              일을 처리하면서 EVE가 결정 선호와 반복 맥락을 기억합니다.
            </p>
          </div>
        )}
      </div>
    </div>
  );
}

function MemoryStat({ label, value }: { label: string; value: number }) {
  return (
    <div className="rounded-xl border border-stone-700/45 bg-black/15 px-3 py-2">
      <p className="text-[10px] font-semibold uppercase tracking-[0.14em] text-stone-600">
        {label}
      </p>
      <p className="mt-1 text-lg font-semibold text-stone-100">{value}</p>
    </div>
  );
}
