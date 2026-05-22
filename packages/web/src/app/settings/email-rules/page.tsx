"use client";

import { useCallback, useEffect, useState } from "react";
import AuthGuard from "../../../components/auth-guard";
import { apiFetch } from "../../../lib/api";
import { captureClientError } from "../../../lib/sentry";

type ActionType = "AUTO_REPLY" | "DRAFT_REPLY" | "LABEL" | "ARCHIVE" | "NOTIFY";

interface RuleConditions {
  from?: string[];
  subjectContains?: string[];
  category?: string[];
}

interface EmailRule {
  id: string;
  name: string;
  description: string | null;
  isActive: boolean;
  conditions: RuleConditions;
  actionType: ActionType;
  actionValue: string;
  triggerCount: number;
  lastTriggeredAt: string | null;
  createdAt: string;
  updatedAt: string;
}

const ACTION_META: Record<ActionType, { label: string; valueHint: string; className: string }> = {
  AUTO_REPLY: {
    label: "Auto-reply",
    valueHint: "Reply template",
    className: "border-amber-400/30 bg-amber-400/10 text-amber-300",
  },
  DRAFT_REPLY: {
    label: "Draft reply",
    valueHint: "Draft template",
    className: "border-sky-400/30 bg-sky-400/10 text-sky-300",
  },
  LABEL: {
    label: "Label",
    valueHint: "Label name",
    className: "border-emerald-400/30 bg-emerald-400/10 text-emerald-300",
  },
  ARCHIVE: {
    label: "Archive",
    valueHint: "(leave blank)",
    className: "border-stone-700 bg-stone-800/40 text-stone-300",
  },
  NOTIFY: {
    label: "Notify",
    valueHint: "Notification text",
    className: "border-rose-400/30 bg-rose-400/10 text-rose-300",
  },
};

function ChipList({ label, values }: { label: string; values: string[] | undefined }) {
  if (!values || values.length === 0) return null;
  return (
    <div className="flex flex-wrap items-center gap-1.5">
      <span className="text-[10px] uppercase tracking-wider text-stone-600">{label}</span>
      {values.map((v) => (
        <span
          key={v}
          className="rounded border border-stone-800 bg-black/20 px-1.5 py-0.5 font-mono text-[10px] text-stone-400"
        >
          {v}
        </span>
      ))}
    </div>
  );
}

function RuleCard({
  rule,
  onToggle,
  onDelete,
  busy,
}: {
  rule: EmailRule;
  onToggle: (id: string, next: boolean) => void;
  onDelete: (id: string) => void;
  busy: boolean;
}) {
  const action = ACTION_META[rule.actionType];
  return (
    <article
      className={`group rounded-xl border bg-stone-900/40 p-4 transition hover:border-stone-700 ${
        rule.isActive ? "border-stone-800" : "border-stone-800/50 opacity-60"
      }`}
    >
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <p className="break-words text-sm font-semibold text-stone-100">{rule.name}</p>
            <span
              className={`rounded border px-1.5 py-0.5 text-[10px] font-medium ${action.className}`}
            >
              {action.label}
            </span>
            {!rule.isActive && (
              <span className="rounded border border-stone-700 bg-stone-800/40 px-1.5 py-0.5 text-[10px] text-stone-500">
                Disabled
              </span>
            )}
          </div>
          {rule.description && (
            <p className="mt-1 text-[12px] text-stone-500">{rule.description}</p>
          )}

          <div className="mt-3 space-y-1.5">
            <ChipList label="From" values={rule.conditions.from} />
            <ChipList label="Subject" values={rule.conditions.subjectContains} />
            <ChipList label="Category" values={rule.conditions.category} />
          </div>

          {rule.actionType !== "ARCHIVE" && rule.actionValue && (
            <p className="mt-3 whitespace-pre-wrap rounded-md border border-stone-800 bg-black/20 p-2 font-mono text-[11px] text-stone-400">
              {rule.actionValue}
            </p>
          )}

          <p className="mt-2 text-[10px] text-stone-700">
            Triggered {rule.triggerCount}× ·{" "}
            {rule.lastTriggeredAt
              ? `last ${new Date(rule.lastTriggeredAt).toLocaleDateString()}`
              : "never"}
          </p>
        </div>

        <div className="flex shrink-0 flex-col items-end gap-1">
          <button
            type="button"
            onClick={() => onToggle(rule.id, !rule.isActive)}
            disabled={busy}
            className={`rounded-md border px-2 py-1 text-[11px] transition disabled:opacity-50 ${
              rule.isActive
                ? "border-stone-700 text-stone-400 hover:border-stone-500 hover:text-stone-200"
                : "border-emerald-400/30 text-emerald-300 hover:bg-emerald-400/10"
            }`}
          >
            {rule.isActive ? "Disable" : "Enable"}
          </button>
          <button
            type="button"
            onClick={() => onDelete(rule.id)}
            disabled={busy}
            className="rounded-md p-1.5 text-stone-700 transition hover:text-red-400 md:opacity-0 md:group-hover:opacity-100 disabled:opacity-30"
            aria-label="Delete rule"
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
      </div>
    </article>
  );
}

const KNOWN_CATEGORIES = [
  "billing",
  "meeting",
  "engineering",
  "conversation",
  "automated",
  "newsletter",
  "personal",
  "business",
  "other",
];

function NewRuleForm({ onCreated }: { onCreated: (r: EmailRule) => void }) {
  const [open, setOpen] = useState(false);
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [from, setFrom] = useState("");
  const [subject, setSubject] = useState("");
  const [categories, setCategories] = useState<string[]>([]);
  const [actionType, setActionType] = useState<ActionType>("LABEL");
  const [actionValue, setActionValue] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const reset = () => {
    setName("");
    setDescription("");
    setFrom("");
    setSubject("");
    setCategories([]);
    setActionType("LABEL");
    setActionValue("");
    setError(null);
    setOpen(false);
  };

  const parseCsv = (value: string): string[] =>
    value
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);

  const toggleCategory = (cat: string) => {
    setCategories((prev) => (prev.includes(cat) ? prev.filter((c) => c !== cat) : [...prev, cat]));
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    const fromList = parseCsv(from);
    const subjectList = parseCsv(subject);
    if (
      !name.trim() ||
      (fromList.length === 0 && subjectList.length === 0 && categories.length === 0)
    ) {
      setError("Name and at least one condition (from, subject, or category) are required.");
      return;
    }
    if (actionType !== "ARCHIVE" && !actionValue.trim()) {
      setError(`${ACTION_META[actionType].label} requires a value.`);
      return;
    }

    const conditions: RuleConditions = {};
    if (fromList.length > 0) conditions.from = fromList;
    if (subjectList.length > 0) conditions.subjectContains = subjectList;
    if (categories.length > 0) conditions.category = categories;

    setSaving(true);
    setError(null);
    try {
      const res = await apiFetch<{ rule: EmailRule }>("/api/email/rules", {
        method: "POST",
        body: JSON.stringify({
          name: name.trim(),
          description: description.trim() || undefined,
          conditions,
          actionType,
          actionValue: actionValue.trim() || actionType,
        }),
      });
      onCreated(res.rule);
      reset();
    } catch (err) {
      captureClientError(err, { scope: "email-rules.create" });
      setError("Could not save rule.");
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
        New rule
      </button>
    );
  }

  return (
    <form
      onSubmit={handleSubmit}
      className="rounded-xl border border-stone-700 bg-stone-900/60 p-4 space-y-3"
    >
      <p className="text-sm font-semibold text-stone-100">New rule</p>

      <div>
        <label htmlFor="rule-name" className="mb-1 block text-[11px] text-stone-500">
          Name
        </label>
        <input
          id="rule-name"
          type="text"
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="e.g. Auto-archive newsletters"
          className="w-full rounded-lg border border-stone-700 bg-stone-900 px-3 py-1.5 text-sm text-stone-200 placeholder-stone-600 focus:border-stone-500 focus:outline-none"
        />
      </div>

      <div>
        <label htmlFor="rule-description" className="mb-1 block text-[11px] text-stone-500">
          Description <span className="text-stone-700">(optional)</span>
        </label>
        <input
          id="rule-description"
          type="text"
          value={description}
          onChange={(e) => setDescription(e.target.value)}
          className="w-full rounded-lg border border-stone-700 bg-stone-900 px-3 py-1.5 text-sm text-stone-200 placeholder-stone-600 focus:border-stone-500 focus:outline-none"
        />
      </div>

      <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
        <div>
          <label htmlFor="rule-from" className="mb-1 block text-[11px] text-stone-500">
            From contains <span className="text-stone-700">(comma-separated)</span>
          </label>
          <input
            id="rule-from"
            type="text"
            value={from}
            onChange={(e) => setFrom(e.target.value)}
            placeholder="newsletter@, @mailchimp"
            className="w-full rounded-lg border border-stone-700 bg-stone-900 px-3 py-1.5 text-sm text-stone-200 placeholder-stone-600 focus:border-stone-500 focus:outline-none"
          />
        </div>

        <div>
          <label htmlFor="rule-subject" className="mb-1 block text-[11px] text-stone-500">
            Subject contains <span className="text-stone-700">(comma-separated)</span>
          </label>
          <input
            id="rule-subject"
            type="text"
            value={subject}
            onChange={(e) => setSubject(e.target.value)}
            placeholder="weekly digest, newsletter"
            className="w-full rounded-lg border border-stone-700 bg-stone-900 px-3 py-1.5 text-sm text-stone-200 placeholder-stone-600 focus:border-stone-500 focus:outline-none"
          />
        </div>
      </div>

      <div>
        <p className="mb-1 text-[11px] text-stone-500">
          Category matches <span className="text-stone-700">(click to toggle)</span>
        </p>
        <div className="flex flex-wrap gap-1.5">
          {KNOWN_CATEGORIES.map((cat) => {
            const selected = categories.includes(cat);
            return (
              <button
                key={cat}
                type="button"
                onClick={() => toggleCategory(cat)}
                className={`rounded border px-2 py-0.5 text-[11px] transition ${
                  selected
                    ? "border-amber-400/40 bg-amber-400/15 text-amber-200"
                    : "border-stone-700 bg-stone-800/40 text-stone-400 hover:border-stone-500"
                }`}
              >
                {cat}
              </button>
            );
          })}
        </div>
      </div>

      <div className="grid grid-cols-1 gap-3 md:grid-cols-[200px_1fr]">
        <div>
          <label htmlFor="rule-action" className="mb-1 block text-[11px] text-stone-500">
            Action
          </label>
          <select
            id="rule-action"
            value={actionType}
            onChange={(e) => setActionType(e.target.value as ActionType)}
            className="w-full rounded-lg border border-stone-700 bg-stone-900 px-3 py-1.5 text-sm text-stone-200 focus:border-stone-500 focus:outline-none"
          >
            <option value="LABEL">Label</option>
            <option value="ARCHIVE">Archive</option>
            <option value="AUTO_REPLY">Auto-reply</option>
            <option value="DRAFT_REPLY">Draft reply</option>
            <option value="NOTIFY">Notify</option>
          </select>
        </div>

        <div>
          <label htmlFor="rule-value" className="mb-1 block text-[11px] text-stone-500">
            {ACTION_META[actionType].valueHint}
          </label>
          {actionType === "AUTO_REPLY" || actionType === "DRAFT_REPLY" ? (
            <textarea
              id="rule-value"
              value={actionValue}
              onChange={(e) => setActionValue(e.target.value)}
              rows={3}
              disabled={actionType === ("ARCHIVE" as ActionType)}
              className="w-full rounded-lg border border-stone-700 bg-stone-900 px-3 py-1.5 font-mono text-sm text-stone-200 placeholder-stone-600 focus:border-stone-500 focus:outline-none resize-y disabled:opacity-50"
            />
          ) : (
            <input
              id="rule-value"
              type="text"
              value={actionValue}
              onChange={(e) => setActionValue(e.target.value)}
              disabled={actionType === "ARCHIVE"}
              placeholder={actionType === "LABEL" ? "Newsletters" : ""}
              className="w-full rounded-lg border border-stone-700 bg-stone-900 px-3 py-1.5 text-sm text-stone-200 placeholder-stone-600 focus:border-stone-500 focus:outline-none disabled:opacity-50"
            />
          )}
        </div>
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
          {saving ? "Saving…" : "Save rule"}
        </button>
      </div>
    </form>
  );
}

function EmailRulesContent() {
  const [rules, setRules] = useState<EmailRule[]>([]);
  const [loading, setLoading] = useState(true);
  const [busyId, setBusyId] = useState<string | null>(null);

  const load = useCallback(() => {
    apiFetch<{ rules: EmailRule[] }>("/api/email/rules")
      .then((data) => setRules(Array.isArray(data.rules) ? data.rules : []))
      .catch((err) => captureClientError(err, { scope: "email-rules.load" }))
      .finally(() => setLoading(false));
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  const handleCreated = (rule: EmailRule) => {
    setRules((prev) => [rule, ...prev]);
  };

  const handleToggle = async (id: string, next: boolean) => {
    const snapshot = rules;
    setBusyId(id);
    setRules((prev) => prev.map((r) => (r.id === id ? { ...r, isActive: next } : r)));
    try {
      await apiFetch(`/api/email/rules/${id}`, {
        method: "PATCH",
        body: JSON.stringify({ isActive: next }),
      });
    } catch (err) {
      captureClientError(err, { scope: "email-rules.toggle" });
      setRules(snapshot);
    } finally {
      setBusyId(null);
    }
  };

  const handleDelete = async (id: string) => {
    const snapshot = rules;
    setBusyId(id);
    setRules((prev) => prev.filter((r) => r.id !== id));
    try {
      await apiFetch(`/api/email/rules/${id}`, { method: "DELETE" });
    } catch (err) {
      captureClientError(err, { scope: "email-rules.delete" });
      setRules(snapshot);
    } finally {
      setBusyId(null);
    }
  };

  const activeCount = rules.filter((r) => r.isActive).length;

  return (
    <div className="min-h-dvh bg-[#0f1115]">
      <div className="mx-auto max-w-3xl px-6 py-8">
        <div className="mb-6">
          <h1 className="text-xl font-semibold text-stone-100">Email rules</h1>
          <p className="mt-1 text-[13px] text-stone-500">
            Apply labels, auto-reply, archive, or notify based on sender or subject.{" "}
            {activeCount > 0 && (
              <span className="text-stone-400">
                {activeCount} active rule{activeCount === 1 ? "" : "s"}.
              </span>
            )}
          </p>
        </div>

        <div className="mb-4">
          <NewRuleForm onCreated={handleCreated} />
        </div>

        {loading ? (
          <div className="space-y-3">
            {Array.from({ length: 3 }).map((_, i) => (
              <div
                key={i}
                className="h-32 animate-pulse rounded-xl border border-stone-800 bg-stone-900/30"
              />
            ))}
          </div>
        ) : rules.length === 0 ? (
          <div className="rounded-xl border border-stone-800 bg-stone-900/20 py-12 text-center">
            <p className="text-sm text-stone-500">No email rules yet.</p>
            <p className="mt-1 text-[12px] text-stone-700">
              Create one above to start filtering incoming mail.
            </p>
          </div>
        ) : (
          <div className="space-y-3">
            {rules.map((rule) => (
              <RuleCard
                key={rule.id}
                rule={rule}
                onToggle={handleToggle}
                onDelete={handleDelete}
                busy={busyId === rule.id}
              />
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

export default function EmailRulesPage() {
  return (
    <AuthGuard>
      <EmailRulesContent />
    </AuthGuard>
  );
}
