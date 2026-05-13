"use client";

import { type FormEvent, useCallback, useEffect, useState } from "react";
import { apiFetch } from "../lib/api";
import { captureClientError } from "../lib/sentry";
import type { WorkGraphContext, WorkGraphRisk } from "../lib/work-graph";
import { useToast } from "./toast";

interface Workspace {
  id: string;
  name: string;
  slug: string;
  role: string;
  memberCount: number;
  plan: string;
}

interface TeamRiskMember {
  userId: string;
  name: string | null;
  email: string;
  role: string;
}

interface TeamRiskItem {
  id: string;
  member: TeamRiskMember;
  context: WorkGraphContext;
  sharedWith: number;
  reasons: string[];
}

interface TeamRiskSummary {
  generatedAt: string;
  workspaceId: string;
  memberCount: number;
  highRiskCount: number;
  mediumRiskCount: number;
  sharedContextCount: number;
  risks: TeamRiskItem[];
}

const EMPTY_SUMMARY: TeamRiskSummary = {
  generatedAt: "",
  workspaceId: "",
  memberCount: 0,
  highRiskCount: 0,
  mediumRiskCount: 0,
  sharedContextCount: 0,
  risks: [],
};

export function TeamRiskPanel() {
  const [workspaces, setWorkspaces] = useState<Workspace[]>([]);
  const [selectedId, setSelectedId] = useState("");
  const [summary, setSummary] = useState<TeamRiskSummary>(EMPTY_SUMMARY);
  const [loading, setLoading] = useState(true);
  const [riskLoading, setRiskLoading] = useState(false);
  const [newWorkspaceName, setNewWorkspaceName] = useState("");
  const [creating, setCreating] = useState(false);
  const { toast } = useToast();

  const loadWorkspaces = useCallback(async () => {
    setLoading(true);
    try {
      const data = await apiFetch<{ workspaces: Workspace[] }>("/api/workspaces");
      setWorkspaces(data.workspaces);
      const nextId = selectedId || data.workspaces[0]?.id || "";
      setSelectedId(nextId);
      if (!nextId) setSummary(EMPTY_SUMMARY);
    } catch (err) {
      setWorkspaces([]);
      setSummary(EMPTY_SUMMARY);
      captureClientError(err, { scope: "settings.team-workspaces" });
    } finally {
      setLoading(false);
    }
  }, [selectedId]);

  const loadRisks = useCallback(async (workspaceId: string) => {
    if (!workspaceId) return;
    setRiskLoading(true);
    try {
      const data = await apiFetch<TeamRiskSummary>(`/api/workspaces/${workspaceId}/risks?limit=8`);
      setSummary(data);
    } catch (err) {
      setSummary(EMPTY_SUMMARY);
      captureClientError(err, { scope: "settings.team-risks" });
    } finally {
      setRiskLoading(false);
    }
  }, []);

  useEffect(() => {
    loadWorkspaces();
  }, [loadWorkspaces]);

  useEffect(() => {
    loadRisks(selectedId);
  }, [loadRisks, selectedId]);

  const createWorkspace = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const name = newWorkspaceName.trim();
    if (name.length < 2) return;
    setCreating(true);
    try {
      const created = await apiFetch<Pick<Workspace, "id" | "name" | "slug" | "role">>(
        "/api/workspaces",
        {
          method: "POST",
          body: JSON.stringify({ name }),
        },
      );
      const workspace: Workspace = {
        ...created,
        memberCount: 1,
        plan: "FREE",
      };
      setNewWorkspaceName("");
      setWorkspaces((current) => [workspace, ...current]);
      setSelectedId(workspace.id);
      toast("Workspace created.", "success");
    } catch {
      toast("Could not create workspace.", "error");
    } finally {
      setCreating(false);
    }
  };

  const selected = workspaces.find((workspace) => workspace.id === selectedId);

  return (
    <section className="mb-8">
      <h2 className="mb-3 text-sm font-semibold text-stone-300">Team Mode</h2>
      <div className="space-y-4 rounded-xl border border-stone-700/45 bg-stone-950/35 p-5">
        <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
          <div>
            <h3 className="font-medium">Team Risk Radar</h3>
            <p className="mt-0.5 text-sm text-stone-400">
              {selected ? `${selected.name} · ${selected.memberCount} members` : "Workspace risk"}
            </p>
          </div>
          {workspaces.length > 0 && (
            <select
              value={selectedId}
              onChange={(event) => setSelectedId(event.target.value)}
              className="rounded-lg border border-stone-700 bg-stone-900 px-3 py-2 text-sm text-stone-200 focus:border-amber-300 focus:outline-none"
            >
              {workspaces.map((workspace) => (
                <option key={workspace.id} value={workspace.id}>
                  {workspace.name}
                </option>
              ))}
            </select>
          )}
        </div>

        {loading ? (
          <div className="h-24 animate-pulse rounded-lg bg-stone-800/70" />
        ) : workspaces.length === 0 ? (
          <form onSubmit={createWorkspace} className="space-y-3">
            <input
              value={newWorkspaceName}
              onChange={(event) => setNewWorkspaceName(event.target.value)}
              placeholder="Workspace name"
              className="w-full rounded-lg border border-stone-700 bg-stone-900 px-4 py-2.5 text-sm placeholder-stone-500 transition focus:border-amber-300 focus:outline-none"
            />
            <button
              type="submit"
              disabled={creating || newWorkspaceName.trim().length < 2}
              className="rounded-lg bg-amber-300 px-4 py-2 text-sm font-semibold text-stone-950 transition hover:bg-amber-200 disabled:bg-stone-700 disabled:text-stone-500"
            >
              {creating ? "Creating..." : "Create workspace"}
            </button>
          </form>
        ) : (
          <>
            <div className="grid grid-cols-3 gap-2">
              <Metric label="High" value={summary.highRiskCount} tone="text-red-300" />
              <Metric label="Medium" value={summary.mediumRiskCount} tone="text-amber-300" />
              <Metric label="Shared" value={summary.sharedContextCount} tone="text-teal-300" />
            </div>

            {riskLoading ? (
              <div className="h-20 animate-pulse rounded-lg bg-stone-800/70" />
            ) : summary.risks.length === 0 ? (
              <div className="rounded-lg border border-stone-800 bg-stone-950/45 px-3 py-3 text-sm text-stone-500">
                No team risks right now.
              </div>
            ) : (
              <div className="space-y-2">
                {summary.risks.map((risk) => (
                  <RiskRow key={risk.id} risk={risk} />
                ))}
              </div>
            )}
          </>
        )}
      </div>
    </section>
  );
}

function RiskRow({ risk }: { risk: TeamRiskItem }) {
  return (
    <article className="rounded-lg border border-stone-800 bg-stone-950/45 px-3 py-3 transition hover:bg-stone-950/45">
      <div className="flex flex-wrap items-center gap-2">
        <RiskBadge risk={risk.context.risk} />
        {risk.sharedWith > 0 && (
          <span className="rounded border border-teal-400/20 bg-teal-400/10 px-1.5 py-0.5 text-[10px] text-teal-300">
            Shared
          </span>
        )}
        <span className="text-[11px] text-stone-500">{risk.member.name || risk.member.email}</span>
      </div>
      <p className="mt-2 truncate text-sm font-medium text-stone-100">{risk.context.title}</p>
      <p className="mt-1 line-clamp-1 text-xs text-stone-500">
        {risk.reasons.slice(0, 2).join(" · ")}
      </p>
    </article>
  );
}

function Metric({ label, value, tone }: { label: string; value: number; tone: string }) {
  return (
    <div className="rounded-lg border border-stone-800 bg-stone-950/45 px-3 py-2">
      <p className="text-[10px] text-stone-600">{label}</p>
      <p className={`text-lg font-semibold ${tone}`}>{value}</p>
    </div>
  );
}

function RiskBadge({ risk }: { risk: WorkGraphRisk }) {
  if (risk === "high") {
    return (
      <span className="rounded border border-red-500/20 bg-red-500/10 px-1.5 py-0.5 text-[10px] font-medium text-red-300">
        High
      </span>
    );
  }
  if (risk === "medium") {
    return (
      <span className="rounded border border-amber-400/20 bg-amber-400/10 px-1.5 py-0.5 text-[10px] font-medium text-amber-300">
        Medium
      </span>
    );
  }
  return (
    <span className="rounded border border-stone-700 bg-stone-900 px-1.5 py-0.5 text-[10px] font-medium text-stone-300">
      Low
    </span>
  );
}
