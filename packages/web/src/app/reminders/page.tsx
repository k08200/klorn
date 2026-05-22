"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import AuthGuard from "../../components/auth-guard";
import { apiFetch } from "../../lib/api";
import { queryKeys } from "../../lib/query-keys";
import { captureClientError } from "../../lib/sentry";

type ReminderStatus = "PENDING" | "SENT" | "DISMISSED";
type Tab = "pending" | "sent" | "dismissed";

interface Reminder {
  id: string;
  title: string;
  description: string | null;
  remindAt: string;
  status: ReminderStatus;
  createdAt: string;
}

const SNOOZE_OPTIONS: { label: string; minutes: number }[] = [
  { label: "15m", minutes: 15 },
  { label: "1h", minutes: 60 },
  { label: "Tomorrow", minutes: 60 * 24 },
];

function formatWhen(iso: string): string {
  const d = new Date(iso);
  const now = new Date();
  const diffMs = d.getTime() - now.getTime();
  const diffMin = Math.round(diffMs / 60000);
  if (Math.abs(diffMin) < 60) {
    if (diffMin === 0) return "Now";
    return diffMin > 0 ? `In ${diffMin}m` : `${-diffMin}m ago`;
  }
  const diffHr = Math.round(diffMin / 60);
  if (Math.abs(diffHr) < 24) {
    return diffHr > 0 ? `In ${diffHr}h` : `${-diffHr}h ago`;
  }
  return d.toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

function ReminderRow({
  reminder,
  onDismiss,
  onSnooze,
  onDelete,
  busy,
}: {
  reminder: Reminder;
  onDismiss: (id: string) => void;
  onSnooze: (id: string, minutes: number) => void;
  onDelete: (id: string) => void;
  busy: boolean;
}) {
  const due = new Date(reminder.remindAt) <= new Date();
  const isPending = reminder.status === "PENDING";

  return (
    <article
      className={`group flex items-start gap-3 rounded-xl border bg-stone-900/40 p-3 transition hover:border-stone-700 ${
        isPending && due ? "border-red-500/30" : "border-stone-800"
      }`}
    >
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-2">
          <p
            className={`break-words text-sm font-medium ${
              reminder.status === "DISMISSED" ? "text-stone-600 line-through" : "text-stone-100"
            }`}
          >
            {reminder.title}
          </p>
          {isPending && due && (
            <span className="shrink-0 rounded border border-red-500/20 bg-red-500/10 px-1.5 py-0.5 text-[10px] font-medium text-red-300">
              Due
            </span>
          )}
          {reminder.status === "SENT" && (
            <span className="shrink-0 rounded border border-emerald-400/20 bg-emerald-400/10 px-1.5 py-0.5 text-[10px] font-medium text-emerald-300">
              Sent
            </span>
          )}
        </div>
        {reminder.description && (
          <p className="mt-1 line-clamp-2 text-[12px] text-stone-500">{reminder.description}</p>
        )}
        <p className={`mt-1 text-[11px] ${isPending && due ? "text-red-400" : "text-stone-500"}`}>
          {formatWhen(reminder.remindAt)}
        </p>
      </div>

      <div className="flex shrink-0 items-center gap-1">
        {isPending && (
          <>
            {SNOOZE_OPTIONS.map((opt) => (
              <button
                key={opt.label}
                type="button"
                onClick={() => onSnooze(reminder.id, opt.minutes)}
                disabled={busy}
                className="rounded-md px-2 py-1 text-[11px] text-stone-600 transition hover:text-stone-200 md:opacity-0 md:group-hover:opacity-100 disabled:opacity-30"
                title={`Snooze ${opt.label}`}
              >
                {opt.label}
              </button>
            ))}
            <button
              type="button"
              onClick={() => onDismiss(reminder.id)}
              disabled={busy}
              className="rounded-md px-2 py-1 text-[11px] text-stone-500 transition hover:text-stone-200 md:opacity-0 md:group-hover:opacity-100 disabled:opacity-30"
            >
              Dismiss
            </button>
          </>
        )}
        <button
          type="button"
          onClick={() => onDelete(reminder.id)}
          disabled={busy}
          className="rounded-md p-1.5 text-stone-700 transition hover:text-red-400 md:opacity-0 md:group-hover:opacity-100 disabled:opacity-30"
          aria-label="Delete reminder"
        >
          <svg
            width="14"
            height="14"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
            aria-hidden="true"
          >
            <polyline points="3 6 5 6 21 6" />
            <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" />
          </svg>
        </button>
      </div>
    </article>
  );
}

function NewReminderForm({ onCreated }: { onCreated: (r: Reminder) => void }) {
  const [open, setOpen] = useState(false);
  const [title, setTitle] = useState("");
  const [remindAt, setRemindAt] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const reset = () => {
    setTitle("");
    setRemindAt("");
    setError(null);
    setOpen(false);
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!title.trim() || !remindAt) {
      setError("Title and time are required.");
      return;
    }
    setSaving(true);
    setError(null);
    try {
      const reminder = await apiFetch<Reminder>("/api/reminders", {
        method: "POST",
        body: JSON.stringify({
          title: title.trim(),
          remindAt: new Date(remindAt).toISOString(),
        }),
      });
      onCreated(reminder);
      reset();
    } catch (err) {
      captureClientError(err, { scope: "reminders.create" });
      setError("Could not save reminder.");
    } finally {
      setSaving(false);
    }
  };

  if (!open) {
    return (
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="flex w-full items-center justify-center gap-2 rounded-xl border border-dashed border-stone-700 py-3 text-[13px] text-stone-500 transition hover:border-stone-500 hover:text-stone-300"
      >
        <svg
          width="14"
          height="14"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
          aria-hidden="true"
        >
          <path d="M12 5v14" />
          <path d="M5 12h14" />
        </svg>
        New reminder
      </button>
    );
  }

  return (
    <form
      onSubmit={handleSubmit}
      className="rounded-xl border border-stone-700 bg-stone-900/60 p-4 space-y-3"
    >
      <input
        type="text"
        value={title}
        onChange={(e) => setTitle(e.target.value)}
        placeholder="What to remind you about"
        autoFocus
        className="w-full rounded-lg border border-stone-700 bg-stone-900 px-3 py-1.5 text-sm text-stone-200 placeholder-stone-600 focus:border-stone-500 focus:outline-none"
      />

      <input
        type="datetime-local"
        value={remindAt}
        onChange={(e) => setRemindAt(e.target.value)}
        className="w-full rounded-lg border border-stone-700 bg-stone-900 px-3 py-1.5 text-sm text-stone-300 focus:border-stone-500 focus:outline-none"
      />

      {error && <p className="text-[12px] text-red-400">{error}</p>}

      <div className="flex gap-2">
        <button
          type="button"
          onClick={reset}
          className="rounded-lg px-3 py-1.5 text-sm text-stone-500 hover:text-stone-300 transition"
        >
          Cancel
        </button>
        <button
          type="submit"
          disabled={saving}
          className="rounded-lg bg-stone-700 px-4 py-1.5 text-sm text-stone-100 hover:bg-stone-600 transition disabled:opacity-50"
        >
          {saving ? "Saving…" : "Add reminder"}
        </button>
      </div>
    </form>
  );
}

function RemindersContent() {
  const queryClient = useQueryClient();
  const [tab, setTab] = useState<Tab>("pending");
  const [busyId, setBusyId] = useState<string | null>(null);

  const { data: reminders = [], isLoading: loading } = useQuery({
    queryKey: queryKeys.reminders.list(),
    queryFn: async () => {
      try {
        const data = await apiFetch<{ reminders: Reminder[] }>("/api/reminders");
        return Array.isArray(data.reminders) ? data.reminders : [];
      } catch (err) {
        captureClientError(err, { scope: "reminders.load" });
        throw err;
      }
    },
  });

  const handleCreated = (r: Reminder) => {
    queryClient.setQueryData<Reminder[]>(queryKeys.reminders.list(), (prev) => [
      r,
      ...(prev ?? []),
    ]);
  };

  const dismissMutation = useMutation({
    mutationFn: (id: string) => apiFetch(`/api/reminders/${id}/dismiss`, { method: "PATCH" }),
    onMutate: async (id) => {
      setBusyId(id);
      await queryClient.cancelQueries({ queryKey: queryKeys.reminders.list() });
      const snapshot = queryClient.getQueryData<Reminder[]>(queryKeys.reminders.list());
      queryClient.setQueryData<Reminder[]>(queryKeys.reminders.list(), (prev) =>
        (prev ?? []).map((r) => (r.id === id ? { ...r, status: "DISMISSED" } : r)),
      );
      return { snapshot };
    },
    onError: (err, _id, ctx) => {
      captureClientError(err, { scope: "reminders.dismiss" });
      if (ctx?.snapshot) queryClient.setQueryData(queryKeys.reminders.list(), ctx.snapshot);
    },
    onSettled: () => setBusyId(null),
  });

  const snoozeMutation = useMutation({
    mutationFn: ({ id, minutes }: { id: string; minutes: number }) =>
      apiFetch(`/api/reminders/${id}/snooze`, {
        method: "PATCH",
        body: JSON.stringify({ minutes }),
      }),
    onMutate: async ({ id, minutes }) => {
      setBusyId(id);
      await queryClient.cancelQueries({ queryKey: queryKeys.reminders.list() });
      const snapshot = queryClient.getQueryData<Reminder[]>(queryKeys.reminders.list());
      const newTime = new Date(Date.now() + minutes * 60000).toISOString();
      queryClient.setQueryData<Reminder[]>(queryKeys.reminders.list(), (prev) =>
        (prev ?? []).map((r) => (r.id === id ? { ...r, remindAt: newTime, status: "PENDING" } : r)),
      );
      return { snapshot };
    },
    onError: (err, _vars, ctx) => {
      captureClientError(err, { scope: "reminders.snooze" });
      if (ctx?.snapshot) queryClient.setQueryData(queryKeys.reminders.list(), ctx.snapshot);
    },
    onSettled: () => setBusyId(null),
  });

  const handleDismiss = (id: string) => dismissMutation.mutate(id);
  const handleSnooze = (id: string, minutes: number) => snoozeMutation.mutate({ id, minutes });

  const deleteMutation = useMutation({
    mutationFn: (id: string) => apiFetch(`/api/reminders/${id}`, { method: "DELETE" }),
    onMutate: async (id) => {
      setBusyId(id);
      await queryClient.cancelQueries({ queryKey: queryKeys.reminders.list() });
      const snapshot = queryClient.getQueryData<Reminder[]>(queryKeys.reminders.list());
      queryClient.setQueryData<Reminder[]>(queryKeys.reminders.list(), (prev) =>
        (prev ?? []).filter((r) => r.id !== id),
      );
      return { snapshot };
    },
    onError: (err, _id, ctx) => {
      captureClientError(err, { scope: "reminders.delete" });
      if (ctx?.snapshot) queryClient.setQueryData(queryKeys.reminders.list(), ctx.snapshot);
    },
    onSettled: () => setBusyId(null),
  });
  const handleDelete = (id: string) => deleteMutation.mutate(id);

  const filtered = reminders.filter((r) => {
    if (tab === "pending") return r.status === "PENDING";
    if (tab === "sent") return r.status === "SENT";
    return r.status === "DISMISSED";
  });

  const sorted = [...filtered].sort((a, b) => {
    if (tab === "pending") {
      return new Date(a.remindAt).getTime() - new Date(b.remindAt).getTime();
    }
    return new Date(b.remindAt).getTime() - new Date(a.remindAt).getTime();
  });

  const counts = {
    pending: reminders.filter((r) => r.status === "PENDING").length,
    sent: reminders.filter((r) => r.status === "SENT").length,
    dismissed: reminders.filter((r) => r.status === "DISMISSED").length,
  };

  const overdueCount = reminders.filter(
    (r) => r.status === "PENDING" && new Date(r.remindAt) <= new Date(),
  ).length;

  const tabs: { key: Tab; label: string }[] = [
    { key: "pending", label: "Pending" },
    { key: "sent", label: "Sent" },
    { key: "dismissed", label: "Dismissed" },
  ];

  return (
    <div className="min-h-dvh bg-[#0f1115]">
      <div className="mx-auto max-w-2xl px-6 py-8">
        <div className="mb-6 flex items-start justify-between gap-4">
          <div>
            <h1 className="text-xl font-semibold text-stone-100">Reminders</h1>
            <p className="mt-1 text-[13px] text-stone-500">
              Time-based nudges. EVE also creates reminders from your mail and chats.
            </p>
          </div>
          {!loading && overdueCount > 0 && (
            <div className="text-right">
              <p className="text-lg font-semibold text-red-400">{overdueCount}</p>
              <p className="text-[10px] text-stone-600">Due</p>
            </div>
          )}
        </div>

        <div className="mb-4">
          <NewReminderForm onCreated={handleCreated} />
        </div>

        <div className="mb-4 flex flex-wrap gap-1 border-b border-stone-800 pb-2">
          {tabs.map((t) => (
            <button
              key={t.key}
              type="button"
              onClick={() => setTab(t.key)}
              className={`rounded-md px-2.5 py-1 text-[12px] font-medium transition ${
                tab === t.key
                  ? "bg-stone-800 text-stone-100"
                  : "text-stone-600 hover:text-stone-400"
              }`}
            >
              {t.label}
              <span className="ml-1.5 text-stone-700">{counts[t.key]}</span>
            </button>
          ))}
        </div>

        {loading ? (
          <div className="space-y-2">
            {Array.from({ length: 4 }).map((_, i) => (
              <div
                key={i}
                className="h-16 animate-pulse rounded-xl border border-stone-800 bg-stone-900/30"
              />
            ))}
          </div>
        ) : sorted.length === 0 ? (
          <div className="rounded-xl border border-stone-800 bg-stone-900/20 py-12 text-center">
            <p className="text-sm text-stone-500">
              {reminders.length === 0 ? "No reminders yet." : "Nothing in this view."}
            </p>
            <p className="mt-1 text-[12px] text-stone-700">
              {reminders.length === 0
                ? "Add one above or ask EVE in a chat."
                : "Switch tabs to see more."}
            </p>
          </div>
        ) : (
          <div className="space-y-2">
            {sorted.map((r) => (
              <ReminderRow
                key={r.id}
                reminder={r}
                onDismiss={handleDismiss}
                onSnooze={handleSnooze}
                onDelete={handleDelete}
                busy={busyId === r.id}
              />
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

export default function RemindersPage() {
  return (
    <AuthGuard>
      <RemindersContent />
    </AuthGuard>
  );
}
