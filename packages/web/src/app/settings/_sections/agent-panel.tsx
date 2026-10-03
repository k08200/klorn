"use client";

import { useEffect, useState } from "react";
import { useConfirm } from "../../../components/confirm-dialog";
import { FeedbackPolicyPanel } from "../../../components/feedback-policy-panel";
import { useToast } from "../../../components/toast";
import Button from "../../../components/ui/button";
import Switch from "../../../components/ui/switch";
import { apiFetch } from "../../../lib/api";
import { useT } from "../../../lib/i18n";
import { toolLabelKey } from "../../../lib/tool-labels";
import {
  type AgentMode,
  type AgentModeOption,
  agentModeDescription,
  agentModeLabel,
  agentModeToast,
  DEFAULT_AGENT_MODE_OPTIONS,
  normalizeAgentMode,
  normalizeAgentModeOptions,
} from "../agent-mode-helpers";
import { AgentActivity } from "./agent-activity";
import { PANEL, SECTION_TITLE } from "./shared";
import type { AutomationConfig } from "./use-automation-config";

// v2 light-surface equivalents of agentModeClasses (the helper keeps the
// legacy dark palette; presentation-only mapping, same mode semantics).
function agentModeLightClasses(mode: AgentMode, active: boolean): string {
  if (!active) return "border-line bg-surface-panel/70 text-ink-mid hover:border-line-strong";
  if (mode === "SHADOW") return "border-line-strong bg-surface-hover text-ink-soft";
  if (mode === "AUTO") return "border-state-ok-line bg-state-ok-bg text-state-ok-ink";
  return "border-state-warn-line bg-state-warn-bg text-state-warn-ink";
}

export function AgentPanel({ config }: { config: AutomationConfig | null }) {
  const [agentEnabled, setAgentEnabled] = useState(true);
  const [agentMode, setAgentMode] = useState<AgentMode>("SUGGEST");
  const [agentModeOptions, setAgentModeOptions] = useState<AgentModeOption[]>(
    DEFAULT_AGENT_MODE_OPTIONS,
  );
  const [agentInterval, setAgentInterval] = useState(5);
  const [alwaysAllowedTools, setAlwaysAllowedTools] = useState<string[]>([]);
  const [autoMarkReadEnabled, setAutoMarkReadEnabled] = useState(false);
  const [proactiveActionsEnabled, setProactiveActionsEnabled] = useState(false);
  const [preApprovableTools, setPreApprovableTools] = useState<string[]>([]);
  const [runningAgent, setRunningAgent] = useState(false);
  const { toast } = useToast();
  const { confirm } = useConfirm();
  const { t } = useT();

  useEffect(() => {
    if (!config) return;
    const d = config;
    setProactiveActionsEnabled(d.proactiveActions ?? false);
    setAgentEnabled(d.autonomousAgent ?? false);
    setAgentMode(normalizeAgentMode(d.agentMode));
    setAgentModeOptions(normalizeAgentModeOptions(d.agentModes));
    setAgentInterval(d.agentIntervalMin ?? 5);
    setAlwaysAllowedTools(Array.isArray(d.alwaysAllowedTools) ? d.alwaysAllowedTools : []);
    setPreApprovableTools(Array.isArray(d.preApprovableTools) ? d.preApprovableTools : []);
    setAutoMarkReadEnabled(d.autoMarkReadEnabled ?? false);
  }, [config]);

  const updateAutoMarkRead = async (value: boolean) => {
    if (value) {
      const ok = await confirm({
        title: t("settings.confirm.autoMarkRead.title"),
        message: t("settings.confirm.autoMarkRead.message"),
        confirmLabel: t("settings.confirm.autoMarkRead.confirmLabel"),
      });
      if (!ok) return;
    }
    setAutoMarkReadEnabled(value);
    try {
      await apiFetch("/api/automations", {
        method: "PATCH",
        body: JSON.stringify({ autoMarkReadEnabled: value }),
      });
    } catch {
      setAutoMarkReadEnabled(!value);
      toast(t("settings.toast.settingSaveFailed"), "error");
    }
  };

  const toggleAlwaysAllowedTool = async (tool: string) => {
    const isEnabling = !alwaysAllowedTools.includes(tool);
    if (isEnabling) {
      const ok = await confirm({
        title: t("settings.confirm.allowTool.title"),
        message: t("settings.confirm.allowTool.message", { tool }),
        confirmLabel: t("settings.confirm.allowTool.confirmLabel"),
      });
      if (!ok) return;
    }
    const next = alwaysAllowedTools.includes(tool)
      ? alwaysAllowedTools.filter((existing) => existing !== tool)
      : [...alwaysAllowedTools, tool];
    const previous = alwaysAllowedTools;
    setAlwaysAllowedTools(next);
    try {
      const updated = await apiFetch<{ alwaysAllowedTools?: string[] }>("/api/automations", {
        method: "PATCH",
        body: JSON.stringify({ alwaysAllowedTools: next }),
      });
      if (Array.isArray(updated.alwaysAllowedTools))
        setAlwaysAllowedTools(updated.alwaysAllowedTools);
    } catch (err) {
      setAlwaysAllowedTools(previous);
      toast(
        t("settings.toast.updateFailedWithReason", {
          reason: err instanceof Error ? err.message : t("settings.error"),
        }),
        "error",
      );
    }
  };

  const toggleAgent = async (enabled: boolean) => {
    setAgentEnabled(enabled);
    try {
      await apiFetch("/api/automations", {
        method: "PATCH",
        body: JSON.stringify({ autonomousAgent: enabled }),
      });
      toast(
        enabled ? t("settings.toast.agentEnabled") : t("settings.toast.agentDisabled"),
        "success",
      );
    } catch {
      setAgentEnabled(!enabled);
      toast(t("settings.toast.updateFailed"), "error");
    }
  };

  const updateAgentInterval = async (min: number) => {
    setAgentInterval(min);
    try {
      await apiFetch("/api/automations", {
        method: "PATCH",
        body: JSON.stringify({ agentIntervalMin: min }),
      });
    } catch {
      toast(t("settings.toast.intervalSaveFailed"), "error");
    }
  };

  const runAgentNow = async () => {
    setRunningAgent(true);
    try {
      await apiFetch<{ triggered: boolean }>("/api/automations/run-now", { method: "POST" });
      toast(t("settings.toast.agentRunStarted"), "success");
    } catch {
      toast(t("settings.toast.agentRunFailed"), "error");
    } finally {
      setRunningAgent(false);
    }
  };

  const toggleAgentMode = async (mode: AgentMode) => {
    if (mode === "AUTO" && agentMode !== "AUTO") {
      const ok = await confirm({
        title: t("settings.confirm.autoMode.title"),
        message: t("settings.confirm.autoMode.message"),
        confirmLabel: t("settings.confirm.autoMode.confirmLabel"),
      });
      if (!ok) return;
    }
    const previousMode = agentMode;
    setAgentMode(mode);
    try {
      await apiFetch("/api/automations", {
        method: "PATCH",
        body: JSON.stringify({ agentMode: mode }),
      });
      toast(agentModeToast(mode), "success");
    } catch {
      setAgentMode(previousMode);
      toast(t("settings.toast.modeSaveFailed"), "error");
    }
  };

  return (
    <section className="mb-8">
      <h2 className={SECTION_TITLE}>{t("settings.section.decisionAgent")}</h2>
      <div className={`${PANEL} p-5 space-y-4`}>
        <div className="flex items-center justify-between">
          <div>
            <h3 className="font-medium">{t("settings.executionBoundary.title")}</h3>
            <p className="text-sm text-ink-mid">{t("settings.executionBoundary.desc")}</p>
          </div>
          <Switch
            checked={agentEnabled}
            onChange={(next) => toggleAgent(next)}
            label={t("settings.executionBoundary.title")}
            hideLabel
            className="shrink-0"
          />
        </div>

        {agentEnabled && (
          <div className="space-y-4">
            {/* Agent Mode */}
            <div>
              <div className="text-sm text-ink-mid mb-2">{t("settings.field.agentMode")}</div>
              <div className="grid grid-cols-3 gap-2">
                {agentModeOptions.map((option) => (
                  <button
                    key={option.mode}
                    type="button"
                    onClick={() => toggleAgentMode(option.mode)}
                    className={`ease-strong min-h-16 min-w-0 rounded-lg border px-3 py-2.5 text-sm transition duration-150 active:scale-[0.97] ${agentModeLightClasses(
                      option.mode,
                      agentMode === option.mode,
                    )}`}
                    aria-pressed={agentMode === option.mode}
                  >
                    <div className="font-medium truncate">{agentModeLabel(option)}</div>
                    <div className="text-[10px] mt-0.5 opacity-70 truncate">
                      {agentModeDescription(option)}
                    </div>
                  </button>
                ))}
              </div>
              {agentMode === "SHADOW" && (
                <p className="text-[10px] text-ink-mid mt-2">
                  {t("settings.agentMode.shadowNote")}
                </p>
              )}
              {agentMode === "AUTO" && (
                <p className="text-[10px] text-state-ok-ink mt-2">
                  {t("settings.agentMode.autoNote")}
                </p>
              )}
            </div>

            {/* Pre-approved tools — skip approval for specific MEDIUM-risk tools */}
            {agentMode === "AUTO" && preApprovableTools.length > 0 && (
              <div>
                <label className="block text-sm text-ink-mid mb-2">
                  {t("settings.field.alwaysAllowedTools")}
                </label>
                <div className="space-y-2">
                  {preApprovableTools.map((tool) => {
                    const enabled = alwaysAllowedTools.includes(tool);
                    return (
                      <button
                        key={tool}
                        type="button"
                        onClick={() => toggleAlwaysAllowedTool(tool)}
                        className={`ease-strong flex min-h-11 w-full items-center justify-between rounded-lg border px-3 py-2 text-sm transition duration-150 active:scale-[0.97] ${
                          enabled
                            ? "bg-state-info-bg border-state-info-line text-accent-deeper"
                            : "bg-surface-panel/70 border-line text-ink-mid hover:border-line-strong"
                        }`}
                        aria-pressed={enabled}
                      >
                        <span className="text-xs">{t(toolLabelKey(tool))}</span>
                        <span className="text-[10px] opacity-80">
                          {enabled
                            ? t("settings.tool.runWithinPolicy")
                            : t("settings.tool.reviewFirst")}
                        </span>
                      </button>
                    );
                  })}
                </div>
                <p className="text-[10px] text-ink-dim mt-2">
                  {t("settings.alwaysAllowedTools.note")}
                </p>
              </div>
            )}

            {/* Check Interval */}
            <div>
              <label htmlFor="agent-interval" className="block text-sm text-ink-mid mb-1">
                {t("settings.field.checkInterval")}
              </label>
              <select
                id="agent-interval"
                value={agentInterval}
                onChange={(e) => updateAgentInterval(Number(e.target.value))}
                className="min-h-11 rounded-lg border border-line bg-surface-raised px-4 py-2 text-sm transition focus:border-accent-muted focus:outline-none"
              >
                <option value={3}>{t("settings.checkInterval.3min")}</option>
                <option value={5}>{t("settings.checkInterval.5min")}</option>
                <option value={10}>{t("settings.checkInterval.10min")}</option>
                <option value={15}>{t("settings.checkInterval.15min")}</option>
                <option value={30}>{t("settings.checkInterval.30min")}</option>
              </select>
            </div>

            {/* Gmail auto mark-as-read opt-in */}
            <div>
              <button
                type="button"
                onClick={() => updateAutoMarkRead(!autoMarkReadEnabled)}
                className={`ease-strong flex min-h-11 w-full items-center justify-between rounded-lg border px-3 py-2 text-sm transition duration-150 active:scale-[0.97] ${
                  autoMarkReadEnabled
                    ? "bg-state-ok-bg border-state-ok-line text-state-ok-ink"
                    : "bg-surface-panel/70 border-line text-ink-mid hover:border-line-strong"
                }`}
                aria-pressed={autoMarkReadEnabled}
              >
                <span>{t("settings.autoMarkRead.label")}</span>
                <span className="text-[10px] opacity-80">
                  {autoMarkReadEnabled ? t("settings.state.on") : t("settings.state.off")}
                </span>
              </button>
              <p className="text-[10px] text-ink-dim mt-1">{t("settings.autoMarkRead.desc")}</p>
            </div>

            {/* Proactive actions toggle */}
            <div>
              <button
                type="button"
                onClick={async () => {
                  const next = !proactiveActionsEnabled;
                  setProactiveActionsEnabled(next);
                  try {
                    await apiFetch("/api/automations", {
                      method: "PATCH",
                      body: JSON.stringify({ proactiveActions: next }),
                    });
                    toast(
                      next ? t("settings.toast.proactiveOn") : t("settings.toast.proactiveOff"),
                      "success",
                    );
                  } catch {
                    setProactiveActionsEnabled(!next);
                    toast(t("settings.toast.settingSaveFailed"), "error");
                  }
                }}
                className={`ease-strong flex min-h-11 w-full items-center justify-between rounded-lg border px-3 py-2 text-sm transition duration-150 active:scale-[0.97] ${
                  proactiveActionsEnabled
                    ? "bg-state-info-bg border-state-info-line text-accent-deeper"
                    : "bg-surface-panel/70 border-line text-ink-mid hover:border-line-strong"
                }`}
                aria-pressed={proactiveActionsEnabled}
              >
                <span>{t("settings.proactiveAlerts.label")}</span>
                <span className="text-[10px] opacity-80">
                  {proactiveActionsEnabled ? t("settings.state.on") : t("settings.state.off")}
                </span>
              </button>
              <p className="text-[10px] text-ink-dim mt-1">{t("settings.proactiveAlerts.desc")}</p>
            </div>

            <FeedbackPolicyPanel />

            {/* Run Now Button */}
            <div>
              <Button onClick={runAgentNow} disabled={runningAgent}>
                {runningAgent ? t("settings.state.running") : t("settings.runAgentNow")}
              </Button>
              <p className="text-[10px] text-ink-dim mt-1">{t("settings.runAgentNow.desc")}</p>
            </div>
          </div>
        )}

        <AgentActivity />
      </div>
    </section>
  );
}
