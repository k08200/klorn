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
  { key: "PENDING", label: "Pending" },
  { key: "APPROVED", label: "Approved" },
  { key: "REJECTED", label: "Rejected" },
  { key: "ALL", label: "All" },
];

function formatDate(iso: string): string {
  try {
    return new Date(iso).toLocaleString("en-US", {
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
      toast(err instanceof Error ? err.message : "Could not load the waitlist.", "error");
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
        status === "APPROVED"
          ? "Approved."
          : status === "REJECTED"
            ? "Rejected."
            : "Moved back to pending.",
        "success",
      );
      await load();
    } catch (err) {
      toast(err instanceof Error ? err.message : "Could not update status.", "error");
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
      toast("Could not copy email.", "error");
    }
  };

  return (
    <main className="min-h-dvh bg-[#10100d] px-4 pb-28 pt-6 text-stone-50 sm:px-6 md:py-10">
      <div className="mx-auto max-w-5xl">
        <header className="mb-6 rounded-2xl border border-stone-700/45 bg-stone-950/35 p-5 shadow-sm shadow-black/20">
          <p className="text-xs font-semibold uppercase tracking-[0.24em] text-amber-300">
            Access review
          </p>
          <h1 className="mt-3 text-2xl font-semibold tracking-tight text-stone-50">
            Early access waitlist
          </h1>
          <p className="mt-2 max-w-3xl text-sm leading-6 text-stone-400">
            Review new requests, move approved candidates into testing, and keep access status
            clear.
          </p>
        </header>

        <div className="mb-6 rounded-xl border border-amber-300/35 bg-amber-300/[0.06] p-4 text-sm leading-6 text-amber-100/90">
          <p className="font-semibold text-amber-100">
            ⚠️ Do this BEFORE clicking Approve — every time.
          </p>
          <ol className="mt-2 list-decimal space-y-1 pl-6 text-[13px] text-amber-100/85">
            <li>
              Copy the email from the row below (click the address to copy).
            </li>
            <li>
              Open{" "}
              <a
                href="https://console.cloud.google.com/apis/credentials/consent"
                target="_blank"
                rel="noopener noreferrer"
                className="underline decoration-amber-400/60 underline-offset-2 hover:text-amber-50"
              >
                Google Cloud Console → OAuth consent screen → Test users
              </a>{" "}
              and click <strong>Add users</strong>. Paste, Save.
            </li>
            <li>
              <strong>Then</strong> click Approve here. Clicking Approve fires the "you're in"
              email — if the Cloud Console step is skipped, the user still hits "Access blocked"
              and bounces.
            </li>
          </ol>
        </div>

        <section className="mb-6 grid grid-cols-2 gap-3 md:grid-cols-4">
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
                    ? "border-amber-300/60 bg-amber-300/10 text-stone-50"
                    : "border-stone-700/45 bg-stone-950/35 text-stone-400 hover:border-stone-500 hover:text-stone-100"
                }`}
              >
                <div className="text-xs uppercase tracking-wide">{f.label}</div>
                <div className="mt-1 text-2xl font-semibold">{value}</div>
              </button>
            );
          })}
        </section>

        {loading ? (
          <p className="text-sm text-stone-500">Loading...</p>
        ) : entries.length === 0 ? (
          <p className="rounded-xl border border-stone-700/45 bg-stone-950/35 p-6 text-sm text-stone-400">
            No requests in this state.
          </p>
        ) : (
          <ul className="space-y-3">
            {entries.map((entry) => (
              <li
                key={entry.id}
                className="rounded-2xl border border-stone-700/45 bg-stone-950/35 p-4 md:p-5"
              >
                <div className="flex flex-col gap-2 md:flex-row md:items-start md:justify-between">
                  <div className="min-w-0">
                    <div className="flex flex-wrap items-center gap-2">
                      <button
                        type="button"
                        onClick={() => copyEmail(entry)}
                        className="break-all text-base font-semibold text-stone-50 transition hover:text-amber-200"
                        title="Copy email"
                      >
                        {entry.email}
                      </button>
                      <StatusBadge status={entry.status} />
                      {copiedId === entry.id && (
                        <span className="text-xs text-amber-200">Copied</span>
                      )}
                    </div>
                    <div className="mt-1 text-xs text-stone-500">
                      {entry.name ? `${entry.name} · ` : ""}
                      {formatDate(entry.createdAt)}
                      {entry.approvedAt ? ` · approved ${formatDate(entry.approvedAt)}` : ""}
                    </div>
                    {entry.useCase && (
                      <p className="mt-3 max-w-3xl text-sm leading-6 text-stone-300">
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
                        className="rounded-lg bg-amber-300 px-3 py-1.5 text-sm font-semibold text-stone-950 transition hover:bg-amber-200 disabled:opacity-60"
                      >
                        Approve
                      </button>
                    )}
                    {entry.status !== "REJECTED" && (
                      <button
                        type="button"
                        onClick={() => updateStatus(entry.id, "REJECTED")}
                        disabled={updating === entry.id}
                        className="rounded-lg border border-stone-700 px-3 py-1.5 text-sm text-stone-300 transition hover:border-red-400/50 hover:text-red-200 disabled:opacity-60"
                      >
                        Reject
                      </button>
                    )}
                    {entry.status !== "PENDING" && (
                      <button
                        type="button"
                        onClick={() => updateStatus(entry.id, "PENDING")}
                        disabled={updating === entry.id}
                        className="rounded-lg border border-stone-700 px-3 py-1.5 text-sm text-stone-300 transition hover:border-stone-500 disabled:opacity-60"
                      >
                        Move to pending
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
    PENDING: { label: "Pending", cls: "border-amber-500/40 bg-amber-500/10 text-amber-200" },
    APPROVED: {
      label: "Approved",
      cls: "border-emerald-500/40 bg-emerald-500/10 text-emerald-200",
    },
    REJECTED: { label: "Rejected", cls: "border-stone-600 bg-stone-700/30 text-stone-400" },
  };
  const s = map[status];
  return (
    <span className={`rounded-full border px-2 py-0.5 text-[11px] font-medium ${s.cls}`}>
      {s.label}
    </span>
  );
}
