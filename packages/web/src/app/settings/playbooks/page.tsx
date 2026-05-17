"use client";

import { useCallback, useEffect, useState } from "react";
import AuthGuard from "../../../components/auth-guard";
import PlaybookRecommendations from "../../../components/playbook-recommendations";
import { apiFetch } from "../../../lib/api";
import { captureClientError } from "../../../lib/sentry";
import type { JigeumPlaybook } from "../../../lib/playbooks";

const DOMAIN_META: Record<string, { label: string; color: string }> = {
  investment: {
    label: "Investors",
    color: "text-emerald-300 border-emerald-400/20 bg-emerald-400/10",
  },
  customer_success: { label: "Customers", color: "text-sky-300 border-sky-400/20 bg-sky-400/10" },
  launch: { label: "Launch", color: "text-fuchsia-300 border-fuchsia-400/20 bg-fuchsia-400/10" },
  hiring: { label: "Hiring", color: "text-amber-300 border-amber-400/20 bg-amber-400/10" },
};

function PlaybookRow({
  playbook,
  onToggle,
  toggling,
}: {
  playbook: JigeumPlaybook;
  onToggle: (id: string, active: boolean) => void;
  toggling: boolean;
}) {
  const domain = DOMAIN_META[playbook.domain] ?? {
    label: playbook.domain,
    color: "text-stone-400 border-stone-700 bg-stone-800",
  };
  const active = Boolean(playbook.active);

  return (
    <div className="flex items-start gap-4 rounded-xl border border-stone-800 bg-stone-900/40 p-4 transition hover:border-stone-700">
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-2">
          <span className={`rounded border px-1.5 py-0.5 text-[10px] font-medium ${domain.color}`}>
            {domain.label}
          </span>
          {active && (
            <span className="rounded border border-emerald-400/20 bg-emerald-400/10 px-1.5 py-0.5 text-[10px] font-medium text-emerald-300">
              Active
            </span>
          )}
        </div>

        <p className="mt-2 text-sm font-semibold text-stone-100">{playbook.name}</p>
        <p className="mt-0.5 text-[12px] text-stone-500">{playbook.description}</p>

        <div className="mt-2 flex flex-wrap gap-2 text-[11px] text-stone-600">
          <span>Best for: {playbook.bestFor}</span>
          <span>·</span>
          <span>Cadence: {playbook.cadence}</span>
        </div>
      </div>

      <button
        type="button"
        onClick={() => onToggle(playbook.id, !active)}
        disabled={toggling}
        className={`shrink-0 rounded-lg border px-3 py-1.5 text-[12px] font-medium transition disabled:opacity-50 ${
          active
            ? "border-stone-700 text-stone-400 hover:bg-stone-800"
            : "border-amber-300/25 bg-amber-300/10 text-amber-200 hover:bg-amber-300/15"
        }`}
      >
        {toggling ? "…" : active ? "Pause" : "Activate"}
      </button>
    </div>
  );
}

function PlaybooksContent() {
  const [playbooks, setPlaybooks] = useState<JigeumPlaybook[]>([]);
  const [loading, setLoading] = useState(true);
  const [toggling, setToggling] = useState<string | null>(null);

  const load = useCallback(() => {
    apiFetch<{ playbooks: JigeumPlaybook[] }>("/api/playbooks")
      .then((data) => setPlaybooks(Array.isArray(data.playbooks) ? data.playbooks : []))
      .catch((err) => captureClientError(err, { scope: "playbooks.load" }))
      .finally(() => setLoading(false));
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  const handleToggle = useCallback(
    async (id: string, activate: boolean) => {
      setToggling(id);
      try {
        await apiFetch(`/api/playbooks/${id}/activate`, {
          method: activate ? "POST" : "DELETE",
        });
        load();
      } catch (err) {
        captureClientError(err, { scope: "playbooks.toggle" });
      } finally {
        setToggling(null);
      }
    },
    [load],
  );

  const active = playbooks.filter((p) => p.active);
  const inactive = playbooks.filter((p) => !p.active);

  return (
    <div className="min-h-dvh bg-[#0f1115]">
      <div className="mx-auto max-w-2xl px-6 py-8">
        {/* Header */}
        <div className="mb-6">
          <h1 className="text-xl font-semibold text-stone-100">Playbooks</h1>
          <p className="mt-1 text-[13px] text-stone-500">
            Specialized workflows EVE follows for specific contexts — investment ops, hiring,
            customer success, launch. Activate the ones that match your current focus.
          </p>
        </div>

        {/* Recommendations */}
        <div className="mb-6">
          <PlaybookRecommendations />
        </div>

        {/* All playbooks */}
        {loading ? (
          <div className="space-y-3">
            {Array.from({ length: 4 }).map((_, i) => (
              <div
                key={i}
                className="h-24 animate-pulse rounded-xl border border-stone-800 bg-stone-900/30"
              />
            ))}
          </div>
        ) : (
          <div className="space-y-6">
            {active.length > 0 && (
              <div>
                <p className="mb-2 text-[11px] font-semibold uppercase tracking-widest text-stone-600">
                  Active
                </p>
                <div className="space-y-2">
                  {active.map((p) => (
                    <PlaybookRow
                      key={p.id}
                      playbook={p}
                      onToggle={handleToggle}
                      toggling={toggling === p.id}
                    />
                  ))}
                </div>
              </div>
            )}

            {inactive.length > 0 && (
              <div>
                <p className="mb-2 text-[11px] font-semibold uppercase tracking-widest text-stone-600">
                  Available
                </p>
                <div className="space-y-2">
                  {inactive.map((p) => (
                    <PlaybookRow
                      key={p.id}
                      playbook={p}
                      onToggle={handleToggle}
                      toggling={toggling === p.id}
                    />
                  ))}
                </div>
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

export default function PlaybooksPage() {
  return (
    <AuthGuard>
      <PlaybooksContent />
    </AuthGuard>
  );
}
