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
  source: string | null;
  attribution: string | null;
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
const TOP_N_SOURCES = 5;

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
  const [sourceFilter, setSourceFilter] = useState<string>("ALL");
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

  const sourceCounts = entries.reduce<Record<string, number>>((acc, entry) => {
    const key = entry.source ?? "Unknown";
    acc[key] = (acc[key] ?? 0) + 1;
    return acc;
  }, {});

  const topSources = Object.entries(sourceCounts)
    .sort((a, b) => b[1] - a[1])
    .slice(0, TOP_N_SOURCES)
    .map(([key]) => key);

  const otherCount = Object.entries(sourceCounts)
    .filter(([key]) => !topSources.includes(key))
    .reduce((sum, [, count]) => sum + count, 0);

  const visibleEntries =
    sourceFilter === "ALL"
      ? entries
      : sourceFilter === "Other"
        ? entries.filter((entry) => !topSources.includes(entry.source ?? "Unknown"))
        : entries.filter((entry) => (entry.source ?? "Unknown") === sourceFilter);

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

  // Deleting is the only irreversible action on this page, so it asks first and
  // names the address — the rows are visually near-identical and a misfire here
  // cannot be undone.
  const removeEntry = async (entry: WaitlistEntry) => {
    if (!window.confirm(`Delete ${entry.email} from the waitlist? This cannot be undone.`)) {
      return;
    }
    setUpdating(entry.id);
    try {
      await apiFetch(`/api/admin/waitlist/${entry.id}`, { method: "DELETE" });
      toast(`Deleted ${entry.email}.`, "success");
      await load();
    } catch (err) {
      toast(err instanceof Error ? err.message : "Could not delete the entry.", "error");
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
    <div className="min-h-dvh px-4 pb-28 pt-6 text-ink sm:px-6 md:py-10">
      <div className="mx-auto max-w-5xl">
        <header className="mb-6">
          <h1 className="text-[28px] font-semibold leading-none tracking-[-0.02em] text-ink">
            Early access waitlist
          </h1>
          <p className="mt-2 max-w-3xl text-sm text-ink-mid">
            Review new requests, move approved candidates into testing, and keep access status
            clear.
          </p>
        </header>

        <div className="mb-6 rounded-xl border border-state-warn-line bg-state-warn-bg p-4 text-sm leading-6 text-amber-800">
          <p className="font-semibold text-amber-800">
            ⚠️ Do this BEFORE clicking Approve — every time.
          </p>
          <ol className="mt-2 list-decimal space-y-1 pl-6 text-label font-normal text-state-warn-ink">
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
                onClick={() => {
                  setFilter(f.key);
                  setSourceFilter("ALL");
                }}
                className={`ease-strong rounded-xl border px-4 py-3 text-left transition duration-150 active:scale-[0.97] ${
                  isActive
                    ? "panel-elevated border-accent-muted bg-state-info-bg text-ink"
                    : "border-line bg-surface-panel/70 text-ink-mid hover:bg-surface-panel hover:text-ink"
                }`}
              >
                <div className="text-xs uppercase tracking-wide">{f.label}</div>
                <div className="mt-1 text-2xl font-semibold tabular-nums">{value}</div>
              </button>
            );
          })}
        </section>

        {topSources.length > 0 && (
          <section className="mb-6 flex flex-wrap items-center gap-3">
            <label htmlFor="source-filter" className="text-sm text-ink-mid">
              Source:
            </label>
            <select
              id="source-filter"
              value={sourceFilter}
              onChange={(e) => setSourceFilter(e.target.value)}
              className="rounded-lg border border-line bg-surface-panel/70 px-3 py-1.5 text-sm text-ink"
            >
              <option value="ALL">All ({entries.length})</option>
              {topSources.map((s) => (
                <option key={s} value={s}>
                  {s} ({sourceCounts[s]})
                </option>
              ))}
              {otherCount > 0 && <option value="Other">Other ({otherCount})</option>}
            </select>
          </section>
        )}

        {loading ? (
          <p className="text-sm text-ink-dim">Loading...</p>
        ) : visibleEntries.length === 0 ? (
          <p className="panel-elevated rounded-2xl border border-line/70 bg-surface-panel p-6 text-sm text-ink-mid">
            No requests in this state.
          </p>
        ) : (
          <section className="panel-elevated overflow-hidden rounded-2xl border border-line/70 bg-surface-panel">
            <ul className="divide-y divide-line-soft">
              {visibleEntries.map((entry) => (
                <li key={entry.id} className="row-wash p-4 md:p-5">
                  <div className="flex flex-col gap-2 md:flex-row md:items-start md:justify-between">
                    <div className="flex min-w-0 items-start gap-3">
                      <span
                        aria-hidden="true"
                        className={`avatar-ring mt-0.5 flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-gradient-to-br text-label font-semibold text-white ${avatarGradient(entry.name || entry.email)}`}
                      >
                        {senderInitials(entry.name || entry.email)}
                      </span>
                      <div className="min-w-0">
                        <div className="flex flex-wrap items-center gap-2">
                          <button
                            type="button"
                            onClick={() => copyEmail(entry)}
                            className="break-all text-base font-semibold text-ink transition duration-150 hover:text-accent-deep"
                            title="Copy email"
                          >
                            {entry.email}
                          </button>
                          <StatusBadge status={entry.status} />
                          {copiedId === entry.id && (
                            <span className="text-xs text-accent-deep">Copied</span>
                          )}
                        </div>
                        <div className="mt-1 text-xs tabular-nums text-ink-dim">
                          {entry.name ? `${entry.name} · ` : ""}
                          {formatDate(entry.createdAt)}
                          {entry.approvedAt ? ` · approved ${formatDate(entry.approvedAt)}` : ""}
                        </div>
                        {entry.useCase && (
                          <p className="mt-3 max-w-3xl text-sm leading-6 text-ink-mid">
                            {entry.useCase}
                          </p>
                        )}
                        {entry.source && (
                          <p className="mt-1 text-xs text-ink-dim">via {entry.source}</p>
                        )}
                        {entry.attribution && (
                          <p className="mt-0.5 text-xs text-ink-dim">{entry.attribution}</p>
                        )}
                      </div>
                    </div>

                    <div className="flex shrink-0 flex-wrap gap-2">
                      {entry.status !== "APPROVED" && (
                        <button
                          type="button"
                          onClick={() => updateStatus(entry.id, "APPROVED")}
                          disabled={updating === entry.id}
                          className="glow-primary ease-strong inline-flex h-9 items-center rounded-lg bg-accent-solid px-3.5 text-sm font-medium text-accent-solid-ink transition duration-150 hover:bg-accent-solid-hover active:scale-[0.97] disabled:opacity-60"
                        >
                          Approve
                        </button>
                      )}
                      {entry.status !== "REJECTED" && (
                        <button
                          type="button"
                          onClick={() => updateStatus(entry.id, "REJECTED")}
                          disabled={updating === entry.id}
                          className="ease-strong inline-flex h-9 items-center rounded-lg border border-state-danger-line bg-state-danger-bg px-3 text-sm font-medium text-state-danger-ink transition duration-150 hover:bg-state-danger-bg active:scale-[0.97] disabled:opacity-60"
                        >
                          Reject
                        </button>
                      )}
                      {entry.status !== "PENDING" && (
                        <button
                          type="button"
                          onClick={() => updateStatus(entry.id, "PENDING")}
                          disabled={updating === entry.id}
                          className="ease-strong inline-flex h-9 items-center rounded-lg border border-line bg-surface-panel/70 px-3 text-sm text-ink-mid transition duration-150 hover:bg-surface-panel hover:text-ink active:scale-[0.97] disabled:opacity-60"
                        >
                          Move to pending
                        </button>
                      )}
                      {/* Only where it is safe: an APPROVED row is a live
                          user's access while the beta gate is on, and the API
                          refuses to delete one. Hiding the button here puts the
                          rule in front of the click rather than after it. */}
                      {entry.status !== "APPROVED" && (
                        <button
                          type="button"
                          onClick={() => removeEntry(entry)}
                          disabled={updating === entry.id}
                          className="ease-strong inline-flex h-9 items-center rounded-lg border border-line bg-transparent px-3 text-sm text-ink-dim transition duration-150 hover:border-state-danger-line hover:text-state-danger-ink active:scale-[0.97] disabled:opacity-60"
                        >
                          Delete
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
    PENDING: { label: "Pending", cls: "bg-amber-500/10 text-state-warn-ink ring-amber-500/20" },
    APPROVED: { label: "Approved", cls: "bg-emerald-500/10 text-state-ok-ink ring-emerald-500/20" },
    REJECTED: { label: "Rejected", cls: "bg-surface-hover text-ink-mid ring-line" },
  };
  const s = map[status];
  return (
    <span
      className={`rounded-md px-1.5 py-0.5 text-caption font-bold uppercase tracking-wide ring-1 ring-inset ${s.cls}`}
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
  "from-accent-light to-blue-500",
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
