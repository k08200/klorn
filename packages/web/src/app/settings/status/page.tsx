"use client";

import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import AuthGuard from "../../../components/auth-guard";
import { EveSignalField } from "../../../components/brand-visuals";
import { useToast } from "../../../components/toast";
import { apiFetch } from "../../../lib/api";
import { captureClientError } from "../../../lib/sentry";

type CheckStatus = "ok" | "warning" | "error";

interface ReadinessCheck {
  key: string;
  label: string;
  status: CheckStatus;
  message: string;
  detail?: Record<string, unknown>;
}

interface ReadinessResponse {
  status: CheckStatus;
  generatedAt: string;
  system: {
    commit: string | null;
    uptime: number;
    environment: string;
    apiUrl: string | null;
  };
  checks: ReadinessCheck[];
}

interface ReminderDiagnostics {
  now: string;
  subscriptions: number;
  reminders: Array<{
    id: string;
    title: string;
    status: string;
    remindAt: string;
    due: boolean;
  }>;
  notifications: Array<{ id: string; title: string; createdAt: string }>;
  pushDeliveries: Array<{
    id: string;
    notificationId: string | null;
    category: string;
    title: string;
    status: string;
    skipReason: string | null;
    acceptedAt: string | null;
    receivedAt: string | null;
    clickedAt: string | null;
    createdAt: string;
  }>;
}

const STATUS_LABELS: Record<CheckStatus, string> = {
  ok: "OK",
  warning: "Needs setup",
  error: "Needs review",
};

const STATUS_CLASSES: Record<CheckStatus, string> = {
  ok: "border-emerald-500/30 bg-emerald-500/10 text-emerald-300",
  warning: "border-amber-500/30 bg-amber-500/10 text-amber-300",
  error: "border-red-500/30 bg-red-500/10 text-red-300",
};

export default function SettingsStatusPage() {
  const [readiness, setReadiness] = useState<ReadinessResponse | null>(null);
  const [diagnostics, setDiagnostics] = useState<ReminderDiagnostics | null>(null);
  const [loading, setLoading] = useState(true);
  const [readinessError, setReadinessError] = useState<string | null>(null);
  const [diagnosticsError, setDiagnosticsError] = useState<string | null>(null);
  const [delivering, setDelivering] = useState(false);
  const { toast } = useToast();

  const load = useCallback(async () => {
    setLoading(true);
    setReadinessError(null);
    setDiagnosticsError(null);
    const [readinessResult, diagnosticsResult] = await Promise.allSettled([
      apiFetch<ReadinessResponse>("/api/ops/readiness"),
      apiFetch<ReminderDiagnostics>("/api/reminders/diagnostics"),
    ]);
    if (readinessResult.status === "fulfilled") {
      const nextReadiness = readinessResult.value;
      setReadiness({
        status: nextReadiness.status ?? "warning",
        generatedAt: nextReadiness.generatedAt ?? new Date().toISOString(),
        system: {
          commit: nextReadiness.system?.commit ?? null,
          uptime: nextReadiness.system?.uptime ?? 0,
          environment: nextReadiness.system?.environment ?? "development",
          apiUrl: nextReadiness.system?.apiUrl ?? null,
        },
        checks: Array.isArray(nextReadiness.checks) ? nextReadiness.checks : [],
      });
    } else {
      captureClientError(readinessResult.reason, { scope: "settings.status.readiness" });
      setReadiness(null);
      setReadinessError("Could not load readiness checks.");
    }
    if (diagnosticsResult.status === "fulfilled") {
      const nextDiagnostics = diagnosticsResult.value;
      setDiagnostics({
        now: nextDiagnostics.now ?? new Date().toISOString(),
        subscriptions: nextDiagnostics.subscriptions ?? 0,
        reminders: Array.isArray(nextDiagnostics.reminders) ? nextDiagnostics.reminders : [],
        notifications: Array.isArray(nextDiagnostics.notifications)
          ? nextDiagnostics.notifications
          : [],
        pushDeliveries: Array.isArray(nextDiagnostics.pushDeliveries)
          ? nextDiagnostics.pushDeliveries
          : [],
      });
    } else {
      captureClientError(diagnosticsResult.reason, { scope: "settings.status.diagnostics" });
      setDiagnostics(null);
      setDiagnosticsError("Could not load reminder diagnostics.");
    }
    setLoading(false);
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  const deliverDue = async () => {
    setDelivering(true);
    try {
      const result = await apiFetch<{ found: number; delivered: number; failed: number }>(
        "/api/reminders/deliver-due",
        { method: "POST" },
      );
      toast(
        `Reminder check complete: delivered ${result.delivered} of ${result.found}`,
        result.failed > 0 ? "error" : "success",
      );
      await load();
    } catch (err) {
      captureClientError(err, { scope: "settings.status.deliver-due" });
      toast("Could not check reminder delivery.", "error");
    } finally {
      setDelivering(false);
    }
  };

  return (
    <AuthGuard>
      <main className="mx-auto max-w-5xl px-4 pb-28 pt-6 sm:px-6 md:py-10">
        <header className="mb-6 overflow-hidden rounded-lg border border-stone-700/45 bg-stone-950/55 shadow-2xl shadow-black/10">
          <div className="h-1 bg-gradient-to-r from-emerald-300 via-amber-300 to-stone-600" />
          <div className="grid gap-5 p-5 lg:grid-cols-[1fr_300px] lg:items-stretch">
            <div>
              <Link
                href="/settings"
                className="mb-3 inline-flex rounded-full border border-stone-700/45 px-3 py-1.5 text-xs text-stone-400 transition hover:border-amber-500/35 hover:text-stone-100"
              >
                Back to settings
              </Link>
              <p className="mb-2 text-[11px] font-semibold uppercase tracking-[0.18em] text-amber-300/80">
                Ops status
              </p>
              <h1 className="text-2xl font-semibold tracking-tight text-stone-50">Klorn status</h1>
              <p className="mt-2 max-w-xl text-sm leading-6 text-stone-500">
                Check deployment, integrations, push, reminders, and briefing readiness in one
                compact view.
              </p>
            </div>
            <div className="relative min-h-40 overflow-hidden rounded-lg border border-stone-800 bg-black/20">
              <EveSignalField className="absolute inset-0 border-0" />
              <button
                type="button"
                onClick={load}
                className="absolute right-3 top-3 inline-flex min-h-11 items-center rounded-md border border-stone-700 bg-stone-950/75 px-3 py-2 text-sm text-stone-300 backdrop-blur transition hover:border-amber-500/40 hover:bg-amber-500/10 hover:text-amber-100"
              >
                Refresh
              </button>
            </div>
          </div>
        </header>

        {loading && !readiness && !diagnostics ? (
          <div className="py-20 text-center text-sm text-stone-500">Checking status...</div>
        ) : readiness || diagnostics ? (
          <>
            {readiness ? (
              <section className="mb-6 grid gap-3 sm:grid-cols-3">
                <SummaryTile
                  label="Overall"
                  value={STATUS_LABELS[readiness.status]}
                  status={readiness.status}
                />
                <SummaryTile
                  label="API commit"
                  value={readiness.system.commit ? readiness.system.commit.slice(0, 8) : "Unknown"}
                  status={readiness.system.commit ? "ok" : "warning"}
                />
                <SummaryTile
                  label="Uptime"
                  value={formatDuration(readiness.system.uptime)}
                  status="ok"
                />
              </section>
            ) : (
              <InlineError
                message={readinessError ?? "Readiness checks are unavailable."}
                onRetry={load}
              />
            )}

            {readiness && (
              <section className="mb-8">
                <h2 className="mb-3 text-sm font-semibold text-stone-300">Readiness checks</h2>
                <div className="grid gap-3 sm:grid-cols-2">
                  {readiness.checks.map((check) => (
                    <div
                      key={check.key}
                      className="relative overflow-hidden rounded-lg border border-stone-700/45 bg-stone-950/35 p-4 pl-5"
                    >
                      <div className="absolute bottom-0 left-0 top-0 w-1 bg-gradient-to-b from-emerald-300 via-amber-300 to-stone-700" />
                      <div className="mb-2 flex items-center justify-between gap-3">
                        <h3 className="text-sm font-medium text-stone-100">
                          {readinessCheckLabel(check)}
                        </h3>
                        <StatusPill status={check.status} />
                      </div>
                      <p className="text-sm text-stone-400">{readinessCheckMessage(check)}</p>
                      {check.detail ? (
                        <pre className="mt-3 max-h-32 overflow-auto rounded-md bg-black/20 p-3 text-[11px] leading-relaxed text-stone-500">
                          {JSON.stringify(check.detail, null, 2)}
                        </pre>
                      ) : null}
                    </div>
                  ))}
                </div>
              </section>
            )}

            <section className="mb-8">
              <div className="mb-3 flex items-center justify-between gap-4">
                <h2 className="text-sm font-semibold text-stone-300">Reminder diagnostics</h2>
                <button
                  type="button"
                  onClick={deliverDue}
                  disabled={delivering}
                  className="min-h-11 rounded-lg border border-stone-700/60 px-3 py-1.5 text-sm text-stone-300 transition hover:border-amber-500/40 hover:bg-amber-500/10 hover:text-amber-100 disabled:cursor-not-allowed disabled:opacity-50"
                >
                  {delivering ? "Checking..." : "Check due reminders"}
                </button>
              </div>
              {diagnostics ? (
                <div className="rounded-lg border border-stone-700/45 bg-stone-950/35 p-4">
                  <div className="mb-4 grid gap-3 sm:grid-cols-3">
                    <Metric label="Push subscriptions" value={String(diagnostics.subscriptions)} />
                    <Metric label="Recent reminders" value={String(diagnostics.reminders.length)} />
                    <Metric
                      label="Push deliveries"
                      value={String(diagnostics.pushDeliveries.length)}
                    />
                  </div>
                  <div className="grid gap-4 lg:grid-cols-3">
                    <DiagnosticsList
                      title="Reminders"
                      empty="No recent reminders"
                      rows={diagnostics.reminders.map((r) => ({
                        id: r.id,
                        title: r.title,
                        meta: `${r.status}${r.due ? " | due" : ""} | ${formatDate(r.remindAt)}`,
                      }))}
                    />
                    <DiagnosticsList
                      title="Notifications"
                      empty="No reminder notifications"
                      rows={diagnostics.notifications.map((n) => ({
                        id: n.id,
                        title: n.title,
                        meta: formatDate(n.createdAt),
                      }))}
                    />
                    <DiagnosticsList
                      title="Push"
                      empty="No recent push deliveries"
                      rows={diagnostics.pushDeliveries.map((d) => ({
                        id: d.id,
                        title: d.title,
                        meta: `${d.status}${d.skipReason ? ` | ${d.skipReason}` : ""} | ${
                          d.receivedAt
                            ? "received"
                            : d.acceptedAt
                              ? "sent"
                              : formatDate(d.createdAt)
                        }`,
                      }))}
                    />
                  </div>
                </div>
              ) : (
                <InlineError
                  message={diagnosticsError ?? "Could not load reminder diagnostics."}
                  onRetry={load}
                />
              )}
            </section>
          </>
        ) : (
          <div className="rounded-lg border border-red-900/50 bg-red-950/20 p-6 text-sm text-red-300">
            Could not load Klorn status.
          </div>
        )}
      </main>
    </AuthGuard>
  );
}

function InlineError({ message, onRetry }: { message: string; onRetry: () => void }) {
  return (
    <div className="mb-6 flex flex-col gap-3 rounded-lg border border-red-900/50 bg-red-950/20 p-4 text-sm text-red-200 sm:flex-row sm:items-center sm:justify-between">
      <span>{message}</span>
      <button
        type="button"
        onClick={onRetry}
        className="inline-flex min-h-11 items-center justify-center rounded-lg border border-red-300/30 px-4 text-sm text-red-100 transition hover:bg-red-300/10"
      >
        Retry
      </button>
    </div>
  );
}

function SummaryTile({
  label,
  value,
  status,
}: {
  label: string;
  value: string;
  status: CheckStatus;
}) {
  return (
    <div className="rounded-lg border border-stone-700/45 bg-stone-950/35 p-4">
      <p className="mb-1 text-xs text-stone-500">{label}</p>
      <p
        className={
          status === "ok"
            ? "text-lg font-semibold text-stone-100"
            : "text-lg font-semibold text-amber-300"
        }
      >
        {value}
      </p>
    </div>
  );
}

function StatusPill({ status }: { status: CheckStatus }) {
  return (
    <span
      className={`rounded-full border px-2 py-0.5 text-[11px] font-medium ${STATUS_CLASSES[status]}`}
    >
      {STATUS_LABELS[status]}
    </span>
  );
}

function detailNumber(check: ReadinessCheck, key: string): number | null {
  const value = check.detail?.[key];
  return typeof value === "number" ? value : null;
}

function readinessCheckLabel(check: ReadinessCheck): string {
  const labels: Record<string, string> = {
    db: "Database",
    devices: "Signed-in devices",
    push: "Push notifications",
    google: "Google account",
    aiProvider: "AI provider",
    automations: "Automation settings",
    reminders: "Reminders",
    briefing: "Daily briefing",
    data: "Synced data",
  };
  return labels[check.key] ?? check.label;
}

function readinessCheckMessage(check: ReadinessCheck): string {
  switch (check.key) {
    case "db":
      return check.status === "ok" ? "Connected" : "Could not connect";
    case "devices": {
      const count = detailNumber(check, "count") ?? 0;
      return count > 0 ? `${count} active device${count === 1 ? "" : "s"}` : "No signed-in devices";
    }
    case "push": {
      const subscriptions = detailNumber(check, "subscriptions") ?? 0;
      if (check.status === "error") return "VAPID key required";
      return subscriptions > 0
        ? `${subscriptions} push subscription${subscriptions === 1 ? "" : "s"} registered`
        : "No push subscriptions";
    }
    case "google":
      return check.status === "ok" ? "Connected" : "Not connected";
    case "automations":
      return check.status === "ok" ? "Configured" : "Automation setup required";
    case "reminders": {
      const overdue = detailNumber(check, "overdue") ?? 0;
      return overdue > 0
        ? `${overdue} waiting reminder${overdue === 1 ? "" : "s"}`
        : "No overdue reminders";
    }
    case "briefing":
      if (check.message.startsWith("Generated today")) return "Briefing generated today";
      if (check.message.startsWith("Enabled for")) return "Briefing automation on";
      return "Briefing automation off";
    case "aiProvider": {
      const unavailable = detailNumber(check, "unavailableCount") ?? 0;
      if (check.status === "ok") return "All providers available";
      if (check.status === "error")
        return "All AI providers in cooldown — chat and briefing fall back to rule-based view";
      return `${unavailable} provider${unavailable === 1 ? "" : "s"} in cooldown — fallback active`;
    }
    case "data": {
      const emails = detailNumber(check, "emails") ?? 0;
      const events = detailNumber(check, "upcomingCalendarEvents") ?? 0;
      return emails > 0 || events > 0
        ? `${emails} emails, ${events} upcoming events`
        : "No synced mail or calendar data yet";
    }
    default:
      return check.message;
  }
}

function Metric({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <p className="text-xs text-stone-500">{label}</p>
      <p className="text-lg font-semibold text-stone-100">{value}</p>
    </div>
  );
}

function DiagnosticsList({
  title,
  empty,
  rows,
}: {
  title: string;
  empty: string;
  rows: Array<{ id: string; title: string; meta: string }>;
}) {
  return (
    <div>
      <h3 className="mb-2 text-xs font-medium uppercase tracking-wide text-stone-500">{title}</h3>
      {rows.length === 0 ? (
        <p className="text-sm text-stone-600">{empty}</p>
      ) : (
        <div className="space-y-2">
          {rows.slice(0, 5).map((row) => (
            <div key={row.id} className="rounded-md border border-stone-700/45 bg-black/15 p-3">
              <p className="truncate text-sm text-stone-300">{row.title}</p>
              <p className="mt-1 truncate text-xs text-stone-500">{row.meta}</p>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function formatDuration(seconds: number): string {
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  return `${hours}h ${minutes % 60}m`;
}

function formatDate(value: string): string {
  return new Intl.DateTimeFormat("en-US", {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  }).format(new Date(value));
}
