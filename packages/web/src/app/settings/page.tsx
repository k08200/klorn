"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import AuthGuard from "../../components/auth-guard";
import { useConfirm } from "../../components/confirm-dialog";
import { FeedbackPolicyPanel } from "../../components/feedback-policy-panel";
import { ListSkeleton } from "../../components/skeleton";
import { TeamRiskPanel } from "../../components/team-risk-panel";
import { useToast } from "../../components/toast";
import { API_BASE, apiFetch, authHeaders } from "../../lib/api";
import { useAuth } from "../../lib/auth";
import { captureClientError } from "../../lib/sentry";

type AgentMode = "SHADOW" | "SUGGEST" | "AUTO";

interface AgentModeOption {
  mode: AgentMode;
  label: string;
  description: string;
  autonomyLevel?: number;
}

interface ApiAgentModeOption {
  mode?: string;
  label?: string;
  description?: string;
  autonomyLevel?: number;
}

const DEFAULT_AGENT_MODE_OPTIONS: AgentModeOption[] = [
  { mode: "SHADOW", label: "SHADOW", description: "조용히 준비" },
  { mode: "SUGGEST", label: "SUGGEST", description: "실행 전 확인" },
  { mode: "AUTO", label: "AUTO", description: "안전 작업 실행" },
];

function normalizeAgentMode(value: string | undefined): AgentMode {
  if (value === "SHADOW" || value === "SUGGEST" || value === "AUTO") return value;
  return "SUGGEST";
}

function normalizeAgentModeOptions(options: ApiAgentModeOption[] | undefined): AgentModeOption[] {
  if (!options?.length) return DEFAULT_AGENT_MODE_OPTIONS;
  const seen = new Set<AgentMode>();
  const normalized = options.flatMap((option) => {
    const mode = normalizeAgentMode(option.mode);
    if (seen.has(mode)) return [];
    seen.add(mode);
    return [
      {
        mode,
        label: option.label || mode,
        description:
          option.description ||
          DEFAULT_AGENT_MODE_OPTIONS.find((fallback) => fallback.mode === mode)?.description ||
          mode,
        autonomyLevel: option.autonomyLevel,
      },
    ];
  });
  return normalized.length > 0 ? normalized : DEFAULT_AGENT_MODE_OPTIONS;
}

function agentModeToast(mode: AgentMode): string {
  switch (mode) {
    case "SHADOW":
      return "SHADOW mode — EVE will prepare work quietly";
    case "AUTO":
      return "AUTO mode — EVE will auto-execute safe actions";
    case "SUGGEST":
      return "SUGGEST mode — EVE will ask before acting";
  }
}

function agentModeClasses(mode: AgentMode, active: boolean): string {
  if (!active) return "bg-stone-900 border-stone-700 text-stone-400 hover:border-stone-600";
  if (mode === "SHADOW") return "bg-stone-800/80 border-stone-500/60 text-stone-100";
  if (mode === "AUTO") return "bg-emerald-500/15 border-emerald-400/45 text-emerald-200";
  return "bg-amber-300/20 border-amber-300/50 text-amber-100";
}

interface Integration {
  name: string;
  description: string;
  connected: boolean;
  connectUrl?: string;
  statusUrl: string;
}

interface UserProfile {
  name: string;
  language: "en" | "ko" | "auto";
  timezone: string;
}

interface ModelSettings {
  chatModels: string[];
  agentModels: string[];
  currentChatModel: string;
  currentAgentModel: string | null;
  hasOpenRouterApiKey: boolean;
  hasGeminiApiKey: boolean;
}

const TIMEZONES = [
  "Asia/Seoul",
  "Asia/Tokyo",
  "America/New_York",
  "America/Los_Angeles",
  "America/Chicago",
  "Europe/London",
  "Europe/Berlin",
  "Europe/Paris",
  "Asia/Shanghai",
  "Asia/Singapore",
  "Australia/Sydney",
  "Pacific/Auckland",
];

export default function SettingsPage() {
  const [googleConnected, setGoogleConnected] = useState(false);
  const [slackConnected, setSlackConnected] = useState(false);
  const [slackMode, setSlackMode] = useState<"none" | "bot_token" | "webhook">("none");
  const [slackTesting, setSlackTesting] = useState(false);
  const [notionConnected, setNotionConnected] = useState(false);
  const [loading, setLoading] = useState(true);
  const [profile, setProfile] = useState<UserProfile>({
    name: "",
    language: "auto",
    timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
  });
  const [profileSaved, setProfileSaved] = useState(false);
  const [currentPassword, setCurrentPassword] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [passwordLoading, setPasswordLoading] = useState(false);
  const [pushStatus, setPushStatus] = useState<"unsupported" | "default" | "granted" | "denied">(
    "default",
  );
  const [hasPassword, setHasPassword] = useState(true);
  const [agentEnabled, setAgentEnabled] = useState(true);
  const [agentMode, setAgentMode] = useState<AgentMode>("SUGGEST");
  const [agentModeOptions, setAgentModeOptions] = useState<AgentModeOption[]>(
    DEFAULT_AGENT_MODE_OPTIONS,
  );
  const [agentInterval, setAgentInterval] = useState(5);
  const [dailyBriefingEnabled, setDailyBriefingEnabled] = useState(true);
  const [briefingTime, setBriefingTime] = useState("06:00");
  const [modelSettings, setModelSettings] = useState<ModelSettings | null>(null);
  const [modelSaving, setModelSaving] = useState(false);
  const [openRouterApiKey, setOpenRouterApiKey] = useState("");
  const [geminiApiKey, setGeminiApiKey] = useState("");
  const [alwaysAllowedTools, setAlwaysAllowedTools] = useState<string[]>([]);
  const [autoMarkReadEnabled, setAutoMarkReadEnabled] = useState(false);
  const [preApprovableTools, setPreApprovableTools] = useState<string[]>([]);
  const [notifPrefs, setNotifPrefs] = useState({
    notifyEmailUrgent: true,
    notifyMeeting: true,
    notifyTaskDue: true,
    notifyAgentProposal: true,
    notifyDailyBriefing: true,
    quietHoursStart: "" as string | null,
    quietHoursEnd: "" as string | null,
  });
  const [agentLogs, setAgentLogs] = useState<
    Array<{ id: string; action: string; summary: string; tool?: string; createdAt: string }>
  >([]);
  const [agentLogsLoading, setAgentLogsLoading] = useState(false);
  const [gmailPushConfigured, setGmailPushConfigured] = useState(false);
  const [gmailPushEnabled, setGmailPushEnabled] = useState(false);
  const [gmailPushExpiresAt, setGmailPushExpiresAt] = useState<string | null>(null);
  const [gmailPushLoading, setGmailPushLoading] = useState(false);
  const [emailFeedbackCount, setEmailFeedbackCount] = useState<number | null>(null);
  const { user } = useAuth();
  const { toast } = useToast();
  const { confirm } = useConfirm();

  // Check push notification support and permission, auto-repair if granted but no subscription
  useEffect(() => {
    if (!("Notification" in window) || !("PushManager" in window)) {
      setPushStatus("unsupported");
      return;
    }
    const perm = Notification.permission as "default" | "granted" | "denied";
    setPushStatus(perm);

    // If permission is granted, ensure subscription exists (auto-repair)
    if (perm === "granted" && "serviceWorker" in navigator) {
      (async () => {
        try {
          const reg = await navigator.serviceWorker.ready;
          const existingSub = await reg.pushManager.getSubscription();
          if (!existingSub) {
            console.log("[PUSH-REPAIR] Permission granted but no subscription — re-subscribing...");
            const res = await fetch(`${API_BASE}/api/notifications/vapid-key`, {
              headers: authHeaders(),
            });
            if (!res.ok) return;
            const { publicKey } = await res.json();
            if (!publicKey) return;
            const sub = await reg.pushManager.subscribe({
              userVisibleOnly: true,
              applicationServerKey: urlBase64ToUint8Array(publicKey).buffer as ArrayBuffer,
            });
            console.log("[PUSH-REPAIR] Subscription created:", sub.endpoint.slice(0, 60));
            const subJson = sub.toJSON();
            const subRes = await fetch(`${API_BASE}/api/notifications/push/subscribe`, {
              method: "POST",
              headers: authHeaders(),
              body: JSON.stringify({ endpoint: subJson.endpoint, keys: subJson.keys }),
            });
            console.log("[PUSH-REPAIR] Sent to server:", subRes.ok ? "OK" : subRes.status);
          } else {
            console.log(
              "[PUSH-REPAIR] Subscription already exists:",
              existingSub.endpoint.slice(0, 60),
            );
            // Ensure server has it too (re-send)
            const subJson = existingSub.toJSON();
            await fetch(`${API_BASE}/api/notifications/push/subscribe`, {
              method: "POST",
              headers: authHeaders(),
              body: JSON.stringify({ endpoint: subJson.endpoint, keys: subJson.keys }),
            }).catch(() => {});
          }
        } catch (err) {
          console.error("[PUSH-REPAIR] Error:", err);
        }
      })();
    }
  }, []);

  // Load profile from auth + localStorage
  useEffect(() => {
    if (user?.name) {
      setProfile((p) => ({ ...p, name: user.name || p.name }));
    }
    try {
      const stored = localStorage.getItem("eve-profile");
      if (stored) {
        const parsed = JSON.parse(stored);
        setProfile((p) => ({
          ...p,
          language: parsed.language || p.language,
          timezone: parsed.timezone || p.timezone,
        }));
      }
    } catch {
      // ignore
    }
    // Check if user has a password set
    apiFetch<{ hasPassword: boolean }>("/api/auth/has-password")
      .then((d) => setHasPassword(d.hasPassword))
      .catch((err) => captureClientError(err, { scope: "settings.has-password" }));
  }, [user]);

  const saveProfile = async () => {
    // Save name to server
    try {
      await apiFetch("/api/auth/me", {
        method: "PATCH",
        body: JSON.stringify({ name: profile.name }),
      });
    } catch {
      // fallback to local only
    }
    // Save language/timezone to localStorage
    localStorage.setItem("eve-profile", JSON.stringify(profile));
    try {
      await apiFetch("/api/automations", {
        method: "PATCH",
        body: JSON.stringify({ timezone: profile.timezone }),
      });
    } catch {
      // Profile still saves locally; automation timezone can be retried later.
    }
    setProfileSaved(true);
    toast("프로필을 저장했습니다", "success");
    setTimeout(() => setProfileSaved(false), 2000);
  };

  const enablePush = async () => {
    console.log("[PUSH-SETTINGS] Enable clicked");
    if (!("Notification" in window)) {
      console.warn("[PUSH-SETTINGS] Notification API not available");
      toast("이 브라우저는 알림을 지원하지 않습니다", "error");
      return;
    }
    console.log("[PUSH-SETTINGS] Current permission:", Notification.permission);
    const permission = await Notification.requestPermission();
    console.log("[PUSH-SETTINGS] Permission result:", permission);
    setPushStatus(permission as "granted" | "denied" | "default");
    if (permission === "granted") {
      try {
        // Re-trigger subscription registration
        if ("serviceWorker" in navigator) {
          const reg = await navigator.serviceWorker.ready;
          console.log("[PUSH-SETTINGS] Service Worker ready");
          const res = await fetch(`${API_BASE}/api/notifications/vapid-key`, {
            headers: authHeaders(),
          });
          const { publicKey } = await res.json();
          console.log("[PUSH-SETTINGS] VAPID key:", publicKey ? "OK" : "MISSING");
          if (publicKey) {
            const sub = await reg.pushManager.subscribe({
              userVisibleOnly: true,
              applicationServerKey: urlBase64ToUint8Array(publicKey).buffer as ArrayBuffer,
            });
            console.log("[PUSH-SETTINGS] Subscription created:", sub.endpoint.slice(0, 60));
            const subJson = sub.toJSON();
            const subRes = await fetch(`${API_BASE}/api/notifications/push/subscribe`, {
              method: "POST",
              headers: authHeaders(),
              body: JSON.stringify({ endpoint: subJson.endpoint, keys: subJson.keys }),
            });
            console.log("[PUSH-SETTINGS] Sent to server:", subRes.ok ? "OK" : subRes.status);
            if (subRes.ok) {
              toast("macOS 알림이 활성화되었습니다", "success");
            } else {
              toast("서버 등록 실패 — 다시 시도해주세요", "error");
            }
          }
        }
      } catch (err) {
        console.error("[PUSH-SETTINGS] Error:", err);
        toast("푸시 등록 중 오류가 발생했습니다", "error");
      }
    } else if (permission === "denied") {
      toast("브라우저에서 알림이 차단되었습니다. 브라우저 설정에서 허용해주세요.", "error");
    }
  };

  const disablePush = async () => {
    if (!("serviceWorker" in navigator)) return;
    const reg = await navigator.serviceWorker.ready;
    const sub = await reg.pushManager.getSubscription();
    if (sub) {
      const endpoint = sub.endpoint;
      await sub.unsubscribe();
      await fetch(`${API_BASE}/api/notifications/push/unsubscribe`, {
        method: "DELETE",
        headers: authHeaders(),
        body: JSON.stringify({ endpoint }),
      });
    }
    setPushStatus("default");
    toast("푸시 알림을 껐습니다", "info");
  };

  const changePassword = async () => {
    if (!currentPassword || !newPassword) return;
    if (newPassword.length < 6) {
      toast("비밀번호는 6자 이상이어야 합니다", "error");
      return;
    }
    setPasswordLoading(true);
    try {
      await apiFetch("/api/auth/change-password", {
        method: "POST",
        body: JSON.stringify({ currentPassword, newPassword }),
      });
      toast("비밀번호를 변경했습니다", "success");
      setCurrentPassword("");
      setNewPassword("");
    } catch (err) {
      const msg = err instanceof Error ? err.message : "실패";
      const match = msg.match(/API \d+: (.+)/);
      const parsed = match
        ? (() => {
            try {
              return JSON.parse(match[1]).error;
            } catch {
              return match[1];
            }
          })()
        : msg;
      toast(parsed, "error");
    }
    setPasswordLoading(false);
  };

  const setPasswordForOAuth = async () => {
    if (!newPassword) return;
    if (newPassword.length < 6) {
      toast("비밀번호는 6자 이상이어야 합니다", "error");
      return;
    }
    setPasswordLoading(true);
    try {
      await apiFetch("/api/auth/set-password", {
        method: "POST",
        body: JSON.stringify({ newPassword }),
      });
      toast("비밀번호를 설정했습니다", "success");
      setNewPassword("");
      setHasPassword(true);
    } catch (err) {
      const msg = err instanceof Error ? err.message : "실패";
      const match = msg.match(/API \d+: (.+)/);
      const parsed = match
        ? (() => {
            try {
              return JSON.parse(match[1]).error;
            } catch {
              return match[1];
            }
          })()
        : msg;
      toast(parsed, "error");
    }
    setPasswordLoading(false);
  };

  const disconnectGoogle = async () => {
    const ok = await confirm({
      title: "Google 연결 해제",
      message: "Gmail과 Calendar 접근 권한을 제거합니다. 필요하면 언제든 다시 연결할 수 있어요.",
      confirmLabel: "연결 해제",
      danger: true,
    });
    if (!ok) return;
    try {
      await fetch(`${API_BASE}/api/auth/google`, { method: "DELETE", headers: authHeaders() });
      setGoogleConnected(false);
      setGmailPushEnabled(false);
      setGmailPushExpiresAt(null);
      toast("Google 연결을 해제했습니다", "info");
    } catch {
      toast("연결 해제에 실패했습니다", "error");
    }
  };

  const enableGmailPush = async () => {
    setGmailPushLoading(true);
    try {
      const res = await fetch(`${API_BASE}/api/gmail/watch/enable`, {
        method: "POST",
        headers: authHeaders(),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({ error: "요청 실패" }));
        toast(body.error || "실시간 동기화를 켜지 못했습니다", "error");
        return;
      }
      const data = (await res.json()) as { expiration?: string };
      setGmailPushEnabled(true);
      if (data.expiration) {
        setGmailPushExpiresAt(new Date(Number(data.expiration)).toISOString());
      }
      toast("실시간 메일 동기화를 켰습니다", "success");
    } catch {
      toast("실시간 동기화를 켜지 못했습니다", "error");
    } finally {
      setGmailPushLoading(false);
    }
  };

  const disableGmailPush = async () => {
    setGmailPushLoading(true);
    try {
      const res = await fetch(`${API_BASE}/api/gmail/watch/disable`, {
        method: "POST",
        headers: authHeaders(),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({ error: "요청 실패" }));
        toast(body.error || "실시간 동기화를 끄지 못했습니다", "error");
        return;
      }
      setGmailPushEnabled(false);
      setGmailPushExpiresAt(null);
      toast("실시간 메일 동기화를 껐습니다. 기본 폴링은 계속 동작합니다.", "info");
    } catch {
      toast("실시간 동기화를 끄지 못했습니다", "error");
    } finally {
      setGmailPushLoading(false);
    }
  };

  // Load agent config
  useEffect(() => {
    apiFetch<{
      autonomousAgent?: boolean;
      agentMode?: string;
      agentModes?: ApiAgentModeOption[];
      agentIntervalMin?: number;
      dailyBriefing?: boolean;
      briefingTime?: string;
      alwaysAllowedTools?: string[];
      preApprovableTools?: string[];
      autoMarkReadEnabled?: boolean;
      notifyEmailUrgent?: boolean;
      notifyMeeting?: boolean;
      notifyTaskDue?: boolean;
      notifyAgentProposal?: boolean;
      notifyDailyBriefing?: boolean;
      timezone?: string;
      quietHoursStart?: string | null;
      quietHoursEnd?: string | null;
    }>("/api/automations")
      .then((d) => {
        setAgentEnabled(d.autonomousAgent ?? true);
        setAgentMode(normalizeAgentMode(d.agentMode));
        setAgentModeOptions(normalizeAgentModeOptions(d.agentModes));
        setAgentInterval(d.agentIntervalMin ?? 5);
        setDailyBriefingEnabled(d.dailyBriefing ?? true);
        setBriefingTime(d.briefingTime ?? "06:00");
        setAlwaysAllowedTools(d.alwaysAllowedTools ?? []);
        setPreApprovableTools(d.preApprovableTools ?? []);
        setAutoMarkReadEnabled(d.autoMarkReadEnabled ?? false);
        if (d.timezone) setProfile((p) => ({ ...p, timezone: d.timezone ?? p.timezone }));
        setNotifPrefs({
          notifyEmailUrgent: d.notifyEmailUrgent ?? true,
          notifyMeeting: d.notifyMeeting ?? true,
          notifyTaskDue: d.notifyTaskDue ?? true,
          notifyAgentProposal: d.notifyAgentProposal ?? true,
          notifyDailyBriefing: d.notifyDailyBriefing ?? true,
          quietHoursStart: d.quietHoursStart ?? null,
          quietHoursEnd: d.quietHoursEnd ?? null,
        });
      })
      .catch((err) => captureClientError(err, { scope: "settings.load-automation-config" }));
  }, []);

  const updateAutoMarkRead = async (value: boolean) => {
    setAutoMarkReadEnabled(value);
    try {
      await apiFetch("/api/automations", {
        method: "PATCH",
        body: JSON.stringify({ autoMarkReadEnabled: value }),
      });
    } catch {
      setAutoMarkReadEnabled(!value);
      toast("설정을 저장하지 못했습니다", "error");
    }
  };

  const updateNotifPref = async (key: keyof typeof notifPrefs, value: boolean | string | null) => {
    const next = { ...notifPrefs, [key]: value };
    setNotifPrefs(next);
    try {
      await apiFetch("/api/automations", {
        method: "PATCH",
        body: JSON.stringify({ [key]: value }),
      });
    } catch {
      toast("설정을 저장하지 못했습니다", "error");
    }
  };

  const updateDailyBriefing = async (enabled: boolean) => {
    setDailyBriefingEnabled(enabled);
    try {
      await apiFetch("/api/automations", {
        method: "PATCH",
        body: JSON.stringify({ dailyBriefing: enabled }),
      });
      toast(enabled ? "데일리 브리핑을 켰습니다" : "데일리 브리핑을 껐습니다", "success");
    } catch {
      setDailyBriefingEnabled(!enabled);
      toast("브리핑 설정을 저장하지 못했습니다", "error");
    }
  };

  const updateBriefingTime = async (value: string) => {
    setBriefingTime(value);
    try {
      await apiFetch("/api/automations", {
        method: "PATCH",
        body: JSON.stringify({ briefingTime: value, timezone: profile.timezone }),
      });
      toast("브리핑 시간을 저장했습니다", "success");
    } catch {
      toast("브리핑 시간을 저장하지 못했습니다", "error");
    }
  };

  const toggleAlwaysAllowedTool = async (tool: string) => {
    const next = alwaysAllowedTools.includes(tool)
      ? alwaysAllowedTools.filter((t) => t !== tool)
      : [...alwaysAllowedTools, tool];
    const previous = alwaysAllowedTools;
    setAlwaysAllowedTools(next);
    try {
      const updated = await apiFetch<{ alwaysAllowedTools?: string[] }>("/api/automations", {
        method: "PATCH",
        body: JSON.stringify({ alwaysAllowedTools: next }),
      });
      if (updated.alwaysAllowedTools) setAlwaysAllowedTools(updated.alwaysAllowedTools);
    } catch (err) {
      setAlwaysAllowedTools(previous);
      toast(`업데이트 실패: ${err instanceof Error ? err.message : "오류"}`, "error");
    }
  };

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
      setAgentLogs(data.logs);
    } catch {
      setAgentLogs([]);
    }
    setAgentLogsLoading(false);
  };

  const toggleAgent = async (enabled: boolean) => {
    setAgentEnabled(enabled);
    try {
      await apiFetch("/api/automations", {
        method: "PATCH",
        body: JSON.stringify({ autonomousAgent: enabled }),
      });
      toast(enabled ? "자율 에이전트를 켰습니다" : "자율 에이전트를 껐습니다", "success");
    } catch {
      setAgentEnabled(!enabled);
      toast("업데이트에 실패했습니다", "error");
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
      toast("확인 주기를 저장하지 못했습니다", "error");
    }
  };

  const [runningAgent, setRunningAgent] = useState(false);
  const runAgentNow = async () => {
    setRunningAgent(true);
    try {
      await apiFetch<{ triggered: boolean }>("/api/automations/run-now", { method: "POST" });
      toast("에이전트를 실행했습니다. Inbox에서 결과를 확인하세요", "success");
    } catch {
      toast("에이전트를 실행하지 못했습니다", "error");
    } finally {
      setRunningAgent(false);
    }
  };

  const toggleAgentMode = async (mode: AgentMode) => {
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
      toast("모드를 저장하지 못했습니다", "error");
    }
  };

  useEffect(() => {
    Promise.all([
      apiFetch<{
        connected: boolean;
        gmailPushConfigured?: boolean;
        gmailPushEnabled?: boolean;
        gmailPushExpiresAt?: string | null;
      }>("/api/auth/google/status")
        .then((d) => {
          setGoogleConnected(d.connected);
          setGmailPushConfigured(!!d.gmailPushConfigured);
          setGmailPushEnabled(!!d.gmailPushEnabled);
          setGmailPushExpiresAt(d.gmailPushExpiresAt ?? null);
        })
        .catch((err) => captureClientError(err, { scope: "settings.google-status" })),
      apiFetch<{ configured: boolean; mode: "none" | "bot_token" | "webhook" }>("/api/slack/status")
        .then((d) => {
          setSlackConnected(d.configured);
          setSlackMode(d.mode);
        })
        .catch((err) => captureClientError(err, { scope: "settings.slack-status" })),
      apiFetch<{ configured: boolean }>("/api/notion/status")
        .then((d) => setNotionConnected(d.configured))
        .catch((err) => captureClientError(err, { scope: "settings.notion-status" })),
    ]).finally(() => setLoading(false));
  }, []);

  useEffect(() => {
    apiFetch<{ fixtures: unknown[]; count: number }>("/api/email/feedback?limit=200")
      .then((data) => setEmailFeedbackCount(data.count))
      .catch((err) => captureClientError(err, { scope: "settings.email-feedback-count" }));
  }, []);

  useEffect(() => {
    apiFetch<ModelSettings>("/api/billing/models")
      .then(setModelSettings)
      .catch((err) => captureClientError(err, { scope: "settings.model-settings" }));
  }, []);

  const patchModelSettings = async (body: Record<string, unknown>, successMessage: string) => {
    setModelSaving(true);
    try {
      const updated = await apiFetch<
        Partial<ModelSettings> & {
          success: boolean;
          chatModel?: string;
          agentModel?: string | null;
        }
      >("/api/billing/models", {
        method: "PATCH",
        body: JSON.stringify(body),
      });
      setModelSettings((prev) =>
        prev
          ? {
              ...prev,
              ...(updated.chatModel ? { currentChatModel: updated.chatModel } : {}),
              ...(updated.agentModel !== undefined
                ? { currentAgentModel: updated.agentModel ?? null }
                : {}),
              hasOpenRouterApiKey: updated.hasOpenRouterApiKey ?? prev.hasOpenRouterApiKey,
              hasGeminiApiKey: updated.hasGeminiApiKey ?? prev.hasGeminiApiKey,
            }
          : prev,
      );
      setOpenRouterApiKey("");
      setGeminiApiKey("");
      toast(successMessage, "success");
    } catch (err) {
      toast(err instanceof Error ? err.message : "모델 설정을 저장하지 못했습니다", "error");
    } finally {
      setModelSaving(false);
    }
  };

  const integrations: Integration[] = [
    {
      name: "Google",
      description: "Gmail과 Calendar 신호를 읽고 일정 준비까지 연결합니다",
      connected: googleConnected,
      connectUrl: `${API_BASE}/api/auth/google?token=${typeof window !== "undefined" ? localStorage.getItem("eve-token") || "" : ""}`,
      statusUrl: `${API_BASE}/api/auth/google/status`,
    },
    {
      name: "Slack",
      description: slackConnected
        ? `${slackMode === "bot_token" ? "bot token" : "webhook"} 방식으로 연결됨`
        : "관리자가 SLACK_BOT_TOKEN 또는 SLACK_WEBHOOK_URL 환경 변수로 설정합니다",
      connected: slackConnected,
      connectUrl: slackConnected ? undefined : "slack-admin-only",
      statusUrl: `${API_BASE}/api/slack/status`,
    },
    {
      name: "Notion",
      description: "페이지 검색, 문서 작성, 데이터베이스 접근을 준비합니다",
      connected: notionConnected,
      connectUrl: notionConnected ? undefined : "notion-coming-soon",
      statusUrl: `${API_BASE}/api/notion/status`,
    },
  ];

  const testSlack = async () => {
    setSlackTesting(true);
    try {
      const res = await fetch(`${API_BASE}/api/slack/test`, {
        method: "POST",
        headers: authHeaders(),
      });
      if (res.ok) {
        toast("Slack 테스트 메시지를 보냈습니다", "success");
      } else {
        const body = await res.json().catch(() => ({}));
        toast(body.error || "테스트 메시지를 보내지 못했습니다", "error");
      }
    } catch {
      toast("테스트 메시지를 보내지 못했습니다", "error");
    } finally {
      setSlackTesting(false);
    }
  };

  const generateBriefing = async () => {
    const res = await fetch(`${API_BASE}/api/briefing/generate`, {
      method: "POST",
      headers: authHeaders(),
      body: JSON.stringify({}),
    });
    const data = await res.json();
    toast(data.briefing || "브리핑을 만들었습니다. Briefing 화면에서 확인하세요.", "success");
  };

  const clearAllData = async () => {
    const ok = await confirm({
      title: "워크스페이스 데이터 삭제",
      message:
        "모든 결정 스레드, 할 일, 메모, 연락처, 리마인더를 삭제합니다. 이 작업은 되돌릴 수 없습니다.",
      confirmLabel: "워크스페이스 삭제",
      danger: true,
    });
    if (!ok) return;
    try {
      await fetch(`${API_BASE}/api/user/me/data`, { method: "DELETE", headers: authHeaders() });
      localStorage.removeItem("eve-profile");
      localStorage.removeItem("eve-pinned-chats");
      toast("워크스페이스 데이터를 삭제했습니다", "info");
    } catch {
      toast("데이터를 삭제하지 못했습니다", "error");
    }
  };

  const exportData = async () => {
    try {
      const res = await fetch(`${API_BASE}/api/user/me/export`, { headers: authHeaders() });
      const data = await res.json();
      const blob = new Blob([JSON.stringify(data, null, 2)], { type: "application/json" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `eve-export-${new Date().toISOString().slice(0, 10)}.json`;
      a.click();
      URL.revokeObjectURL(url);
      toast("데이터를 내보냈습니다", "success");
    } catch {
      toast("내보내기에 실패했습니다", "error");
    }
  };

  return (
    <AuthGuard>
      <main className="mx-auto max-w-4xl px-4 pb-28 pt-6 sm:px-6 md:py-10">
        <header className="mb-6 rounded-2xl border border-stone-700/45 bg-stone-950/35 p-5 shadow-sm shadow-black/20">
          <p className="text-xs font-semibold uppercase tracking-[0.24em] text-amber-300">
            Control Plane
          </p>
          <h1 className="mt-3 text-2xl font-semibold tracking-tight text-stone-50 md:text-3xl">
            EVE 운영 방식과 연결 권한
          </h1>
          <p className="mt-2 max-w-3xl text-sm leading-6 text-stone-400">
            프로필, 알림, 실행 모드, 데이터 접근을 한 화면에서 조정해 Decision OS가 일하는 경계를
            정합니다.
          </p>
        </header>

        {/* Profile */}
        <section className="mb-8">
          <h2 className="text-sm font-semibold text-stone-300 mb-3">운영자 프로필</h2>
          <div className="bg-stone-950/35 border border-stone-700/45 rounded-xl p-5 space-y-4">
            <div>
              <label htmlFor="profile-name" className="block text-sm text-stone-400 mb-1">
                표시 이름
              </label>
              <input
                id="profile-name"
                type="text"
                value={profile.name}
                onChange={(e) => setProfile((p) => ({ ...p, name: e.target.value }))}
                placeholder="이름"
                className="w-full bg-stone-900 border border-stone-700 rounded-lg px-4 py-2.5 text-sm focus:outline-none focus:border-amber-300 transition placeholder-stone-500"
              />
            </div>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
              <div>
                <label htmlFor="profile-lang" className="block text-sm text-stone-400 mb-1">
                  응답 언어
                </label>
                <select
                  id="profile-lang"
                  value={profile.language}
                  onChange={(e) =>
                    setProfile((p) => ({
                      ...p,
                      language: e.target.value as UserProfile["language"],
                    }))
                  }
                  className="w-full bg-stone-900 border border-stone-700 rounded-lg px-4 py-2.5 text-sm focus:outline-none focus:border-amber-300 transition"
                >
                  <option value="auto">자동 감지</option>
                  <option value="en">영어</option>
                  <option value="ko">한국어</option>
                </select>
              </div>
              <div>
                <label htmlFor="profile-tz" className="block text-sm text-stone-400 mb-1">
                  시간대
                </label>
                <select
                  id="profile-tz"
                  value={profile.timezone}
                  onChange={(e) => setProfile((p) => ({ ...p, timezone: e.target.value }))}
                  className="w-full bg-stone-900 border border-stone-700 rounded-lg px-4 py-2.5 text-sm focus:outline-none focus:border-amber-300 transition"
                >
                  {TIMEZONES.map((tz) => (
                    <option key={tz} value={tz}>
                      {tz.replace(/_/g, " ")}
                    </option>
                  ))}
                </select>
              </div>
            </div>
            <div className="flex justify-end">
              <button
                type="button"
                onClick={saveProfile}
                className={`px-4 py-2 rounded-lg text-sm font-medium transition ${
                  profileSaved
                    ? "bg-emerald-500 text-stone-950"
                    : "bg-amber-300 hover:bg-amber-200 text-stone-950"
                }`}
              >
                {profileSaved ? "저장됨" : "프로필 저장"}
              </button>
            </div>
          </div>
        </section>

        {/* Security */}
        <section className="mb-8">
          <h2 className="text-sm font-semibold text-stone-300 mb-3">접근 보안</h2>
          <div className="bg-stone-950/35 border border-stone-700/45 rounded-xl p-5 space-y-4">
            {hasPassword ? (
              <>
                <div>
                  <label htmlFor="current-pw" className="block text-sm text-stone-400 mb-1">
                    현재 비밀번호
                  </label>
                  <input
                    id="current-pw"
                    type="password"
                    value={currentPassword}
                    onChange={(e) => setCurrentPassword(e.target.value)}
                    placeholder="현재 비밀번호"
                    className="w-full bg-stone-900 border border-stone-700 rounded-lg px-4 py-2.5 text-sm focus:outline-none focus:border-amber-300 transition placeholder-stone-500"
                  />
                </div>
                <div>
                  <label htmlFor="new-pw" className="block text-sm text-stone-400 mb-1">
                    새 비밀번호
                  </label>
                  <input
                    id="new-pw"
                    type="password"
                    value={newPassword}
                    onChange={(e) => setNewPassword(e.target.value)}
                    placeholder="6자 이상"
                    minLength={6}
                    className="w-full bg-stone-900 border border-stone-700 rounded-lg px-4 py-2.5 text-sm focus:outline-none focus:border-amber-300 transition placeholder-stone-500"
                  />
                </div>
                <div className="flex justify-end">
                  <button
                    type="button"
                    onClick={changePassword}
                    disabled={passwordLoading || !currentPassword || !newPassword}
                    className="bg-amber-300 hover:bg-amber-200 disabled:bg-stone-700 disabled:text-stone-500 text-stone-950 px-4 py-2 rounded-lg text-sm font-medium transition"
                  >
                    {passwordLoading ? "변경 중..." : "비밀번호 변경"}
                  </button>
                </div>
              </>
            ) : (
              <>
                <p className="text-sm text-stone-400">
                  Google로 로그인했습니다. 이메일 로그인도 쓰려면 비밀번호를 설정하세요.
                  <br />
                  <span className="text-stone-500">
                    아래 비밀번호를 저장하면 이메일 로그인을 사용할 수 있습니다.
                  </span>
                </p>
                <div>
                  <label htmlFor="set-pw" className="block text-sm text-stone-400 mb-1">
                    새 비밀번호
                  </label>
                  <input
                    id="set-pw"
                    type="password"
                    value={newPassword}
                    onChange={(e) => setNewPassword(e.target.value)}
                    placeholder="6자 이상"
                    minLength={6}
                    className="w-full bg-stone-900 border border-stone-700 rounded-lg px-4 py-2.5 text-sm focus:outline-none focus:border-amber-300 transition placeholder-stone-500"
                  />
                </div>
                <div className="flex justify-end">
                  <button
                    type="button"
                    onClick={setPasswordForOAuth}
                    disabled={passwordLoading || !newPassword}
                    className="bg-amber-300 hover:bg-amber-200 disabled:bg-stone-700 disabled:text-stone-500 text-stone-950 px-4 py-2 rounded-lg text-sm font-medium transition"
                  >
                    {passwordLoading ? "설정 중..." : "비밀번호 설정"}
                  </button>
                </div>
              </>
            )}
          </div>
        </section>

        {/* Notifications */}
        <section className="mb-8">
          <h2 className="text-sm font-semibold text-stone-300 mb-3">신호 수신 리듬</h2>
          <div className="mb-4 bg-stone-950/35 border border-stone-700/45 rounded-xl p-4 space-y-4">
            <div className="flex items-start justify-between gap-4">
              <div>
                <h3 className="font-medium">모닝 브리핑</h3>
                <p className="text-sm text-stone-400">
                  로그인 상태와 관계없이 로컬 시간 기준으로 하루 한 번 결정 브리핑을 보냅니다.
                </p>
                <p className="mt-1 text-xs text-stone-500">
                  시간대: {profile.timezone}. 위 프로필에서 바꿀 수 있습니다.
                </p>
              </div>
              <button
                type="button"
                onClick={() => updateDailyBriefing(!dailyBriefingEnabled)}
                className={`relative h-6 w-12 shrink-0 rounded-full transition-colors ${
                  dailyBriefingEnabled ? "bg-amber-300" : "bg-stone-700"
                }`}
                aria-pressed={dailyBriefingEnabled}
              >
                <span
                  className={`absolute left-0.5 top-0.5 h-5 w-5 rounded-full bg-white transition-transform ${
                    dailyBriefingEnabled ? "translate-x-6" : ""
                  }`}
                />
              </button>
            </div>
            <div className="flex items-center gap-3 border-t border-stone-800 pt-3">
              <label htmlFor="briefing-time" className="text-sm font-medium text-stone-200">
                전송 시간
              </label>
              <input
                id="briefing-time"
                type="time"
                value={briefingTime}
                disabled={!dailyBriefingEnabled}
                onChange={(e) => updateBriefingTime(e.target.value)}
                className="bg-stone-900 border border-stone-700 rounded px-2 py-1 text-sm text-stone-200 disabled:opacity-50"
              />
              <span className="text-xs text-stone-500">기본값은 06:00입니다.</span>
            </div>
          </div>
          <div className="bg-stone-950/35 border border-stone-700/45 rounded-xl p-4 flex items-center justify-between">
            <div>
              <h3 className="font-medium">푸시 알림</h3>
              <p className="text-sm text-stone-400">
                {pushStatus === "unsupported"
                  ? "이 브라우저에서는 지원되지 않습니다"
                  : pushStatus === "granted"
                    ? "켜짐 — 리마인더, 브리핑, 중요 메일 알림을 받습니다"
                    : pushStatus === "denied"
                      ? "브라우저에서 차단됨 — 브라우저 설정에서 허용해 주세요"
                      : "리마인더, 브리핑, 중요 메일을 놓치지 않도록 알림을 받습니다"}
              </p>
            </div>
            {pushStatus === "unsupported" || pushStatus === "denied" ? (
              <span className="text-sm text-stone-500 bg-stone-900 px-3 py-1.5 rounded-lg border border-stone-700">
                {pushStatus === "denied" ? "차단됨" : "지원 안 됨"}
              </span>
            ) : pushStatus === "granted" ? (
              <button
                type="button"
                onClick={disablePush}
                className="text-sm text-stone-400 hover:text-red-400 bg-stone-900 hover:bg-stone-700 px-4 py-2 rounded-lg font-medium transition border border-stone-700"
              >
                끄기
              </button>
            ) : (
              <button
                type="button"
                onClick={enablePush}
                className="bg-amber-300 hover:bg-amber-200 text-stone-950 px-4 py-2 rounded-lg text-sm font-medium transition"
              >
                켜기
              </button>
            )}
          </div>

          {/* Granular Notification Preferences */}
          <div className="mt-4 bg-stone-950/35 border border-stone-700/45 rounded-xl p-4 space-y-3">
            <div>
              <h3 className="font-medium">어떤 신호가 방해할 만큼 중요한가요?</h3>
              <p className="text-xs text-stone-500 mt-0.5">
                꺼둔 항목은 푸시와 앱 안 알림 모두에서 조용히 처리됩니다
              </p>
            </div>
            <div className="space-y-2">
              {[
                {
                  key: "notifyEmailUrgent" as const,
                  label: "긴급 메일",
                  desc: "EVE가 시간 민감도가 높다고 판단한 새 메일",
                },
                {
                  key: "notifyMeeting" as const,
                  label: "미팅 리마인더",
                  desc: "다가오는 캘린더 이벤트와 스크럼 리마인더",
                },
                {
                  key: "notifyTaskDue" as const,
                  label: "마감 임박/초과",
                  desc: "할 일의 마감 리마인더",
                },
                {
                  key: "notifyAgentProposal" as const,
                  label: "에이전트 제안",
                  desc: "EVE가 실행 전 승인을 요청할 때",
                },
                {
                  key: "notifyDailyBriefing" as const,
                  label: "데일리 브리핑",
                  desc: "하루의 결정 브리핑",
                },
              ].map((row) => (
                <label
                  key={row.key}
                  className="flex items-start gap-3 py-2 cursor-pointer hover:bg-stone-900/40 rounded-lg px-2 transition"
                >
                  <input
                    type="checkbox"
                    checked={notifPrefs[row.key]}
                    onChange={(e) => updateNotifPref(row.key, e.target.checked)}
                    className="mt-0.5 w-4 h-4 rounded border-stone-600 bg-stone-900 text-amber-300 focus:ring-amber-300 focus:ring-offset-stone-950"
                  />
                  <div className="flex-1">
                    <p className="text-sm font-medium text-stone-200">{row.label}</p>
                    <p className="text-xs text-stone-500">{row.desc}</p>
                  </div>
                </label>
              ))}
            </div>
            <div className="pt-3 border-t border-stone-800">
              <p className="text-sm font-medium text-stone-200 mb-1">조용한 시간</p>
              <p className="text-xs text-stone-500 mb-3">
                이 시간대에는 푸시 알림을 보내지 않습니다. 비워두면 제한하지 않습니다.
              </p>
              <div className="flex items-center gap-3">
                <input
                  type="time"
                  value={notifPrefs.quietHoursStart || ""}
                  onChange={(e) => updateNotifPref("quietHoursStart", e.target.value || null)}
                  className="bg-stone-900 border border-stone-700 rounded px-2 py-1 text-sm text-stone-200"
                />
                <span className="text-stone-500 text-sm">부터</span>
                <input
                  type="time"
                  value={notifPrefs.quietHoursEnd || ""}
                  onChange={(e) => updateNotifPref("quietHoursEnd", e.target.value || null)}
                  className="bg-stone-900 border border-stone-700 rounded px-2 py-1 text-sm text-stone-200"
                />
              </div>
            </div>
          </div>
        </section>

        {/* Models */}
        <section className="mb-8">
          <h2 className="text-sm font-semibold text-stone-300 mb-3">모델과 API 키</h2>
          <div className="bg-stone-950/35 border border-stone-700/45 rounded-xl p-5 space-y-4">
            <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
              <div>
                <label htmlFor="chat-model" className="block text-sm text-stone-400 mb-1">
                  대화 모델
                </label>
                <select
                  id="chat-model"
                  value={modelSettings?.currentChatModel || ""}
                  disabled={!modelSettings || modelSaving}
                  onChange={(e) =>
                    patchModelSettings({ chatModel: e.target.value }, "대화 모델을 저장했습니다")
                  }
                  className="w-full bg-stone-900 border border-stone-700 rounded-lg px-4 py-2.5 text-sm focus:outline-none focus:border-amber-300 transition disabled:opacity-50"
                >
                  {(modelSettings?.chatModels || []).map((model) => (
                    <option key={model} value={model}>
                      {model}
                    </option>
                  ))}
                </select>
                <p className="mt-1 text-xs text-stone-500">
                  무료 기본값은 무료 모델을 유지하고, 유료 모델은 플랜 조건을 따릅니다.
                </p>
              </div>
              <div>
                <label htmlFor="agent-model" className="block text-sm text-stone-400 mb-1">
                  에이전트 모델
                </label>
                <select
                  id="agent-model"
                  value={modelSettings?.currentAgentModel || ""}
                  disabled={!modelSettings || modelSaving || !modelSettings.agentModels.length}
                  onChange={(e) =>
                    patchModelSettings(
                      { agentModel: e.target.value || null },
                      "에이전트 모델을 저장했습니다",
                    )
                  }
                  className="w-full bg-stone-900 border border-stone-700 rounded-lg px-4 py-2.5 text-sm focus:outline-none focus:border-amber-300 transition disabled:opacity-50"
                >
                  {(modelSettings?.agentModels || []).map((model) => (
                    <option key={model} value={model}>
                      {model}
                    </option>
                  ))}
                </select>
                <p className="mt-1 text-xs text-stone-500">
                  백그라운드 실행은 플랜이 허용하는 경우 이 모델을 사용합니다.
                </p>
              </div>
            </div>

            <div className="grid grid-cols-1 gap-4 border-t border-stone-800 pt-4 sm:grid-cols-2">
              <div>
                <div className="mb-1 flex items-center justify-between gap-3">
                  <label htmlFor="openrouter-key" className="text-sm text-stone-400">
                    OpenRouter API key
                  </label>
                  <span className="text-[11px] text-stone-500">
                    {modelSettings?.hasOpenRouterApiKey ? "저장됨" : "미설정"}
                  </span>
                </div>
                <input
                  id="openrouter-key"
                  type="password"
                  value={openRouterApiKey}
                  onChange={(e) => setOpenRouterApiKey(e.target.value)}
                  placeholder="sk-or-..."
                  className="w-full bg-stone-900 border border-stone-700 rounded-lg px-4 py-2.5 text-sm focus:outline-none focus:border-amber-300 transition placeholder-stone-500"
                />
                <div className="mt-2 flex gap-2">
                  <button
                    type="button"
                    disabled={modelSaving || !openRouterApiKey.trim()}
                    onClick={() =>
                      patchModelSettings({ openRouterApiKey }, "OpenRouter 키를 저장했습니다")
                    }
                    className="rounded-lg bg-amber-300 px-3 py-1.5 text-xs font-medium text-stone-950 transition hover:bg-amber-200 disabled:bg-stone-700 disabled:text-stone-500"
                  >
                    저장
                  </button>
                  {modelSettings?.hasOpenRouterApiKey && (
                    <button
                      type="button"
                      disabled={modelSaving}
                      onClick={() =>
                        patchModelSettings(
                          { clearOpenRouterApiKey: true },
                          "OpenRouter 키를 삭제했습니다",
                        )
                      }
                      className="rounded-lg border border-stone-700 bg-stone-900 px-3 py-1.5 text-xs text-stone-300 transition hover:bg-stone-800 disabled:opacity-50"
                    >
                      삭제
                    </button>
                  )}
                </div>
              </div>

              <div>
                <div className="mb-1 flex items-center justify-between gap-3">
                  <label htmlFor="gemini-key" className="text-sm text-stone-400">
                    Gemini API key
                  </label>
                  <span className="text-[11px] text-stone-500">
                    {modelSettings?.hasGeminiApiKey ? "저장됨" : "미설정"}
                  </span>
                </div>
                <input
                  id="gemini-key"
                  type="password"
                  value={geminiApiKey}
                  onChange={(e) => setGeminiApiKey(e.target.value)}
                  placeholder="AIza..."
                  className="w-full bg-stone-900 border border-stone-700 rounded-lg px-4 py-2.5 text-sm focus:outline-none focus:border-amber-300 transition placeholder-stone-500"
                />
                <div className="mt-2 flex gap-2">
                  <button
                    type="button"
                    disabled={modelSaving || !geminiApiKey.trim()}
                    onClick={() => patchModelSettings({ geminiApiKey }, "Gemini 키를 저장했습니다")}
                    className="rounded-lg bg-amber-300 px-3 py-1.5 text-xs font-medium text-stone-950 transition hover:bg-amber-200 disabled:bg-stone-700 disabled:text-stone-500"
                  >
                    저장
                  </button>
                  {modelSettings?.hasGeminiApiKey && (
                    <button
                      type="button"
                      disabled={modelSaving}
                      onClick={() =>
                        patchModelSettings({ clearGeminiApiKey: true }, "Gemini 키를 삭제했습니다")
                      }
                      className="rounded-lg border border-stone-700 bg-stone-900 px-3 py-1.5 text-xs text-stone-300 transition hover:bg-stone-800 disabled:opacity-50"
                    >
                      삭제
                    </button>
                  )}
                </div>
              </div>
            </div>
          </div>
        </section>

        {/* Decision Agent */}
        <section className="mb-8">
          <h2 className="text-sm font-semibold text-stone-300 mb-3">결정 에이전트</h2>
          <div className="bg-stone-950/35 border border-stone-700/45 rounded-xl p-5 space-y-4">
            <div className="flex items-center justify-between">
              <div>
                <h3 className="font-medium">실행 경계</h3>
                <p className="text-sm text-stone-400">
                  EVE가 백그라운드에서 할 일, 일정, 메일을 보고 다음 결정을 준비하되 승인 한계를
                  넘지 않도록 제어합니다.
                </p>
              </div>
              <button
                type="button"
                onClick={() => toggleAgent(!agentEnabled)}
                className={`relative w-12 h-6 rounded-full transition-colors ${
                  agentEnabled ? "bg-amber-300" : "bg-stone-700"
                }`}
              >
                <span
                  className={`absolute top-0.5 left-0.5 w-5 h-5 bg-white rounded-full transition-transform ${
                    agentEnabled ? "translate-x-6" : ""
                  }`}
                />
              </button>
            </div>

            {agentEnabled && (
              <div className="space-y-4">
                {/* Agent Mode */}
                <div>
                  <div className="text-sm text-stone-400 mb-2">에이전트 모드</div>
                  <div className="grid grid-cols-3 gap-2">
                    {agentModeOptions.map((option) => (
                      <button
                        key={option.mode}
                        type="button"
                        onClick={() => toggleAgentMode(option.mode)}
                        className={`min-w-0 px-3 py-2.5 rounded-lg border text-sm transition ${agentModeClasses(
                          option.mode,
                          agentMode === option.mode,
                        )}`}
                      >
                        <div className="font-medium truncate">{option.label}</div>
                        <div className="text-[10px] mt-0.5 opacity-70 truncate">
                          {option.description}
                        </div>
                      </button>
                    ))}
                  </div>
                  {agentMode === "SHADOW" && (
                    <p className="text-[10px] text-stone-400 mt-2">
                      EVE가 조용히 초안과 승인 대기 작업을 준비하고 Inbox에만 쌓아둬요.
                    </p>
                  )}
                  {agentMode === "AUTO" && (
                    <p className="text-[10px] text-emerald-200/75 mt-2">
                      리마인더, 할 일 업데이트, 메일 분류처럼 낮은 위험의 내부 작업은 자동 실행할 수
                      있습니다. 메일 답장, 일정 변경, 삭제성 작업은 명시적으로 허용하지 않는 한 승인
                      후 진행됩니다.
                    </p>
                  )}
                </div>

                {/* Pre-approved tools — skip approval for specific MEDIUM-risk tools */}
                {agentMode === "AUTO" && preApprovableTools.length > 0 && (
                  <div>
                    <label className="block text-sm text-stone-400 mb-2">항상 허용할 작업</label>
                    <div className="space-y-2">
                      {preApprovableTools.map((tool) => {
                        const enabled = alwaysAllowedTools.includes(tool);
                        return (
                          <button
                            key={tool}
                            type="button"
                            onClick={() => toggleAlwaysAllowedTool(tool)}
                            className={`w-full flex items-center justify-between px-3 py-2 rounded-lg border text-sm transition ${
                              enabled
                                ? "bg-amber-600/15 border-amber-500/40 text-amber-200"
                                : "bg-stone-900 border-stone-700 text-stone-400 hover:border-stone-600"
                            }`}
                          >
                            <span className="font-mono text-xs">{tool}</span>
                            <span className="text-[10px] opacity-80">
                              {enabled ? "정책 안에서 실행" : "먼저 검토"}
                            </span>
                          </button>
                        );
                      })}
                    </div>
                    <p className="text-[10px] text-stone-500 mt-2">
                      켜둔 작업은 설정한 정책 안에서만 실행됩니다. 메일 답장과 삭제성 작업은 여기서
                      사전 승인할 수 없습니다.
                    </p>
                  </div>
                )}

                {/* Check Interval */}
                <div>
                  <label htmlFor="agent-interval" className="block text-sm text-stone-400 mb-1">
                    확인 주기
                  </label>
                  <select
                    id="agent-interval"
                    value={agentInterval}
                    onChange={(e) => updateAgentInterval(Number(e.target.value))}
                    className="bg-stone-900 border border-stone-700 rounded-lg px-4 py-2 text-sm focus:outline-none focus:border-amber-300 transition"
                  >
                    <option value={3}>3분마다</option>
                    <option value={5}>5분마다 (기본)</option>
                    <option value={10}>10분마다</option>
                    <option value={15}>15분마다</option>
                    <option value={30}>30분마다</option>
                  </select>
                </div>

                {/* Gmail auto mark-as-read opt-in */}
                <div>
                  <button
                    type="button"
                    onClick={() => updateAutoMarkRead(!autoMarkReadEnabled)}
                    className={`w-full flex items-center justify-between px-3 py-2 rounded-lg border text-sm transition ${
                      autoMarkReadEnabled
                        ? "bg-emerald-500/15 border-emerald-400/40 text-emerald-200"
                        : "bg-stone-900 border-stone-700 text-stone-400 hover:border-stone-600"
                    }`}
                  >
                    <span>Gmail 자동 읽음 표시</span>
                    <span className="text-[10px] opacity-80">
                      {autoMarkReadEnabled ? "켜짐" : "꺼짐"}
                    </span>
                  </button>
                  <p className="text-[10px] text-stone-500 mt-1">
                    EVE가 AUTO 모드로 이메일에 답장한 뒤 원본 이메일을 Gmail에서 읽음으로 표시해요.
                    기본은 꺼짐 — Gmail의 "안 읽음" 상태를 백업 받은편지함으로 쓰던 경우 그대로
                    유지.
                  </p>
                </div>

                <FeedbackPolicyPanel />

                {/* Run Now Button */}
                <div>
                  <button
                    type="button"
                    onClick={runAgentNow}
                    disabled={runningAgent}
                    className="bg-amber-300 hover:bg-amber-200 disabled:opacity-50 text-stone-950 px-4 py-2 rounded-lg text-sm font-medium transition"
                  >
                    {runningAgent ? "실행 중..." : "지금 에이전트 실행"}
                  </button>
                  <p className="text-[10px] text-stone-500 mt-1">
                    다음 주기를 기다리지 않고 즉시 신호를 확인합니다.
                  </p>
                </div>
              </div>
            )}

            {/* Agent Activity Log */}
            <div>
              <button
                type="button"
                onClick={loadAgentLogs}
                className="text-sm text-amber-300 hover:text-amber-200 transition"
              >
                {agentLogsLoading ? "불러오는 중..." : "최근 활동 보기"}
              </button>
              {agentLogs.length > 0 && (
                <div className="mt-3 space-y-2 max-h-60 overflow-y-auto">
                  {agentLogs.map((log) => (
                    <div
                      key={log.id}
                      className="bg-stone-900/60 border border-stone-700/40 rounded-lg px-3 py-2 text-sm"
                    >
                      <div className="flex items-center gap-2">
                        <span
                          className={`w-1.5 h-1.5 rounded-full ${
                            log.action === "notify"
                              ? "bg-amber-300"
                              : log.action === "tool_call"
                                ? "bg-emerald-400"
                                : log.action === "auto_action"
                                  ? "bg-amber-400"
                                  : log.action === "error"
                                    ? "bg-red-400"
                                    : "bg-stone-500"
                          }`}
                        />
                        <span className="text-stone-300 flex-1 truncate">{log.summary}</span>
                        <span className="text-stone-600 text-xs shrink-0">
                          {new Date(log.createdAt).toLocaleString("en-US", {
                            month: "short",
                            day: "numeric",
                            hour: "2-digit",
                            minute: "2-digit",
                          })}
                        </span>
                      </div>
                      {log.tool && (
                        <span className="text-xs text-stone-500 ml-3.5">tool: {log.tool}</span>
                      )}
                    </div>
                  ))}
                </div>
              )}
            </div>
          </div>
        </section>

        <TeamRiskPanel />

        {/* Integrations */}
        <section className="mb-8">
          <h2 className="text-sm font-semibold text-stone-300 mb-3">연결</h2>
          <div className="space-y-3">
            {loading ? (
              <ListSkeleton count={3} />
            ) : (
              integrations.map((int) => (
                <div
                  key={int.name}
                  className="bg-stone-950/35 border border-stone-700/45 rounded-xl p-4 flex items-center justify-between"
                >
                  <div>
                    <h3 className="font-medium">{int.name}</h3>
                    <p className="text-sm text-stone-400">{int.description}</p>
                  </div>
                  {int.connected ? (
                    <div className="flex items-center gap-3">
                      <span className="text-sm text-green-400 flex items-center gap-1">
                        <span className="w-2 h-2 bg-green-400 rounded-full" />
                        연결됨
                      </span>
                      {int.name === "Google" && (
                        <button
                          type="button"
                          onClick={disconnectGoogle}
                          className="text-xs text-stone-500 hover:text-red-400 transition"
                        >
                          해제
                        </button>
                      )}
                      {int.name === "Slack" && (
                        <button
                          type="button"
                          onClick={testSlack}
                          disabled={slackTesting}
                          className="text-xs text-amber-300 hover:text-amber-200 disabled:opacity-50 transition"
                        >
                          {slackTesting ? "전송 중..." : "테스트 전송"}
                        </button>
                      )}
                    </div>
                  ) : int.connectUrl?.endsWith("-admin-only") ? (
                    <span className="text-sm text-stone-500 bg-stone-900 px-3 py-1.5 rounded-lg border border-stone-700">
                      관리자 설정
                    </span>
                  ) : int.connectUrl?.endsWith("-coming-soon") ? (
                    <span className="text-sm text-stone-500 bg-stone-900 px-3 py-1.5 rounded-lg border border-stone-700">
                      준비 중
                    </span>
                  ) : int.connectUrl ? (
                    <a
                      href={int.connectUrl}
                      className="bg-amber-300 hover:bg-amber-200 text-stone-950 px-4 py-2 rounded-lg text-sm font-medium transition"
                    >
                      연결
                    </a>
                  ) : (
                    <span className="text-sm text-stone-500 bg-stone-900 px-3 py-1.5 rounded-lg border border-stone-700">
                      준비 중
                    </span>
                  )}
                </div>
              ))
            )}
          </div>

          {googleConnected && (
            <div className="mt-4 bg-stone-950/35 border border-stone-700/45 rounded-xl p-4 flex items-center justify-between">
              <div>
                <h3 className="font-medium">실시간 메일 동기화</h3>
                <p className="text-sm text-stone-400">
                  {gmailPushConfigured
                    ? gmailPushEnabled
                      ? gmailPushExpiresAt
                        ? `Gmail push가 ${new Date(gmailPushExpiresAt).toLocaleString()}까지 활성화되어 있습니다. 만료 전에 자동 갱신됩니다.`
                        : "Gmail push가 활성화되어 있습니다. 만료 전에 자동 갱신됩니다."
                      : "Gmail push 알림을 구독하면 메일 신호가 즉시 들어옵니다. 꺼두면 EVE가 매분 확인합니다."
                    : "서버에 Pub/Sub 토픽이 아직 설정되지 않았습니다. 관리자에게 활성화를 요청하세요."}
                </p>
              </div>
              {gmailPushConfigured ? (
                gmailPushEnabled ? (
                  <button
                    type="button"
                    onClick={disableGmailPush}
                    disabled={gmailPushLoading}
                    className="bg-stone-900 hover:bg-stone-700 disabled:opacity-50 text-stone-100 px-4 py-2 rounded-lg text-sm font-medium transition border border-stone-700"
                  >
                    {gmailPushLoading ? "..." : "끄기"}
                  </button>
                ) : (
                  <button
                    type="button"
                    onClick={enableGmailPush}
                    disabled={gmailPushLoading}
                    className="bg-amber-300 hover:bg-amber-200 disabled:opacity-50 text-stone-950 px-4 py-2 rounded-lg text-sm font-medium transition"
                  >
                    {gmailPushLoading ? "..." : "켜기"}
                  </button>
                )
              ) : (
                <span className="text-sm text-stone-500 bg-stone-900 px-3 py-1.5 rounded-lg border border-stone-700">
                  사용할 수 없음
                </span>
              )}
            </div>
          )}
        </section>

        {/* Manual Runs */}
        <section className="mb-8">
          <h2 className="text-sm font-semibold text-stone-300 mb-3">수동 실행</h2>
          <div className="space-y-3">
            <div className="bg-stone-950/35 border border-stone-700/45 rounded-xl p-4 flex items-center justify-between">
              <div>
                <h3 className="font-medium">데일리 브리핑</h3>
                <p className="text-sm text-stone-400">
                  할 일, 일정, 메일 신호에서 우선순위가 매겨진 결정 브리핑을 만듭니다
                </p>
              </div>
              <button
                type="button"
                onClick={generateBriefing}
                className="bg-stone-900 hover:bg-stone-700 text-stone-100 px-4 py-2 rounded-lg text-sm font-medium transition border border-stone-700"
              >
                브리핑 생성
              </button>
            </div>
          </div>
        </section>

        {/* Capabilities */}
        <section className="mb-8">
          <h2 className="text-sm font-semibold text-stone-300 mb-3">실행 표면</h2>
          <div className="bg-stone-950/35 border border-stone-700/45 rounded-xl p-4 space-y-4">
            <div>
              <p className="text-xs text-amber-300 font-medium mb-2">신호 수집</p>
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-1.5 text-sm text-stone-400">
                <p>메일 — 긴급도, 발신자, 답장 필요 여부 분류</p>
                <p>캘린더 — 충돌, 준비 시간, 참석 맥락 표면화</p>
                <p>할 일 — 막힌 일, 지난 마감, 결정 가능한 작업 노출</p>
                <p>Slack과 Notion — 스레드와 문서를 업무 그래프에 연결</p>
              </div>
            </div>
            <div>
              <p className="text-xs text-green-400 font-medium mb-2">결정 출력</p>
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-1.5 text-sm text-stone-400">
                <p>승인 큐 — 준비된 답장과 일정 변경 검토</p>
                <p>결정 카드 — 추천, 위험도, 출처 맥락, 다음 단계</p>
                <p>데일리 브리핑 — 데이터 나열이 아닌 우선순위 액션</p>
                <p>작성 도구 — 맥락 기반 브리프, 제안서, 후속 초안</p>
              </div>
            </div>
            <div>
              <p className="text-xs text-rose-300 font-medium mb-2">신뢰 제어</p>
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-1.5 text-sm text-stone-400">
                <p>사전 승인 규칙 — 낮은 위험 작업을 명확한 한계 안에서 허용</p>
                <p>액션 기록 — 실행됨, 건너뜀, 검토 필요 상태 확인</p>
                <p>기억 제어 — EVE가 기억해야 할 선호 조정</p>
                <p>알림 — 방해할 가치가 있는 신호만 선택</p>
              </div>
            </div>
            <div>
              <p className="text-xs text-teal-300 font-medium mb-2">로컬 작업 표면</p>
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-1.5 text-sm text-stone-400">
                <p>파일 — 검색, 정리, 필요한 맥락 첨부</p>
                <p>화면과 클립보드 — 명시적 요청 시 로컬 상태 캡처</p>
                <p>iMessage — 같은 큐에서 개인 후속 조치 준비</p>
                <p>웹 리서치 — 최신 외부 맥락으로 결정 보강</p>
              </div>
            </div>
            <p className="text-xs text-stone-600 mt-1">
              신호 수집, 승인 흐름, 기억, 연결된 작업 표면을 한 곳에서 관리합니다
            </p>
          </div>
        </section>

        {/* Data Management */}
        <section className="mb-8">
          <h2 className="text-sm font-semibold text-stone-300 mb-3">워크스페이스 데이터</h2>
          <div className="space-y-3">
            <Link
              href="/settings/status"
              className="flex items-center justify-between rounded-xl border border-stone-700/45 bg-stone-950/35 p-4 transition hover:border-stone-700 hover:bg-stone-950"
            >
              <div className="min-w-0">
                <h3 className="font-medium">EVE 상태</h3>
                <p className="text-sm text-stone-400">
                  배포, 푸시, 리마인더, 브리핑, 연결 상태를 확인합니다
                </p>
              </div>
              <span className="ml-4 shrink-0 text-sm font-medium text-stone-400">열기 →</span>
            </Link>
            <Link
              href="/settings/email-feedback"
              className="flex items-center justify-between rounded-xl border border-stone-700/45 bg-stone-950/35 p-4 transition hover:border-stone-700 hover:bg-stone-950"
            >
              <div className="min-w-0">
                <h3 className="font-medium">메일 분류 교정</h3>
                <p className="text-sm text-stone-400">
                  {emailFeedbackCount === null
                    ? "교정 기록 확인 중..."
                    : `${emailFeedbackCount}개 교정 기록`}
                </p>
              </div>
              <span className="ml-4 shrink-0 text-sm font-medium text-stone-400">검토 →</span>
            </Link>
            <div className="bg-stone-950/35 border border-stone-700/45 rounded-xl p-4 flex items-center justify-between">
              <div>
                <h3 className="font-medium">워크스페이스 데이터 내보내기</h3>
                <p className="text-sm text-stone-400">
                  결정 스레드, 신호, 기억, 액션 기록을 JSON으로 내려받습니다
                </p>
              </div>
              <button
                type="button"
                onClick={exportData}
                className="bg-stone-900 hover:bg-stone-700 text-stone-100 px-4 py-2 rounded-lg text-sm font-medium transition border border-stone-700"
              >
                내보내기
              </button>
            </div>
          </div>
        </section>

        {/* Workspace Reset */}
        <section className="mb-8">
          <h2 className="text-sm font-semibold text-red-300 mb-3">워크스페이스 초기화</h2>
          <div className="bg-stone-950 border border-red-900/50 rounded-lg p-4 flex items-center justify-between">
            <div>
              <h3 className="font-medium">워크스페이스 데이터 삭제</h3>
              <p className="text-sm text-stone-400">
                결정 스레드, 할 일, 메모, 연락처, 리마인더를 영구 삭제합니다
              </p>
            </div>
            <button
              type="button"
              onClick={clearAllData}
              className="bg-red-600/20 hover:bg-red-600 text-red-400 hover:text-white px-4 py-2 rounded-lg text-sm font-medium transition border border-red-900/50"
            >
              워크스페이스 삭제
            </button>
          </div>
        </section>

        {/* About */}
        <section>
          <h2 className="text-sm font-semibold text-stone-300 mb-3">정보</h2>
          <div className="bg-stone-950/35 border border-stone-700/45 rounded-xl p-4">
            <p className="text-sm text-stone-400">
              <span className="text-amber-300 font-medium">EVE</span> · 업무 결정을 위한 Decision OS
            </p>
            <p className="text-sm text-stone-500 mt-1">
              흩어진 탭을 줄이고 다음 결정을 더 선명하게 만들기 위해 설계했습니다.
            </p>
            <p className="text-xs text-stone-600 mt-3">v0.2.0 — MVP</p>
          </div>
        </section>
      </main>
    </AuthGuard>
  );
}

function urlBase64ToUint8Array(base64String: string): Uint8Array {
  const padding = "=".repeat((4 - (base64String.length % 4)) % 4);
  const base64 = (base64String + padding).replace(/-/g, "+").replace(/_/g, "/");
  const raw = atob(base64);
  const arr = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++) {
    arr[i] = raw.charCodeAt(i);
  }
  return arr;
}
