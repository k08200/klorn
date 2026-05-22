"use client";

import { useCallback, useEffect, useState } from "react";
import AuthGuard from "../../../components/auth-guard";
import { apiFetch } from "../../../lib/api";
import { captureClientError } from "../../../lib/sentry";

type Role = "OWNER" | "ADMIN" | "MEMBER";

interface Workspace {
  id: string;
  name: string;
  slug: string;
  role: Role;
  memberCount: number;
  plan: string | null;
}

interface Member {
  id: string;
  userId: string;
  name: string | null;
  email: string;
  role: Role;
  joinedAt: string;
}

const ROLE_META: Record<Role, { label: string; className: string }> = {
  OWNER: {
    label: "Owner",
    className: "border-amber-400/30 bg-amber-400/10 text-amber-300",
  },
  ADMIN: {
    label: "Admin",
    className: "border-sky-400/30 bg-sky-400/10 text-sky-300",
  },
  MEMBER: {
    label: "Member",
    className: "border-stone-700 bg-stone-800/40 text-stone-400",
  },
};

function MemberRow({
  member,
  canRemove,
  busy,
  onRemove,
}: {
  member: Member;
  canRemove: boolean;
  busy: boolean;
  onRemove: (id: string) => void;
}) {
  const role = ROLE_META[member.role];
  return (
    <li className="group flex items-center gap-3 rounded-lg border border-stone-800 bg-stone-900/40 px-3 py-2">
      <div className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-stone-800 text-[10px] font-semibold text-stone-300">
        {(member.name || member.email).slice(0, 1).toUpperCase()}
      </div>
      <div className="min-w-0 flex-1">
        <p className="truncate text-[13px] font-medium text-stone-100">
          {member.name || member.email}
        </p>
        {member.name && <p className="truncate text-[11px] text-stone-600">{member.email}</p>}
      </div>
      <span className={`rounded border px-1.5 py-0.5 text-[10px] font-medium ${role.className}`}>
        {role.label}
      </span>
      {canRemove && member.role !== "OWNER" && (
        <button
          type="button"
          onClick={() => onRemove(member.id)}
          disabled={busy}
          className="rounded-md p-1 text-stone-700 transition hover:text-red-400 md:opacity-0 md:group-hover:opacity-100 disabled:opacity-30"
          aria-label="Remove member"
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
    </li>
  );
}

function InviteForm({ workspaceId, onInvited }: { workspaceId: string; onInvited: () => void }) {
  const [email, setEmail] = useState("");
  const [role, setRole] = useState<"MEMBER" | "ADMIN">("MEMBER");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!email.trim()) {
      setError("Email is required.");
      return;
    }
    setSaving(true);
    setError(null);
    try {
      const res = await apiFetch<{ error?: string }>(`/api/workspaces/${workspaceId}/invite`, {
        method: "POST",
        body: JSON.stringify({ email: email.trim(), role }),
      });
      if (res.error) {
        setError(res.error);
        return;
      }
      setEmail("");
      onInvited();
    } catch (err) {
      captureClientError(err, { scope: "workspaces.invite" });
      setError("Could not invite member.");
    } finally {
      setSaving(false);
    }
  };

  return (
    <form onSubmit={handleSubmit} className="flex flex-wrap items-center gap-2">
      <input
        type="email"
        value={email}
        onChange={(e) => setEmail(e.target.value)}
        placeholder="invite@example.com"
        className="flex-1 min-w-[180px] rounded-lg border border-stone-700 bg-stone-900 px-3 py-1.5 text-sm text-stone-200 placeholder-stone-600 focus:border-stone-500 focus:outline-none"
      />
      <select
        value={role}
        onChange={(e) => setRole(e.target.value as "MEMBER" | "ADMIN")}
        className="rounded-lg border border-stone-700 bg-stone-900 px-2 py-1.5 text-[12px] text-stone-300 focus:border-stone-500 focus:outline-none"
      >
        <option value="MEMBER">Member</option>
        <option value="ADMIN">Admin</option>
      </select>
      <button
        type="submit"
        disabled={saving}
        className="rounded-lg bg-stone-700 px-3 py-1.5 text-sm text-stone-100 hover:bg-stone-600 transition disabled:opacity-50"
      >
        {saving ? "Inviting…" : "Invite"}
      </button>
      {error && <p className="basis-full text-[12px] text-red-400">{error}</p>}
    </form>
  );
}

function WorkspaceCard({
  workspace,
  expanded,
  onToggle,
  onDelete,
  busy,
}: {
  workspace: Workspace;
  expanded: boolean;
  onToggle: () => void;
  onDelete: (id: string) => void;
  busy: boolean;
}) {
  const [members, setMembers] = useState<Member[]>([]);
  const [membersLoading, setMembersLoading] = useState(false);
  const [memberBusy, setMemberBusy] = useState<string | null>(null);
  const role = ROLE_META[workspace.role];
  const canManage = workspace.role !== "MEMBER";
  const [confirmDelete, setConfirmDelete] = useState(false);

  const loadMembers = useCallback(() => {
    setMembersLoading(true);
    apiFetch<{ members: Member[] }>(`/api/workspaces/${workspace.id}/members`)
      .then((data) => setMembers(Array.isArray(data.members) ? data.members : []))
      .catch((err) => captureClientError(err, { scope: "workspaces.members" }))
      .finally(() => setMembersLoading(false));
  }, [workspace.id]);

  useEffect(() => {
    if (expanded) loadMembers();
  }, [expanded, loadMembers]);

  const handleRemoveMember = async (memberId: string) => {
    setMemberBusy(memberId);
    try {
      await apiFetch(`/api/workspaces/${workspace.id}/members/${memberId}`, { method: "DELETE" });
      setMembers((prev) => prev.filter((m) => m.id !== memberId));
    } catch (err) {
      captureClientError(err, { scope: "workspaces.remove-member" });
    } finally {
      setMemberBusy(null);
    }
  };

  return (
    <article className="rounded-xl border border-stone-800 bg-stone-900/40">
      <div
        className="flex cursor-pointer items-center gap-3 p-4 transition hover:bg-stone-900/60"
        onClick={onToggle}
        role="button"
        tabIndex={0}
        onKeyDown={(e) => {
          if (e.key === "Enter" || e.key === " ") {
            e.preventDefault();
            onToggle();
          }
        }}
      >
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <p className="break-words text-sm font-semibold text-stone-100">{workspace.name}</p>
            <span
              className={`rounded border px-1.5 py-0.5 text-[10px] font-medium ${role.className}`}
            >
              {role.label}
            </span>
          </div>
          <p className="mt-0.5 text-[11px] text-stone-600">
            {workspace.memberCount} member{workspace.memberCount === 1 ? "" : "s"} ·{" "}
            <span className="font-mono">{workspace.slug}</span>
            {workspace.plan && (
              <>
                {" "}
                · <span className="uppercase tracking-wider">{workspace.plan}</span>
              </>
            )}
          </p>
        </div>
        <svg
          aria-hidden="true"
          width="14"
          height="14"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
          className={`text-stone-500 transition ${expanded ? "rotate-180" : ""}`}
        >
          <polyline points="6 9 12 15 18 9" />
        </svg>
      </div>

      {expanded && (
        <div className="border-t border-stone-800 p-4 space-y-4">
          {canManage && (
            <div>
              <p className="mb-2 text-[11px] font-semibold uppercase tracking-widest text-stone-500">
                Invite by email
              </p>
              <InviteForm workspaceId={workspace.id} onInvited={loadMembers} />
            </div>
          )}

          <div>
            <p className="mb-2 text-[11px] font-semibold uppercase tracking-widest text-stone-500">
              Members
            </p>
            {membersLoading ? (
              <p className="text-[12px] text-stone-500">Loading…</p>
            ) : members.length === 0 ? (
              <p className="text-[12px] text-stone-500">No members yet.</p>
            ) : (
              <ul className="space-y-2">
                {members.map((m) => (
                  <MemberRow
                    key={m.id}
                    member={m}
                    canRemove={canManage}
                    busy={memberBusy === m.id}
                    onRemove={handleRemoveMember}
                  />
                ))}
              </ul>
            )}
          </div>

          {workspace.role === "OWNER" && (
            <div className="border-t border-stone-800 pt-3">
              {confirmDelete ? (
                <div className="flex items-center gap-2">
                  <button
                    type="button"
                    onClick={() => setConfirmDelete(false)}
                    className="rounded-md px-2 py-1 text-[11px] text-stone-500 hover:text-stone-300 transition"
                  >
                    Cancel
                  </button>
                  <button
                    type="button"
                    onClick={() => onDelete(workspace.id)}
                    disabled={busy}
                    className="rounded-md bg-red-600/20 px-3 py-1 text-[11px] text-red-400 hover:bg-red-600/30 transition disabled:opacity-50"
                  >
                    {busy ? "Deleting…" : "Confirm delete workspace"}
                  </button>
                </div>
              ) : (
                <button
                  type="button"
                  onClick={() => setConfirmDelete(true)}
                  className="text-[11px] text-stone-600 transition hover:text-red-400"
                >
                  Delete workspace
                </button>
              )}
            </div>
          )}
        </div>
      )}
    </article>
  );
}

function NewWorkspaceForm({ onCreated }: { onCreated: (w: Workspace) => void }) {
  const [open, setOpen] = useState(false);
  const [name, setName] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const reset = () => {
    setName("");
    setError(null);
    setOpen(false);
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (name.trim().length < 2) {
      setError("Name must be at least 2 characters.");
      return;
    }
    setSaving(true);
    setError(null);
    try {
      const res = await apiFetch<Workspace & { error?: string }>("/api/workspaces", {
        method: "POST",
        body: JSON.stringify({ name: name.trim() }),
      });
      if (res.error) {
        setError(res.error);
        return;
      }
      onCreated({ ...res, memberCount: 1, plan: res.plan ?? null });
      reset();
    } catch (err) {
      captureClientError(err, { scope: "workspaces.create" });
      setError("Could not create workspace.");
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
        New workspace
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
        value={name}
        onChange={(e) => setName(e.target.value)}
        placeholder="Workspace name"
        autoFocus
        className="w-full rounded-lg border border-stone-700 bg-stone-900 px-3 py-1.5 text-sm text-stone-200 placeholder-stone-600 focus:border-stone-500 focus:outline-none"
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
          {saving ? "Creating…" : "Create"}
        </button>
      </div>
    </form>
  );
}

function WorkspacesContent() {
  const [workspaces, setWorkspaces] = useState<Workspace[]>([]);
  const [loading, setLoading] = useState(true);
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [deleting, setDeleting] = useState<string | null>(null);

  const load = useCallback(() => {
    apiFetch<{ workspaces: Workspace[] }>("/api/workspaces")
      .then((data) => setWorkspaces(Array.isArray(data.workspaces) ? data.workspaces : []))
      .catch((err) => captureClientError(err, { scope: "workspaces.load" }))
      .finally(() => setLoading(false));
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  const handleCreated = (w: Workspace) => {
    setWorkspaces((prev) => [w, ...prev]);
    setExpandedId(w.id);
  };

  const handleDelete = async (id: string) => {
    setDeleting(id);
    try {
      await apiFetch(`/api/workspaces/${id}`, { method: "DELETE" });
      setWorkspaces((prev) => prev.filter((w) => w.id !== id));
      if (expandedId === id) setExpandedId(null);
    } catch (err) {
      captureClientError(err, { scope: "workspaces.delete" });
    } finally {
      setDeleting(null);
    }
  };

  return (
    <div className="min-h-dvh bg-[#0f1115]">
      <div className="mx-auto max-w-3xl px-6 py-8">
        <div className="mb-6">
          <h1 className="text-xl font-semibold text-stone-100">Workspaces</h1>
          <p className="mt-1 text-[13px] text-stone-500">
            Group people who share work context. EVE can surface team-wide risk and commitments once
            members are added.
          </p>
        </div>

        <div className="mb-4">
          <NewWorkspaceForm onCreated={handleCreated} />
        </div>

        {loading ? (
          <div className="space-y-3">
            {Array.from({ length: 2 }).map((_, i) => (
              <div
                key={i}
                className="h-20 animate-pulse rounded-xl border border-stone-800 bg-stone-900/30"
              />
            ))}
          </div>
        ) : workspaces.length === 0 ? (
          <div className="rounded-xl border border-stone-800 bg-stone-900/20 py-12 text-center">
            <p className="text-sm text-stone-500">No workspaces yet.</p>
            <p className="mt-1 text-[12px] text-stone-700">
              Create one above to start inviting teammates.
            </p>
          </div>
        ) : (
          <div className="space-y-3">
            {workspaces.map((w) => (
              <WorkspaceCard
                key={w.id}
                workspace={w}
                expanded={expandedId === w.id}
                onToggle={() => setExpandedId((cur) => (cur === w.id ? null : w.id))}
                onDelete={handleDelete}
                busy={deleting === w.id}
              />
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

export default function WorkspacesPage() {
  return (
    <AuthGuard>
      <WorkspacesContent />
    </AuthGuard>
  );
}
