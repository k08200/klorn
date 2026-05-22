"use client";

import Link from "next/link";
import { useParams, useRouter } from "next/navigation";
import { useCallback, useEffect, useState } from "react";
import AuthGuard from "../../../components/auth-guard";
import { apiFetch } from "../../../lib/api";
import { captureClientError } from "../../../lib/sentry";

interface Note {
  id: string;
  title: string;
  content: string;
  category: string;
  createdAt: string;
  updatedAt: string;
}

function NoteDetail({ id }: { id: string }) {
  const router = useRouter();
  const [note, setNote] = useState<Note | null>(null);
  const [title, setTitle] = useState("");
  const [content, setContent] = useState("");
  const [category, setCategory] = useState("");
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [dirty, setDirty] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [savedAt, setSavedAt] = useState<number | null>(null);

  const load = useCallback(() => {
    apiFetch<Note>(`/api/notes/${id}`)
      .then((n) => {
        setNote(n);
        setTitle(n.title);
        setContent(n.content);
        setCategory(n.category);
      })
      .catch((err) => {
        captureClientError(err, { scope: "note-detail.load" });
        setError("Note not found.");
      })
      .finally(() => setLoading(false));
  }, [id]);

  useEffect(() => {
    load();
  }, [load]);

  const handleSave = async () => {
    if (!title.trim()) {
      setError("Title is required.");
      return;
    }
    setSaving(true);
    setError(null);
    try {
      const updated = await apiFetch<Note>(`/api/notes/${id}`, {
        method: "PATCH",
        body: JSON.stringify({
          title: title.trim(),
          content,
          category: category.trim() || "general",
        }),
      });
      setNote(updated);
      setDirty(false);
      setSavedAt(Date.now());
    } catch (err) {
      captureClientError(err, { scope: "note-detail.save" });
      setError("Could not save note.");
    } finally {
      setSaving(false);
    }
  };

  const handleDelete = async () => {
    setDeleting(true);
    try {
      await apiFetch(`/api/notes/${id}`, { method: "DELETE" });
      router.push("/notes");
    } catch (err) {
      captureClientError(err, { scope: "note-detail.delete" });
      setDeleting(false);
      setConfirmDelete(false);
    }
  };

  const markDirty = () => {
    setDirty(true);
    setSavedAt(null);
  };

  if (loading) {
    return (
      <div className="mx-auto max-w-3xl px-6 py-8">
        <div className="h-12 animate-pulse rounded-xl border border-stone-800 bg-stone-900/30" />
        <div className="mt-4 h-72 animate-pulse rounded-xl border border-stone-800 bg-stone-900/30" />
      </div>
    );
  }

  if (!note) {
    return (
      <div className="mx-auto max-w-3xl px-6 py-12 text-center">
        <p className="text-sm text-stone-400">{error ?? "Note not found."}</p>
        <Link
          href="/notes"
          className="mt-3 inline-block text-[12px] text-amber-300 hover:underline"
        >
          ← Back to notes
        </Link>
      </div>
    );
  }

  const savedAgo = savedAt !== null ? Math.max(0, Math.round((Date.now() - savedAt) / 1000)) : null;

  return (
    <div className="min-h-dvh bg-[#0f1115]">
      <div className="mx-auto max-w-3xl px-6 py-6">
        <Link
          href="/notes"
          className="mb-4 inline-flex items-center gap-1 text-[12px] text-stone-500 hover:text-stone-300"
        >
          <svg
            width="12"
            height="12"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
            aria-hidden="true"
          >
            <polyline points="15 18 9 12 15 6" />
          </svg>
          Notes
        </Link>

        <div className="rounded-2xl border border-stone-800 bg-stone-900/40 p-5">
          <input
            type="text"
            value={title}
            onChange={(e) => {
              setTitle(e.target.value);
              markDirty();
            }}
            placeholder="Untitled note"
            className="w-full bg-transparent text-lg font-semibold text-stone-100 placeholder-stone-700 focus:outline-none"
          />

          <div className="mt-2 flex flex-wrap items-center gap-2 border-b border-stone-800 pb-3">
            <label
              htmlFor="note-category"
              className="text-[10px] uppercase tracking-wider text-stone-600"
            >
              Category
            </label>
            <input
              id="note-category"
              type="text"
              value={category}
              onChange={(e) => {
                setCategory(e.target.value);
                markDirty();
              }}
              placeholder="general"
              className="rounded-md border border-stone-800 bg-black/20 px-2 py-0.5 text-[11px] text-stone-300 placeholder-stone-700 focus:border-stone-600 focus:outline-none"
            />
            <span className="ml-auto text-[11px] text-stone-600">
              Updated{" "}
              {new Date(note.updatedAt).toLocaleString(undefined, {
                month: "short",
                day: "numeric",
                hour: "numeric",
                minute: "2-digit",
              })}
            </span>
          </div>

          <textarea
            value={content}
            onChange={(e) => {
              setContent(e.target.value);
              markDirty();
            }}
            placeholder="Write your note…"
            rows={18}
            className="mt-3 w-full resize-y bg-transparent font-mono text-[13px] leading-6 text-stone-200 placeholder-stone-700 focus:outline-none"
          />
        </div>

        {error && (
          <p className="mt-3 rounded-md border border-red-500/30 bg-red-500/10 px-3 py-2 text-[12px] text-red-300">
            {error}
          </p>
        )}

        <div className="mt-4 flex flex-wrap items-center gap-3">
          <button
            type="button"
            onClick={handleSave}
            disabled={saving || !dirty}
            className="rounded-lg bg-stone-700 px-4 py-1.5 text-sm text-stone-100 hover:bg-stone-600 transition disabled:opacity-40"
          >
            {saving ? "Saving…" : dirty ? "Save changes" : "Saved"}
          </button>
          {savedAgo !== null && !dirty && (
            <span className="text-[11px] text-stone-600">
              Saved {savedAgo < 60 ? "just now" : `${Math.round(savedAgo / 60)}m ago`}
            </span>
          )}

          <div className="ml-auto flex items-center gap-2">
            {confirmDelete ? (
              <>
                <button
                  type="button"
                  onClick={() => setConfirmDelete(false)}
                  className="rounded-md px-2 py-1 text-[11px] text-stone-500 hover:text-stone-300 transition"
                >
                  Cancel
                </button>
                <button
                  type="button"
                  onClick={handleDelete}
                  disabled={deleting}
                  className="rounded-md bg-red-600/20 px-2 py-1 text-[11px] text-red-400 hover:bg-red-600/30 transition disabled:opacity-50"
                >
                  {deleting ? "Deleting…" : "Confirm delete"}
                </button>
              </>
            ) : (
              <button
                type="button"
                onClick={() => setConfirmDelete(true)}
                className="rounded-md px-2 py-1 text-[11px] text-stone-500 transition hover:text-red-400"
              >
                Delete
              </button>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

export default function NoteDetailPage() {
  const params = useParams<{ id: string }>();
  const id = params?.id;
  if (!id) return null;
  return (
    <AuthGuard>
      <NoteDetail id={id} />
    </AuthGuard>
  );
}
