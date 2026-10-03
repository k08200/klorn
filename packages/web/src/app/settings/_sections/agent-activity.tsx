"use client";

import { useState } from "react";
import { apiFetch } from "../../../lib/api";
import { useT } from "../../../lib/i18n";
import { captureClientError } from "../../../lib/sentry";

/** On-demand agent activity log and learned patterns (both load on click). */
export function AgentActivity() {
  const [agentLogs, setAgentLogs] = useState<
    Array<{ id: string; action: string; summary: string; tool?: string; createdAt: string }>
  >([]);
  const [agentLogsLoading, setAgentLogsLoading] = useState(false);
  const [learnedPatterns, setLearnedPatterns] = useState<
    Array<{
      type: "temporal" | "tool_preference" | "rejection" | "workflow";
      description: string;
      confidence: number;
      evidence: number;
    }>
  >([]);
  const [patternsLoading, setPatternsLoading] = useState(false);
  const [patternsLoaded, setPatternsLoaded] = useState(false);
  const { t } = useT();

  const loadAgentLogs = async () => {
    setAgentLogsLoading(true);
    try {
      const data = await apiFetch<{
        logs: Array<{
          id: string;
          action: string;
          summary: string;
          tool?: string;
          createdAt: string;
        }>;
      }>("/api/automations/agent-logs?limit=20");
      setAgentLogs(Array.isArray(data.logs) ? data.logs : []);
    } catch (err) {
      captureClientError(err, { scope: "settings.agentLogs" });
      setAgentLogs([]);
    }
    setAgentLogsLoading(false);
  };

  const loadLearnedPatterns = async () => {
    if (patternsLoading) return;
    setPatternsLoading(true);
    try {
      const data = await apiFetch<{
        patterns: Array<{
          type: "temporal" | "tool_preference" | "rejection" | "workflow";
          description: string;
          confidence: number;
          evidence: number;
        }>;
      }>("/api/patterns");
      setLearnedPatterns(Array.isArray(data.patterns) ? data.patterns : []);
      setPatternsLoaded(true);
    } catch (err) {
      captureClientError(err, { scope: "settings.patterns" });
      setLearnedPatterns([]);
      setPatternsLoaded(true);
    }
    setPatternsLoading(false);
  };

  return (
    <>
      {/* Agent Activity Log */}
      <div>
        <button
          type="button"
          onClick={loadAgentLogs}
          className="inline-flex min-h-11 items-center text-sm text-accent-deep transition hover:text-accent-deeper"
        >
          {agentLogsLoading ? t("common.loading") : t("settings.viewRecentActivity")}
        </button>
        {agentLogs.length > 0 && (
          <div className="mt-3 space-y-2 max-h-60 overflow-y-auto">
            {agentLogs.map((log) => (
              <div
                key={log.id}
                className="bg-surface-raised/60 border border-line rounded-lg px-3 py-2 text-sm"
              >
                <div className="flex items-center gap-2">
                  <span
                    className={`w-1.5 h-1.5 rounded-full ${
                      log.action === "notify"
                        ? "bg-accent"
                        : log.action === "tool_call"
                          ? "bg-emerald-400"
                          : log.action === "auto_action"
                            ? "bg-accent"
                            : log.action === "error"
                              ? "bg-red-400"
                              : "bg-slate-300"
                    }`}
                  />
                  <span className="text-ink-mid flex-1 truncate">{log.summary}</span>
                  <span className="text-ink-mid text-xs shrink-0">
                    {new Date(log.createdAt).toLocaleString("en-US", {
                      month: "short",
                      day: "numeric",
                      hour: "2-digit",
                      minute: "2-digit",
                    })}
                  </span>
                </div>
                {log.tool && (
                  <span className="text-xs text-ink-dim ml-3.5">
                    {t("settings.agentLog.toolPrefix", { tool: log.tool })}
                  </span>
                )}
              </div>
            ))}
          </div>
        )}
      </div>

      {/* Learned patterns */}
      <div>
        <button
          type="button"
          onClick={loadLearnedPatterns}
          disabled={patternsLoading}
          className="inline-flex min-h-11 items-center text-sm text-accent-deep transition hover:text-accent-deeper disabled:opacity-50"
        >
          {patternsLoading
            ? t("settings.state.analyzing")
            : patternsLoaded
              ? t("settings.refreshPatterns")
              : t("settings.whatLearned")}
        </button>
        {patternsLoaded && (
          <div className="mt-3">
            {learnedPatterns.length === 0 ? (
              <p className="text-xs text-ink-dim">{t("settings.patterns.notEnough")}</p>
            ) : (
              <div className="space-y-2">
                {learnedPatterns.slice(0, 8).map((p, i) => {
                  const confidenceLabel =
                    p.confidence >= 0.8
                      ? t("settings.confidence.high")
                      : p.confidence >= 0.5
                        ? t("settings.confidence.med")
                        : t("settings.confidence.low");
                  const typeColor =
                    p.type === "rejection"
                      ? "border-state-danger-line bg-state-danger-bg text-state-danger-ink"
                      : p.type === "temporal"
                        ? "border-blue-200 bg-blue-50 text-blue-600"
                        : p.type === "tool_preference"
                          ? "border-state-ok-line bg-state-ok-bg text-state-ok-ink"
                          : "border-state-info-line bg-state-info-bg text-accent-deep";
                  return (
                    <div
                      key={i}
                      className="bg-surface-raised/60 border border-line rounded-lg px-3 py-2 text-sm flex items-start gap-2"
                    >
                      <span
                        className={`shrink-0 rounded border px-1 py-0.5 text-[10px] font-medium ${typeColor}`}
                      >
                        {confidenceLabel}
                      </span>
                      <span className="text-ink-mid flex-1">{p.description}</span>
                      <span className="shrink-0 text-[11px] text-ink-dim">{p.evidence}×</span>
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        )}
      </div>
    </>
  );
}
