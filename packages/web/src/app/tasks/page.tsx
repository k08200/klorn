"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import AuthGuard from "../../components/auth-guard";
import ErrorAlert from "../../components/ui/error-alert";
import LoadingState from "../../components/ui/loading-state";
import { apiFetch } from "../../lib/api";
import { queryKeys } from "../../lib/query-keys";
import { captureClientError } from "../../lib/sentry";

type TaskStatus = "TODO" | "IN_PROGRESS" | "DONE";
type TaskPriority = "LOW" | "MEDIUM" | "HIGH" | "URGENT";
type Tab = "open" | "todo" | "in_progress" | "done";

interface Task {
  id: string;
  title: string;
  description: string | null;
  status: TaskStatus;
  priority: TaskPriority;
  dueDate: string | null;
}

const PRIORITY_META: Record<TaskPriority, { label: string; className: string }> = {
  URGENT: { label: "Urgent", className: "text-red-300 bg-red-500/10 border-red-500/20" },
  HIGH: { label: "High", className: "text-amber-300 bg-amber-400/10 border-amber-400/20" },
  MEDIUM: { label: "Medium", className: "text-stone-400 bg-stone-500/10 border-stone-500/20" },
  LOW: { label: "Low", className: "text-stone-600 bg-stone-800/50 border-stone-700/50" },
};

const PRIORITY_RANK: Record<TaskPriority, number> = {
  URGENT: 0,
  HIGH: 1,
  MEDIUM: 2,
  LOW: 3,
};

function isOverdue(task: Task): boolean {
  return task.status !== "DONE" && task.dueDate !== null && new Date(task.dueDate) < new Date();
}

function formatDue(dueDate: string): string {
  const d = new Date(dueDate);
  const now = new Date();
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const due = new Date(d.getFullYear(), d.getMonth(), d.getDate());
  const diff = Math.round((due.getTime() - today.getTime()) / 86400000);
  if (diff === 0) return "Today";
  if (diff === 1) return "Tomorrow";
  if (diff === -1) return "Yesterday";
  if (diff < 0) return `${-diff}d overdue`;
  if (diff < 7) return `In ${diff}d`;
  return d.toLocaleDateString("en-US", { month: "short", day: "numeric" });
}

function TaskRow({
  task,
  onToggle,
  onDelete,
}: {
  task: Task;
  onToggle: (id: string, next: TaskStatus) => void;
  onDelete: (id: string) => void;
}) {
  const priority = PRIORITY_META[task.priority];
  const overdue = isOverdue(task);
  const done = task.status === "DONE";

  const nextStatus: TaskStatus = done ? "TODO" : "DONE";

  return (
    <article className="group flex items-start gap-3 rounded-xl border border-stone-800 bg-stone-900/40 p-3 transition hover:border-stone-700">
      <button
        type="button"
        onClick={() => onToggle(task.id, nextStatus)}
        className={`mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded-md border transition ${
          done
            ? "border-emerald-400/40 bg-emerald-500/20 text-emerald-300"
            : "border-stone-700 hover:border-stone-500"
        }`}
        aria-label={done ? "Reopen task" : "Mark task done"}
      >
        {done && (
          <svg
            width="12"
            height="12"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="3"
            strokeLinecap="round"
            strokeLinejoin="round"
            aria-hidden="true"
          >
            <polyline points="20 6 9 17 4 12" />
          </svg>
        )}
      </button>

      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-2">
          <p
            className={`break-words text-sm font-medium ${
              done ? "text-stone-600 line-through" : "text-stone-100"
            }`}
          >
            {task.title}
          </p>
          <span
            className={`shrink-0 rounded border px-1.5 py-0.5 text-[10px] font-medium ${priority.className}`}
          >
            {priority.label}
          </span>
          {task.status === "IN_PROGRESS" && (
            <span className="shrink-0 rounded border border-sky-400/20 bg-sky-400/10 px-1.5 py-0.5 text-[10px] font-medium text-sky-300">
              In progress
            </span>
          )}
        </div>

        {task.description && (
          <p className="mt-1 line-clamp-2 text-[12px] text-stone-500">{task.description}</p>
        )}

        {task.dueDate && (
          <p
            className={`mt-1.5 text-[11px] ${
              overdue ? "text-red-400" : done ? "text-stone-700" : "text-stone-500"
            }`}
          >
            {formatDue(task.dueDate)}
          </p>
        )}
      </div>

      <div className="flex shrink-0 items-center gap-1">
        {!done && task.status !== "IN_PROGRESS" && (
          <button
            type="button"
            onClick={() => onToggle(task.id, "IN_PROGRESS")}
            className="rounded-md px-2 py-1 text-[11px] text-stone-600 transition hover:text-sky-300 md:opacity-0 md:group-hover:opacity-100"
            title="Mark in progress"
          >
            Start
          </button>
        )}
        <button
          type="button"
          onClick={() => onDelete(task.id)}
          className="rounded-md p-1.5 text-stone-700 transition hover:text-red-400 md:opacity-0 md:group-hover:opacity-100"
          aria-label="Delete task"
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

function NewTaskForm({ onCreated }: { onCreated: (task: Task) => void }) {
  const [open, setOpen] = useState(false);
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [priority, setPriority] = useState<TaskPriority>("MEDIUM");
  const [dueDate, setDueDate] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const reset = () => {
    setTitle("");
    setDescription("");
    setPriority("MEDIUM");
    setDueDate("");
    setError(null);
    setOpen(false);
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!title.trim()) {
      setError("Title is required.");
      return;
    }
    setSaving(true);
    setError(null);
    try {
      const result = await apiFetch<{ task?: Task } | Task>("/api/tasks", {
        method: "POST",
        body: JSON.stringify({
          title: title.trim(),
          description: description.trim() || undefined,
          priority: priority.toLowerCase(),
          dueDate: dueDate || undefined,
        }),
      });
      const task = "task" in result && result.task ? result.task : (result as Task);
      onCreated(task);
      reset();
    } catch (err) {
      captureClientError(err, { scope: "tasks.create" });
      setError("Could not save task. Try again.");
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
        New task
      </button>
    );
  }

  return (
    <form
      onSubmit={handleSubmit}
      className="rounded-xl border border-stone-700 bg-stone-900/60 p-4 space-y-3"
    >
      <p className="text-sm font-semibold text-stone-100">New task</p>

      <input
        type="text"
        value={title}
        onChange={(e) => setTitle(e.target.value)}
        placeholder="What needs to be done?"
        autoFocus
        className="w-full rounded-lg border border-stone-700 bg-stone-900 px-3 py-1.5 text-sm text-stone-200 placeholder-stone-600 focus:border-stone-500 focus:outline-none"
      />

      <textarea
        value={description}
        onChange={(e) => setDescription(e.target.value)}
        placeholder="Notes (optional)"
        rows={2}
        className="w-full rounded-lg border border-stone-700 bg-stone-900 px-3 py-1.5 text-sm text-stone-200 placeholder-stone-600 focus:border-stone-500 focus:outline-none resize-y"
      />

      <div className="flex flex-wrap items-center gap-2">
        <select
          value={priority}
          onChange={(e) => setPriority(e.target.value as TaskPriority)}
          className="rounded-lg border border-stone-700 bg-stone-900 px-2 py-1.5 text-[12px] text-stone-300 focus:border-stone-500 focus:outline-none"
        >
          <option value="LOW">Low</option>
          <option value="MEDIUM">Medium</option>
          <option value="HIGH">High</option>
          <option value="URGENT">Urgent</option>
        </select>

        <input
          type="date"
          value={dueDate}
          onChange={(e) => setDueDate(e.target.value)}
          className="rounded-lg border border-stone-700 bg-stone-900 px-2 py-1.5 text-[12px] text-stone-300 focus:border-stone-500 focus:outline-none"
        />

        {error && <span className="text-[12px] text-red-400">{error}</span>}

        <div className="ml-auto flex gap-2">
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
            {saving ? "Saving…" : "Add task"}
          </button>
        </div>
      </div>
    </form>
  );
}

function TasksContent() {
  const queryClient = useQueryClient();
  const [tab, setTab] = useState<Tab>("open");

  const {
    data: tasks = [],
    isLoading: loading,
    error: queryError,
    refetch,
  } = useQuery({
    queryKey: queryKeys.tasks.list(),
    queryFn: async () => {
      const data = await apiFetch<{ tasks: Task[] }>("/api/tasks");
      return Array.isArray(data.tasks) ? data.tasks : [];
    },
  });

  const loadError = queryError ? "Could not load tasks." : null;
  const load = () => {
    void refetch();
  };

  const handleCreated = (task: Task) => {
    // Optimistically prepend the new task; the server already created it,
    // so we just refresh the cache.
    queryClient.setQueryData<Task[]>(queryKeys.tasks.list(), (prev) =>
      prev ? [task, ...prev] : [task],
    );
  };

  const toggleMutation = useMutation({
    mutationFn: ({ id, next }: { id: string; next: TaskStatus }) =>
      apiFetch(`/api/tasks/${id}`, {
        method: "PATCH",
        body: JSON.stringify({ status: next.toLowerCase() }),
      }),
    onMutate: async ({ id, next }) => {
      await queryClient.cancelQueries({ queryKey: queryKeys.tasks.list() });
      const snapshot = queryClient.getQueryData<Task[]>(queryKeys.tasks.list());
      queryClient.setQueryData<Task[]>(queryKeys.tasks.list(), (prev) =>
        (prev ?? []).map((t) => (t.id === id ? { ...t, status: next } : t)),
      );
      return { snapshot };
    },
    onError: (err, _vars, ctx) => {
      captureClientError(err, { scope: "tasks.toggle" });
      if (ctx?.snapshot) queryClient.setQueryData(queryKeys.tasks.list(), ctx.snapshot);
    },
  });

  const deleteMutation = useMutation({
    mutationFn: (id: string) => apiFetch(`/api/tasks/${id}`, { method: "DELETE" }),
    onMutate: async (id) => {
      await queryClient.cancelQueries({ queryKey: queryKeys.tasks.list() });
      const snapshot = queryClient.getQueryData<Task[]>(queryKeys.tasks.list());
      queryClient.setQueryData<Task[]>(queryKeys.tasks.list(), (prev) =>
        (prev ?? []).filter((t) => t.id !== id),
      );
      return { snapshot };
    },
    onError: (err, _id, ctx) => {
      captureClientError(err, { scope: "tasks.delete" });
      if (ctx?.snapshot) queryClient.setQueryData(queryKeys.tasks.list(), ctx.snapshot);
    },
  });

  const handleToggle = (id: string, next: TaskStatus) => {
    toggleMutation.mutate({ id, next });
  };

  const handleDelete = (id: string) => {
    deleteMutation.mutate(id);
  };

  const filtered = tasks.filter((t) => {
    if (tab === "open") return t.status !== "DONE";
    if (tab === "todo") return t.status === "TODO";
    if (tab === "in_progress") return t.status === "IN_PROGRESS";
    return t.status === "DONE";
  });

  const sorted = [...filtered].sort((a, b) => {
    if (a.status === "DONE" && b.status !== "DONE") return 1;
    if (a.status !== "DONE" && b.status === "DONE") return -1;
    const aOverdue = isOverdue(a);
    const bOverdue = isOverdue(b);
    if (aOverdue && !bOverdue) return -1;
    if (!aOverdue && bOverdue) return 1;
    const rankDiff = PRIORITY_RANK[a.priority] - PRIORITY_RANK[b.priority];
    if (rankDiff !== 0) return rankDiff;
    if (a.dueDate && b.dueDate)
      return new Date(a.dueDate).getTime() - new Date(b.dueDate).getTime();
    if (a.dueDate) return -1;
    if (b.dueDate) return 1;
    return 0;
  });

  const counts = {
    open: tasks.filter((t) => t.status !== "DONE").length,
    todo: tasks.filter((t) => t.status === "TODO").length,
    in_progress: tasks.filter((t) => t.status === "IN_PROGRESS").length,
    done: tasks.filter((t) => t.status === "DONE").length,
  };

  const overdueCount = tasks.filter(isOverdue).length;

  const tabs: { key: Tab; label: string }[] = [
    { key: "open", label: "Open" },
    { key: "todo", label: "Todo" },
    { key: "in_progress", label: "In progress" },
    { key: "done", label: "Done" },
  ];

  return (
    <div className="min-h-dvh bg-[#0f1115]">
      <div className="mx-auto max-w-3xl px-6 py-8">
        <div className="mb-6 flex items-start justify-between gap-4">
          <div>
            <h1 className="text-xl font-semibold text-stone-100">Tasks</h1>
            <p className="mt-1 text-[13px] text-stone-500">
              Everything you and EVE have captured. Surfaced by priority, then due date.
            </p>
          </div>
          {!loading && overdueCount > 0 && (
            <div className="text-right">
              <p className="text-lg font-semibold text-red-400">{overdueCount}</p>
              <p className="text-[10px] text-stone-600">Overdue</p>
            </div>
          )}
        </div>

        <div className="mb-4">
          <NewTaskForm onCreated={handleCreated} />
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

        {loadError && !loading && (
          <div className="mb-3">
            <ErrorAlert onRetry={load}>{loadError}</ErrorAlert>
          </div>
        )}

        {loading ? (
          <LoadingState rows={5} rowHeight="h-16" label="Loading tasks" />
        ) : sorted.length === 0 ? (
          <div className="rounded-xl border border-stone-800 bg-stone-900/20 py-12 text-center">
            <svg
              aria-hidden="true"
              className="mx-auto mb-3 h-8 w-8 text-stone-700"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.5"
              strokeLinecap="round"
              strokeLinejoin="round"
            >
              <polyline points="9 11 12 14 22 4" />
              <path d="M21 12v7a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11" />
            </svg>
            <p className="text-sm text-stone-500">
              {tasks.length === 0 ? "No tasks yet." : "Nothing in this view."}
            </p>
            <p className="mt-1 text-[12px] text-stone-700">
              {tasks.length === 0
                ? "Add one above, or EVE will surface tasks from your mail."
                : "Switch tabs to see more."}
            </p>
          </div>
        ) : (
          <div className="space-y-2">
            {sorted.map((task) => (
              <TaskRow key={task.id} task={task} onToggle={handleToggle} onDelete={handleDelete} />
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

export default function TasksPage() {
  return (
    <AuthGuard>
      <TasksContent />
    </AuthGuard>
  );
}
