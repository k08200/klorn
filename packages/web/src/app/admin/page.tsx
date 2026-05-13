"use client";

import { useEffect, useState } from "react";
import AuthGuard from "../../components/auth-guard";
import { useToast } from "../../components/toast";
import { apiFetch } from "../../lib/api";
import { useAuth } from "../../lib/auth";

interface UserRow {
  id: string;
  email: string;
  name: string | null;
  role: string;
  plan: string;
  stripeId: string | null;
  createdAt: string;
  messageCount: number;
  _count: { conversations: number; tasks: number };
}

interface Stats {
  totalUsers: number;
  totalConversations: number;
  monthlyMessages: number;
  planDistribution: Record<string, number>;
}

interface OpsMetrics {
  window: string;
  tools: { executed: number; errors: number; skipped: number; successRate: number };
  approvals: {
    proposed: number;
    approved: number;
    rejected: number;
    pending: number;
    approvalRate: number;
  };
  notifications: { sent: number; read: number; readRate: number };
  trust: {
    briefingTop3: {
      total: number;
      useful: number;
      wrong: number;
      later: number;
      done: number;
      usefulRate: number | null;
    };
    replyNeeded: {
      total: number;
      useful: number;
      wrong: number;
      later: number;
      done: number;
      usefulRate: number | null;
    };
  };
  activeUsers: { dau: number; wau: number; mau: number };
  tokens: {
    promptTokens: number;
    completionTokens: number;
    totalTokens: number;
    estimatedCostUsd: number;
  };
  recentErrors: Array<{
    summary: string;
    createdAt: string;
    userId: string;
    tool: string | null;
  }>;
}

interface PerfSnapshot {
  routes: Array<{
    route: string;
    count: number;
    errorCount: number;
    p50: number;
    p95: number;
    p99: number;
    max: number;
  }>;
  capturedAt: string;
}

interface EvalReport {
  summary: {
    total: number;
    passed: number;
    failed: number;
    passRate: number;
    failures: Array<{ id: string; name: string; severity: string; message: string }>;
  };
  results: Array<{
    id: string;
    name: string;
    description: string;
    category: string;
    severity: string;
    passed: boolean;
    message: string | null;
  }>;
  runAt: string;
}

type SectionError = { endpoint: string; message: string };

function AdminDashboard() {
  const { user, token } = useAuth();
  const { toast } = useToast();
  const [users, setUsers] = useState<UserRow[]>([]);
  const [stats, setStats] = useState<Stats | null>(null);
  const [ops, setOps] = useState<OpsMetrics | null>(null);
  const [perf, setPerf] = useState<PerfSnapshot | null>(null);
  const [evalData, setEvalData] = useState<EvalReport | null>(null);
  const [evalLoading, setEvalLoading] = useState(false);
  const [loading, setLoading] = useState(true);
  const [errors, setErrors] = useState<SectionError[]>([]);
  const [tab, setTab] = useState<"ops" | "users">("ops");

  useEffect(() => {
    if (!token) return;
    // allSettled — partial failures (e.g. one endpoint 404 on an older deploy)
    // must not blow up the whole page. Each section degrades independently.
    Promise.allSettled([
      apiFetch<{ users: UserRow[] }>("/api/admin/users"),
      apiFetch<Stats>("/api/admin/stats"),
      apiFetch<OpsMetrics>("/api/admin/ops"),
      apiFetch<PerfSnapshot>("/api/admin/perf"),
    ])
      .then(([usersRes, statsRes, opsRes, perfRes]) => {
        const failed: SectionError[] = [];

        if (usersRes.status === "fulfilled") setUsers(usersRes.value.users);
        else failed.push({ endpoint: "/api/admin/users", message: errMsg(usersRes.reason) });

        if (statsRes.status === "fulfilled") setStats(statsRes.value);
        else failed.push({ endpoint: "/api/admin/stats", message: errMsg(statsRes.reason) });

        if (opsRes.status === "fulfilled") setOps(opsRes.value);
        else failed.push({ endpoint: "/api/admin/ops", message: errMsg(opsRes.reason) });

        if (perfRes.status === "fulfilled") setPerf(perfRes.value);
        else failed.push({ endpoint: "/api/admin/perf", message: errMsg(perfRes.reason) });

        setErrors(failed);
        if (failed.length > 0 && failed.length < 4) {
          toast(
            `Could not load ${failed.length} admin section${failed.length === 1 ? "" : "s"}.`,
            "error",
          );
        } else if (failed.length === 4) {
          toast("Could not reach admin endpoints. Check the API deployment.", "error");
        }
      })
      .finally(() => setLoading(false));
  }, [token, toast]);

  const updateUser = async (id: string, data: { plan?: string; role?: string }) => {
    try {
      const updated = await apiFetch<UserRow>(`/api/admin/users/${id}`, {
        method: "PATCH",
        body: JSON.stringify(data),
      });
      setUsers((prev) => prev.map((u) => (u.id === id ? { ...u, ...updated } : u)));
      toast("Updated.", "success");
    } catch (err) {
      toast(err instanceof Error ? err.message : "Failed.", "error");
    }
  };

  const runEval = async () => {
    setEvalLoading(true);
    try {
      const data = await apiFetch<EvalReport>("/api/admin/eval");
      setEvalData(data);
      const summary = data.summary;
      if (summary.failed === 0) {
        toast(`All ${summary.total} eval scenarios passed.`, "success");
      } else {
        toast(`${summary.failed} of ${summary.total} eval scenarios failed.`, "error");
      }
    } catch (err) {
      toast(err instanceof Error ? err.message : "Could not run eval.", "error");
    } finally {
      setEvalLoading(false);
    }
  };

  const deleteUser = async (id: string, email: string) => {
    if (!confirm(`Delete ${email} and all account data?`)) return;
    try {
      await apiFetch(`/api/admin/users/${id}`, { method: "DELETE" });
      setUsers((prev) => prev.filter((u) => u.id !== id));
      toast("User deleted.", "success");
    } catch (err) {
      toast(err instanceof Error ? err.message : "Failed.", "error");
    }
  };

  if (loading) {
    return (
      <div className="flex items-center justify-center h-full">
        <div className="h-5 w-5 animate-spin rounded-full border-2 border-amber-300 border-t-transparent" />
      </div>
    );
  }

  if (user?.role !== "ADMIN") {
    return (
      <div className="flex h-full items-center justify-center text-stone-500">
        Admin access required.
      </div>
    );
  }

  return (
    <div className="h-full overflow-y-auto px-4 pb-28 pt-6 sm:px-6 md:py-10">
      <div className="mx-auto max-w-6xl space-y-6">
        {errors.length > 0 && (
          <div className="space-y-1 rounded-xl border border-amber-500/35 bg-amber-500/10 p-3 text-xs">
            <p className="font-medium text-amber-300">Some sections could not load</p>
            {errors.map((e) => (
              <p key={e.endpoint} className="font-mono text-amber-200/80">
                {e.endpoint} — {e.message}
              </p>
            ))}
          </div>
        )}
        <header className="flex flex-col gap-4 rounded-2xl border border-stone-700/45 bg-stone-950/35 p-5 shadow-sm shadow-black/20 md:flex-row md:items-center md:justify-between">
          <div>
            <p className="text-xs font-semibold uppercase tracking-[0.24em] text-amber-300">
              Ops command
            </p>
            <h1 className="mt-3 text-2xl font-semibold tracking-tight text-stone-50">
              Operations console
            </h1>
            <p className="mt-2 max-w-2xl text-sm leading-6 text-stone-400">
              Monitor execution quality, approval flow, user state, and cost from one compact view.
            </p>
          </div>
          <div className="flex w-full gap-1 rounded-lg border border-stone-700/45 bg-stone-950/70 p-1 md:w-auto">
            <button
              type="button"
              onClick={() => setTab("ops")}
              className={`flex-1 rounded px-3 py-1.5 text-xs font-medium transition md:flex-none ${tab === "ops" ? "bg-amber-300 text-stone-950" : "text-stone-500 hover:text-stone-200"}`}
            >
              Ops
            </button>
            <button
              type="button"
              onClick={() => setTab("users")}
              className={`flex-1 rounded px-3 py-1.5 text-xs font-medium transition md:flex-none ${tab === "users" ? "bg-amber-300 text-stone-950" : "text-stone-500 hover:text-stone-200"}`}
            >
              Users
            </button>
          </div>
        </header>

        {/* Agent Eval Harness */}
        <section className="rounded-2xl border border-stone-700/45 bg-stone-950/35 p-4">
          <div className="mb-3 flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
            <div>
              <h2 className="text-sm font-medium text-stone-50">Decision agent eval</h2>
              <p className="mt-0.5 text-xs text-stone-500">
                Check tool risk, dedupe, and plan-gate regressions.
              </p>
            </div>
            <button
              type="button"
              onClick={runEval}
              disabled={evalLoading}
              className="rounded-lg bg-amber-300 px-3 py-1.5 text-xs font-semibold text-stone-950 transition hover:bg-amber-200 disabled:cursor-not-allowed disabled:opacity-50"
            >
              {evalLoading ? "Running..." : "Run eval"}
            </button>
          </div>
          {evalData && (
            <div className="space-y-2">
              <div className="flex items-center gap-4 text-xs">
                <span className="text-stone-400">
                  {evalData.summary.passed}/{evalData.summary.total} passed
                </span>
                <span
                  className={`font-medium ${evalData.summary.failed === 0 ? "text-emerald-400" : "text-red-400"}`}
                >
                  Pass rate {(evalData.summary.passRate * 100).toFixed(0)}%
                </span>
                <span className="text-stone-600">
                  {new Date(evalData.runAt).toLocaleString("en-US")}
                </span>
              </div>
              <div className="space-y-1">
                {evalData.results.map((r) => (
                  <div
                    key={r.id}
                    className={`flex items-start gap-2 text-xs p-2 rounded ${
                      r.passed ? "bg-stone-900/45" : "border border-red-900/50 bg-red-950/30"
                    }`}
                  >
                    <span
                      className={`shrink-0 w-4 h-4 rounded-full flex items-center justify-center ${
                        r.passed
                          ? "bg-emerald-500/20 text-emerald-400"
                          : "bg-red-500/20 text-red-400"
                      }`}
                    >
                      {r.passed ? "✓" : "✕"}
                    </span>
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-2">
                        <span className="font-mono text-stone-500">{r.id}</span>
                        <span className="text-stone-300">{r.name}</span>
                        <span className="text-[10px] uppercase text-stone-600">[{r.severity}]</span>
                      </div>
                      {!r.passed && r.message && <p className="text-red-400 mt-0.5">{r.message}</p>}
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}
        </section>

        {/* Stats */}
        {stats && (
          <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
            <StatCard label="Total users" value={stats.totalUsers} />
            <StatCard label="Decision threads" value={stats.totalConversations} />
            <StatCard label="Monthly turns" value={stats.monthlyMessages} />
            <StatCard
              label="Plan mix"
              value={Object.entries(stats.planDistribution)
                .map(([k, v]) => `${k}: ${v}`)
                .join(", ")}
            />
          </div>
        )}

        {tab === "ops" && ops && (
          <div className="space-y-6">
            <section>
              <h2 className="mb-3 text-sm font-medium text-stone-400">Tool execution (7d)</h2>
              <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
                <StatCard
                  label="Success rate"
                  value={`${(ops.tools.successRate * 100).toFixed(1)}%`}
                />
                <StatCard label="Executed" value={ops.tools.executed} />
                <StatCard label="Errors" value={ops.tools.errors} />
                <StatCard label="Deduped" value={ops.tools.skipped} />
              </div>
            </section>

            <section>
              <h2 className="mb-3 text-sm font-medium text-stone-400">Approval flow (7d)</h2>
              <div className="grid grid-cols-2 md:grid-cols-5 gap-4">
                <StatCard
                  label="Approval rate"
                  value={`${(ops.approvals.approvalRate * 100).toFixed(1)}%`}
                />
                <StatCard label="Proposed" value={ops.approvals.proposed} />
                <StatCard label="Approved" value={ops.approvals.approved} />
                <StatCard label="Rejected" value={ops.approvals.rejected} />
                <StatCard label="Pending" value={ops.approvals.pending} />
              </div>
            </section>

            <section>
              <h2 className="mb-3 text-sm font-medium text-stone-400">Daily trust loop (7d)</h2>
              <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
                <StatCard
                  label="Top-3 useful rate"
                  value={formatNullableRate(ops.trust?.briefingTop3.usefulRate)}
                />
                <StatCard label="Top-3 votes" value={ops.trust?.briefingTop3.total ?? 0} />
                <StatCard
                  label="Reply-needed accuracy"
                  value={formatNullableRate(ops.trust?.replyNeeded.usefulRate)}
                />
                <StatCard label="Reply votes" value={ops.trust?.replyNeeded.total ?? 0} />
              </div>
            </section>

            <section>
              <h2 className="mb-3 text-sm font-medium text-stone-400">
                Active users and notifications
              </h2>
              <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
                <StatCard label="DAU" value={ops.activeUsers.dau} />
                <StatCard label="WAU" value={ops.activeUsers.wau} />
                <StatCard label="MAU" value={ops.activeUsers.mau} />
                <StatCard
                  label="Notification read rate"
                  value={`${(ops.notifications.readRate * 100).toFixed(1)}%`}
                />
              </div>
            </section>

            <section>
              <h2 className="mb-3 text-sm font-medium text-stone-400">Model cost ledger (7d)</h2>
              <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
                <StatCard label="Est. cost" value={`$${ops.tokens.estimatedCostUsd.toFixed(2)}`} />
                <StatCard label="Prompt tokens" value={ops.tokens.promptTokens.toLocaleString()} />
                <StatCard
                  label="Completion tokens"
                  value={ops.tokens.completionTokens.toLocaleString()}
                />
                <StatCard label="Total tokens" value={ops.tokens.totalTokens.toLocaleString()} />
              </div>
            </section>

            {perf && perf.routes.length > 0 && (
              <section>
                <h2 className="mb-3 text-sm font-medium text-stone-400">
                  Route latency (since last restart)
                </h2>
                <div className="overflow-x-auto rounded-2xl border border-stone-700/45 bg-stone-950/35">
                  <table className="w-full text-xs">
                    <thead>
                      <tr className="border-b border-stone-800 text-left text-stone-500">
                        <th className="p-3">Route</th>
                        <th className="p-3">Count</th>
                        <th className="p-3">Errors</th>
                        <th className="p-3">p50</th>
                        <th className="p-3">p95</th>
                        <th className="p-3">p99</th>
                        <th className="p-3">Max</th>
                      </tr>
                    </thead>
                    <tbody>
                      {perf.routes.slice(0, 20).map((r) => (
                        <tr key={r.route} className="border-b border-stone-800/60">
                          <td className="p-3 font-mono text-stone-300">{r.route}</td>
                          <td className="p-3 text-stone-400">{r.count}</td>
                          <td
                            className={`p-3 ${r.errorCount > 0 ? "text-red-400" : "text-stone-500"}`}
                          >
                            {r.errorCount}
                          </td>
                          <td className="p-3 text-stone-400">{r.p50}ms</td>
                          <td
                            className={`p-3 ${r.p95 > 1000 ? "text-amber-300" : "text-stone-400"}`}
                          >
                            {r.p95}ms
                          </td>
                          <td
                            className={`p-3 ${r.p99 > 1000 ? "text-amber-300" : "text-stone-400"}`}
                          >
                            {r.p99}ms
                          </td>
                          <td className={`p-3 ${r.max > 2000 ? "text-red-400" : "text-stone-400"}`}>
                            {r.max}ms
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </section>
            )}

            {ops.recentErrors.length > 0 && (
              <section>
                <h2 className="mb-3 text-sm font-medium text-stone-400">Recent errors</h2>
                <div className="divide-y divide-stone-800 rounded-2xl border border-stone-700/45 bg-stone-950/35">
                  {ops.recentErrors.map((e) => (
                    <div key={`${e.createdAt}-${e.userId}-${e.summary}`} className="p-3 text-xs">
                      <div className="flex justify-between mb-1">
                        <span className="text-red-400 font-mono">{e.tool || "Unknown tool"}</span>
                        <span className="text-stone-600">
                          {new Date(e.createdAt).toLocaleString("en-US")}
                        </span>
                      </div>
                      <p className="truncate text-stone-400">{e.summary}</p>
                      <p className="mt-1 text-stone-600">User: {e.userId.slice(0, 8)}</p>
                    </div>
                  ))}
                </div>
              </section>
            )}
          </div>
        )}

        {tab === "users" && (
          <div className="overflow-x-auto rounded-2xl border border-stone-700/45 bg-stone-950/35">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-stone-800 text-left text-stone-500">
                  <th className="p-3 pr-4">Email</th>
                  <th className="p-3 pr-4">Name</th>
                  <th className="p-3 pr-4">Role</th>
                  <th className="p-3 pr-4">Plan</th>
                  <th className="p-3 pr-4">Turns</th>
                  <th className="p-3 pr-4">Threads</th>
                  <th className="p-3 pr-4">Joined</th>
                  <th className="p-3">Actions</th>
                </tr>
              </thead>
              <tbody>
                {users.map((u) => (
                  <tr key={u.id} className="border-b border-stone-800/60">
                    <td className="p-3 pr-4 text-stone-300">{u.email}</td>
                    <td className="p-3 pr-4 text-stone-400">{u.name || "-"}</td>
                    <td className="p-3 pr-4">
                      <select
                        value={u.role}
                        onChange={(e) => updateUser(u.id, { role: e.target.value })}
                        className="rounded border border-stone-700 bg-stone-950 px-2 py-1 text-xs text-stone-200"
                      >
                        <option value="USER">USER</option>
                        <option value="ADMIN">ADMIN</option>
                      </select>
                    </td>
                    <td className="p-3 pr-4">
                      <select
                        value={u.plan}
                        onChange={(e) => updateUser(u.id, { plan: e.target.value })}
                        className="rounded border border-stone-700 bg-stone-950 px-2 py-1 text-xs text-stone-200"
                      >
                        <option value="FREE">FREE</option>
                        <option value="PRO">PRO</option>
                        <option value="ENTERPRISE">ENTERPRISE</option>
                      </select>
                    </td>
                    <td className="p-3 pr-4 text-stone-400">{u.messageCount}</td>
                    <td className="p-3 pr-4 text-stone-400">{u._count.conversations}</td>
                    <td className="p-3 pr-4 text-xs text-stone-500">
                      {new Date(u.createdAt).toLocaleDateString("en-US")}
                    </td>
                    <td className="p-3">
                      {u.role !== "ADMIN" && (
                        <button
                          type="button"
                          onClick={() => deleteUser(u.id, u.email)}
                          className="text-red-500 hover:text-red-400 text-xs"
                        >
                          Delete
                        </button>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}

function StatCard({ label, value }: { label: string; value: string | number }) {
  return (
    <div className="rounded-xl border border-stone-700/45 bg-stone-950/35 p-4">
      <p className="text-xs text-stone-500">{label}</p>
      <p className="mt-1 text-lg font-semibold text-stone-50">{value}</p>
    </div>
  );
}

function errMsg(reason: unknown): string {
  if (reason instanceof Error) return reason.message;
  return String(reason);
}

function formatNullableRate(value: number | null | undefined): string {
  if (typeof value !== "number") return "n/a";
  return `${(value * 100).toFixed(1)}%`;
}

export default function AdminPage() {
  return (
    <AuthGuard>
      <AdminDashboard />
    </AuthGuard>
  );
}
