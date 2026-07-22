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
    <div className="min-h-dvh px-4 pb-28 pt-6 text-slate-900 sm:px-6 md:py-10">
      <div className="mx-auto max-w-5xl">
        <header className="mb-6">
          <h1 className="text-[28px] font-semibold leading-none tracking-[-0.02em] text-slate-900">
            Early access waitlist
          </h1>
          <p className="mt-2 max-w-3xl text-sm text-slate-500">
            Review new requests, move approved candidates into testing, and keep access status
            clear.
          </p>
        </header>

        <div className="mb-6 rounded-xl border border-amber-200 bg-amber-50 p-4 text-sm leading-6 text-amber-800">
          <p className="font-semibold text-amber-800">
            ⚠️ Do this BEFORE clicking Approve — every time.
          </p>
          <ol className="mt-2 list-decimal space-y-1 pl-6 text-[13px] text-amber-700">
            <li>Copy the email from the row below (click the address to copy).</li>
            <li>
              Open{" "}
              <a
                href="https://console.cloud.google.com/apis/credentials/consent"
                target="_blank"
                rel="noopener noreferrer"
                className="underline decoration-amber-500/60 underline-offset-2 hover:text-amber-900"
              >
                Google Cloud Console → OAuth consent screen → Test users
              </a>{" "}
              and click <strong>Add users</strong>. Paste, Save.
            </li>
            <li>
              <strong>Then</strong> click Approve here. Clicking Approve fires the "you're in" email
              — if the Cloud Console step is skipped, the user still hits "Access blocked" and
              bounces.
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
                className={`ease-strong rounded-xl border px-4 py-3 text-left transition duration-150 active:scale-[0.97] ${
                  isActive
                    ? "panel-elevated border-sky-300 bg-sky-50 text-slate-900"
                    : "border-slate-200 bg-white/70 text-slate-500 hover:bg-white hover:text-slate-900"
                }`}
              >
                <div className="text-xs uppercase tracking-wide">{f.label}</div>
                <div className="mt-1 text-2xl font-semibold tabular-nums">{value}</div>
              </button>
            );
          })}
        </section>

        {loading ? (
          <p className="text-sm text-slate-400">Loading...</p>
        ) : entries.length === 0 ? (
          <p className="panel-elevated rounded-2xl border border-slate-200/70 bg-white p-6 text-sm text-slate-500">
            No requests in this state.
          </p>
        ) : (
          <section className="panel-elevated overflow-hidden rounded-2xl border border-slate-200/70 bg-white">
            <ul className="divide-y divide-slate-100">
              {entries.map((entry) => (
                <li key={entry.id} className="row-wash p-4 md:p-5">
                  <div className="flex flex-col gap-2 md:flex-row md:items-start md:justify-between">
                    <div className="flex min-w-0 items-start gap-3">
                      <span
                        aria-hidden="true"
                        className={`avatar-ring mt-0.5 flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-gradient-to-br text-[13px] font-semibold text-white ${avatarGradient(entry.name || entry.email)}`}
                      >
                        {senderInitials(entry.name || entry.email)}
                      </span>
                      <div className="min-w-0">
                        <div className="flex flex-wrap items-center gap-2">
                          <button
                            type="button"
                            onClick={() => copyEmail(entry)}
                            className="break-all text-base font-semibold text-slate-900 transition duration-150 hover:text-sky-600"
                            title="Copy email"
                          >
                            {entry.email}
                          </button>
                          <StatusBadge status={entry.status} />
                          {copiedId === entry.id && (
                            <span className="text-xs text-sky-600">Copied</span>
                          )}
                        </div>
                        <div className="mt-1 text-xs tabular-nums text-slate-400">
                          {entry.name ? `${entry.name} · ` : ""}
                          {formatDate(entry.createdAt)}
                          {entry.approvedAt ? ` · approved ${formatDate(entry.approvedAt)}` : ""}
                        </div>
                        {entry.useCase && (
                          <p className="mt-3 max-w-3xl text-sm leading-6 text-slate-500">
                            {entry.useCase}
                          </p>
                        )}
                      </div>
                    </div>

                    <div className="flex shrink-0 flex-wrap gap-2">
                      {entry.status !== "APPROVED" && (
                        <button
                          type="button"
                          onClick={() => updateStatus(entry.id, "APPROVED")}
                          disabled={updating === entry.id}
                          className="glow-primary ease-strong inline-flex h-9 items-center rounded-lg bg-gradient-to-b from-sky-400 to-sky-500 px-3.5 text-sm font-medium text-white transition duration-150 hover:from-sky-400 hover:to-sky-600 active:scale-[0.97] disabled:opacity-60"
                        >
                          Approve
                        </button>
                      )}
                      {entry.status !== "REJECTED" && (
                        <button
                          type="button"
                          onClick={() => updateStatus(entry.id, "REJECTED")}
                          disabled={updating === entry.id}
                          className="ease-strong inline-flex h-9 items-center rounded-lg border border-red-200 bg-red-50 px-3 text-sm font-medium text-red-700 transition duration-150 hover:bg-red-100 active:scale-[0.97] disabled:opacity-60"
                        >
                          Reject
                        </button>
                      )}
                      {entry.status !== "PENDING" && (
                        <button
                          type="button"
                          onClick={() => updateStatus(entry.id, "PENDING")}
                          disabled={updating === entry.id}
                          className="ease-strong inline-flex h-9 items-center rounded-lg border border-slate-200 bg-white/70 px-3 text-sm text-slate-500 transition duration-150 hover:bg-white hover:text-slate-900 active:scale-[0.97] disabled:opacity-60"
                        >
                          Move to pending
                        </button>
                      )}
                    </div>
                  </div>
                </li>
              ))}
            </ul>
          </section>
        )}
      </div>
    </div>
  );
}

function StatusBadge({ status }: { status: WaitlistEntry["status"] }) {
  const map: Record<WaitlistEntry["status"], { label: string; cls: string }> = {
    PENDING: { label: "Pending", cls: "bg-amber-500/10 text-amber-600 ring-amber-500/20" },
    APPROVED: { label: "Approved", cls: "bg-emerald-500/10 text-emerald-600 ring-emerald-500/20" },
    REJECTED: { label: "Rejected", cls: "bg-slate-100 text-slate-500 ring-slate-200" },
  };
  const s = map[status];
  return (
    <span
      className={`rounded-md px-1.5 py-0.5 text-[9.5px] font-bold uppercase tracking-wide ring-1 ring-inset ${s.cls}`}
    >
      {s.label}
    </span>
  );
}

// Monogram avatar helpers — local replica of the email/page.tsx pattern
// (deliberately not imported; each surface keeps its own copy).
function senderInitials(name: string): string {
  const words = name
    .replace(/["'()[\]]/g, "")
    .split(/[\s·|,@]+/)
    .filter(Boolean);
  if (words.length === 0) return "@";
  return words
    .slice(0, 2)
    .map((w) => w[0])
    .join("")
    .toUpperCase();
}

const AVATAR_GRADIENTS = [
  "from-sky-400 to-blue-500",
  "from-teal-400 to-emerald-500",
  "from-indigo-500 to-violet-600",
  "from-amber-400 to-orange-500",
  "from-rose-400 to-pink-500",
  "from-cyan-400 to-sky-600",
  "from-slate-600 to-slate-800",
];

function avatarGradient(name: string): string {
  let hash = 0;
  for (let i = 0; i < name.length; i++) {
    hash = (hash * 31 + name.charCodeAt(i)) | 0;
  }
  return AVATAR_GRADIENTS[Math.abs(hash) % AVATAR_GRADIENTS.length];
}
