"use client";

import { useCallback, useEffect, useState } from "react";
import AuthGuard from "../../../components/auth-guard";
import { apiFetch } from "../../../lib/api";
import { captureClientError } from "../../../lib/sentry";

interface Skill {
  id: string;
  name: string;
  description: string;
  prompt: string;
  updatedAt: string;
}

function SkillCard({ skill, onDelete }: { skill: Skill; onDelete: (id: string) => void }) {
  const [deleting, setDeleting] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);

  const handleDelete = async () => {
    setDeleting(true);
    try {
      await apiFetch(`/api/skills/${skill.id}`, { method: "DELETE" });
      onDelete(skill.id);
    } catch (err) {
      captureClientError(err, { scope: "skills.delete" });
    } finally {
      setDeleting(false);
      setConfirmDelete(false);
    }
  };

  return (
    <div className="group rounded-xl border border-stone-800 bg-stone-900/40 p-4 transition hover:border-stone-700">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0 flex-1">
          <p className="text-sm font-semibold text-stone-100">{skill.name}</p>
          {skill.description && (
            <p className="mt-0.5 text-[12px] text-stone-500">{skill.description}</p>
          )}
          <pre className="mt-2 overflow-x-auto rounded-lg border border-stone-800 bg-black/30 p-3 font-mono text-[11px] leading-5 text-stone-400 whitespace-pre-wrap">
            {skill.prompt}
          </pre>
        </div>

        <div className="flex shrink-0 items-center gap-1">
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
                {deleting ? "Deleting…" : "Confirm"}
              </button>
            </>
          ) : (
            <button
              type="button"
              onClick={() => setConfirmDelete(true)}
              className="rounded-md p-1.5 text-stone-700 transition hover:text-red-400 md:opacity-0 md:group-hover:opacity-100"
              title="Delete skill"
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
          )}
        </div>
      </div>
    </div>
  );
}

function NewSkillForm({ onCreated }: { onCreated: (skill: Skill) => void }) {
  const [open, setOpen] = useState(false);
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [prompt, setPrompt] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const reset = () => {
    setName("");
    setDescription("");
    setPrompt("");
    setError(null);
    setOpen(false);
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!name.trim() || !prompt.trim()) {
      setError("Name and prompt are required.");
      return;
    }
    setSaving(true);
    setError(null);
    try {
      const skill = await apiFetch<Skill>("/api/skills", {
        method: "POST",
        body: JSON.stringify({
          name: name.trim(),
          description: description.trim(),
          prompt: prompt.trim(),
        }),
      });
      onCreated(skill);
      reset();
    } catch (err) {
      captureClientError(err, { scope: "skills.create" });
      setError("Could not save skill. Try again.");
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
        New skill
      </button>
    );
  }

  return (
    <form
      onSubmit={handleSubmit}
      className="rounded-xl border border-stone-700 bg-stone-900/60 p-4 space-y-3"
    >
      <p className="text-sm font-semibold text-stone-100">New skill</p>

      <div>
        <label htmlFor="skill-name" className="block text-[11px] font-medium text-stone-500 mb-1">
          Name
        </label>
        <input
          id="skill-name"
          type="text"
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="e.g. Weekly summary"
          className="w-full rounded-lg border border-stone-700 bg-stone-900 px-3 py-1.5 text-sm text-stone-200 placeholder-stone-600 focus:border-stone-500 focus:outline-none"
        />
      </div>

      <div>
        <label
          htmlFor="skill-description"
          className="block text-[11px] font-medium text-stone-500 mb-1"
        >
          Description
          <span className="ml-1 text-stone-700">(optional)</span>
        </label>
        <input
          id="skill-description"
          type="text"
          value={description}
          onChange={(e) => setDescription(e.target.value)}
          placeholder="What does this skill do?"
          className="w-full rounded-lg border border-stone-700 bg-stone-900 px-3 py-1.5 text-sm text-stone-200 placeholder-stone-600 focus:border-stone-500 focus:outline-none"
        />
      </div>

      <div>
        <label htmlFor="skill-prompt" className="block text-[11px] font-medium text-stone-500 mb-1">
          Prompt template
        </label>
        <textarea
          id="skill-prompt"
          value={prompt}
          onChange={(e) => setPrompt(e.target.value)}
          rows={4}
          placeholder={"Execute this workflow:\nStep 1: …\nStep 2: …\n\nApply to: {{target}}"}
          className="w-full rounded-lg border border-stone-700 bg-stone-900 px-3 py-2 font-mono text-sm text-stone-200 placeholder-stone-700 focus:border-stone-500 focus:outline-none resize-y"
        />
        <p className="mt-1 text-[10px] text-stone-700">
          Use {"{{variable}}"} for dynamic slots that get filled when the skill runs.
        </p>
      </div>

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
          {saving ? "Saving…" : "Save skill"}
        </button>
      </div>
    </form>
  );
}

function SkillsContent() {
  const [skills, setSkills] = useState<Skill[]>([]);
  const [loading, setLoading] = useState(true);

  const load = useCallback(() => {
    apiFetch<{ skills: Skill[] }>("/api/skills")
      .then((data) => setSkills(Array.isArray(data.skills) ? data.skills : []))
      .catch((err) => captureClientError(err, { scope: "skills.load" }))
      .finally(() => setLoading(false));
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  const handleCreated = (skill: Skill) => {
    setSkills((prev) => [skill, ...prev]);
  };

  const handleDeleted = (id: string) => {
    setSkills((prev) => prev.filter((s) => s.id !== id));
  };

  return (
    <div className="min-h-dvh bg-[#0f1115]">
      <div className="mx-auto max-w-2xl px-6 py-8">
        {/* Header */}
        <div className="mb-6">
          <h1 className="text-xl font-semibold text-stone-100">Skills</h1>
          <p className="mt-1 text-[13px] text-stone-500">
            Reusable workflows you can trigger with one command in any thread. EVE also proposes
            skills automatically when it spots repeated patterns.
          </p>
        </div>

        {/* New skill form */}
        <div className="mb-4">
          <NewSkillForm onCreated={handleCreated} />
        </div>

        {/* Skill list */}
        {loading ? (
          <div className="space-y-3">
            {Array.from({ length: 3 }).map((_, i) => (
              <div
                key={i}
                className="h-24 animate-pulse rounded-xl border border-stone-800 bg-stone-900/30"
              />
            ))}
          </div>
        ) : skills.length === 0 ? (
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
              <polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2" />
            </svg>
            <p className="text-sm text-stone-500">No skills yet.</p>
            <p className="mt-1 text-[12px] text-stone-700">
              Create one above or wait for EVE to propose one from your patterns.
            </p>
          </div>
        ) : (
          <div className="space-y-3">
            {skills.map((skill) => (
              <SkillCard key={skill.id} skill={skill} onDelete={handleDeleted} />
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

export default function SkillsPage() {
  return (
    <AuthGuard>
      <SkillsContent />
    </AuthGuard>
  );
}
