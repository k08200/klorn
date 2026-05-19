"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import AuthGuard from "../../components/auth-guard";
import ErrorAlert from "../../components/ui/error-alert";
import LoadingState from "../../components/ui/loading-state";
import { apiFetch } from "../../lib/api";
import { queryKeys } from "../../lib/query-keys";
import { captureClientError } from "../../lib/sentry";

interface Note {
  id: string;
  title: string;
  content: string;
  category: string;
  createdAt: string;
  updatedAt: string;
}

function formatDate(iso: string): string {
  const d = new Date(iso);
  return d.toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" });
}

function NoteCard({
  note,
  onDelete,
  deleting,
}: {
  note: Note;
  onDelete: (id: string) => void;
  deleting: boolean;
}) {
  const [confirmDelete, setConfirmDelete] = useState(false);

  const handleDelete = () => {
    onDelete(note.id);
    setConfirmDelete(false);
  };

  return (
    <article className="group rounded-xl border border-stone-800 bg-stone-900/40 p-4 transition hover:border-stone-700">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            {note.category && note.category !== "general" && (
              <span className="rounded bg-stone-800 px-1.5 py-0.5 text-[10px] font-medium text-stone-400">
                {note.category}
              </span>
            )}
            <span className="text-[11px] text-stone-600">{formatDate(note.updatedAt)}</span>
          </div>
          <p className="mt-1.5 text-sm font-semibold text-stone-100">{note.title}</p>
          <p className="mt-1 line-clamp-3 whitespace-pre-line text-[12px] leading-5 text-stone-500">
            {note.content}
          </p>
        </div>

        <div className="flex shrink-0 items-center gap-1">
          {confirmDelete ? (
            <>
              <button
                type="button"
                onClick={() => setConfirmDelete(false)}
                className="rounded px-2 py-1 text-[11px] text-stone-500 hover:text-stone-300 transition"
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={handleDelete}
                disabled={deleting}
                className="rounded bg-red-600/20 px-2 py-1 text-[11px] text-red-400 hover:bg-red-600/30 transition disabled:opacity-50"
              >
                {deleting ? "…" : "Delete"}
              </button>
            </>
          ) : (
            <button
              type="button"
              onClick={() => setConfirmDelete(true)}
              className="rounded p-1.5 text-stone-700 transition hover:text-red-400 md:opacity-0 md:group-hover:opacity-100"
              title="Delete note"
            >
              <svg
                width="13"
                height="13"
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
          )}
        </div>
      </div>
    </article>
  );
}

function NotesContent() {
  const queryClient = useQueryClient();
  const [search, setSearch] = useState("");
  const [category, setCategory] = useState("all");

  // Debounce the search input so we don't fire a request per keystroke.
  const [debouncedSearch, setDebouncedSearch] = useState(search);
  useEffect(() => {
    const timer = setTimeout(() => setDebouncedSearch(search), search ? 300 : 0);
    return () => clearTimeout(timer);
  }, [search]);

  const filters = { search: debouncedSearch, category };

  const {
    data: notes = [],
    isLoading: loading,
    error: queryError,
    refetch,
  } = useQuery({
    queryKey: queryKeys.notes.list(filters),
    queryFn: async () => {
      const params = new URLSearchParams();
      if (filters.search) params.set("search", filters.search);
      if (filters.category !== "all") params.set("category", filters.category);
      const qs = params.toString() ? `?${params.toString()}` : "";
      const data = await apiFetch<{ notes: Note[] }>(`/api/notes${qs}`);
      return Array.isArray(data.notes) ? data.notes : [];
    },
  });

  const loadError = queryError ? "Could not load notes." : null;
  const load = () => {
    void refetch();
  };

  const deleteMutation = useMutation({
    mutationFn: (id: string) => apiFetch(`/api/notes/${id}`, { method: "DELETE" }),
    onSuccess: () => {
      // Invalidate every cached filter combo so the deleted note can't
      // resurface when the user changes the search/category.
      queryClient.invalidateQueries({ queryKey: queryKeys.notes.all });
    },
    onError: (err) => captureClientError(err, { scope: "notes.delete" }),
  });

  const handleDeleted = (id: string) => {
    // Optimistic local removal for the currently-rendered list.
    queryClient.setQueryData<Note[]>(queryKeys.notes.list(filters), (prev) =>
      (prev ?? []).filter((n) => n.id !== id),
    );
    deleteMutation.mutate(id);
  };

  const categories = ["all", ...Array.from(new Set(notes.map((n) => n.category).filter(Boolean)))];

  return (
    <div className="flex h-dvh flex-col bg-[#0f1115]">
      {/* Header */}
      <div className="border-b border-stone-800 px-6 py-4">
        <div className="flex items-center justify-between gap-4">
          <div>
            <h1 className="text-lg font-semibold text-stone-100">Notes</h1>
            <p className="mt-0.5 text-[12px] text-stone-500">
              Captured by EVE from your conversations and inbox.
            </p>
          </div>

          <div className="relative">
            <svg
              aria-hidden="true"
              className="absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-stone-500"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
            >
              <circle cx="11" cy="11" r="8" />
              <line x1="21" y1="21" x2="16.65" y2="16.65" />
            </svg>
            <input
              type="text"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Search notes…"
              className="w-48 rounded-lg border border-stone-700 bg-stone-900 py-1.5 pl-8 pr-3 text-sm text-stone-300 placeholder-stone-600 focus:border-stone-500 focus:outline-none"
            />
          </div>
        </div>

        {/* Category filter */}
        {categories.length > 1 && (
          <div className="mt-3 flex gap-1">
            {categories.map((cat) => (
              <button
                key={cat}
                type="button"
                onClick={() => setCategory(cat)}
                className={`rounded-md px-2.5 py-1 text-[11px] font-medium transition ${
                  category === cat
                    ? "bg-stone-800 text-stone-100"
                    : "text-stone-600 hover:text-stone-400"
                }`}
              >
                {cat === "all" ? "All" : cat}
              </button>
            ))}
          </div>
        )}
      </div>

      {/* Body */}
      <div className="flex-1 overflow-y-auto px-6 py-4">
        {loadError && !loading && (
          <div className="mb-3">
            <ErrorAlert onRetry={load}>{loadError}</ErrorAlert>
          </div>
        )}

        {loading ? (
          <LoadingState rows={5} rowHeight="h-20" label="Loading notes" />
        ) : notes.length === 0 ? (
          <div className="flex flex-col items-center justify-center py-24 text-center">
            <svg
              aria-hidden="true"
              className="mb-4 h-10 w-10 text-stone-700"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.5"
              strokeLinecap="round"
              strokeLinejoin="round"
            >
              <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
              <polyline points="14 2 14 8 20 8" />
              <line x1="16" y1="13" x2="8" y2="13" />
              <line x1="16" y1="17" x2="8" y2="17" />
              <polyline points="10 9 9 9 8 9" />
            </svg>
            <p className="text-sm text-stone-500">
              {search ? "No notes match your search." : "No notes yet."}
            </p>
            <p className="mt-1 text-[12px] text-stone-700">
              EVE captures notes from your conversations — ask it to take a note in any thread.
            </p>
          </div>
        ) : (
          <div className="space-y-3">
            {notes.map((note) => (
              <NoteCard
                key={note.id}
                note={note}
                onDelete={handleDeleted}
                deleting={deleteMutation.isPending}
              />
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

export default function NotesPage() {
  return (
    <AuthGuard>
      <NotesContent />
    </AuthGuard>
  );
}
