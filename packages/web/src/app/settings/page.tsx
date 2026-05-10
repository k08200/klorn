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
  { mode: "SHADOW", label: "SHADOW", description: "Prepare quietly" },
  { mode: "SUGGEST", label: "SUGGEST", description: "Ask before action" },
  { mode: "AUTO", label: "AUTO", description: "Run safe actions" },
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
  const [briefingTime, setBriefingTime] = useState("07:30");
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
    toast("Profile saved", "success");
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
        toast("Push 등록 중 오류 발생", "error");
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
    toast("Push notifications disabled", "info");
  };

  const changePassword = async () => {
    if (!currentPassword || !newPassword) return;
    if (newPassword.length < 6) {
      toast("Password must be at least 6 characters", "error");
      return;
    }
    setPasswordLoading(true);
    try {
      await apiFetch("/api/auth/change-password", {
        method: "POST",
        body: JSON.stringify({ currentPassword, newPassword }),
      });
      toast("Password changed", "success");
      setCurrentPassword("");
      setNewPassword("");
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Failed";
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
      toast("Password must be at least 6 characters", "error");
      return;
    }
    setPasswordLoading(true);
    try {
      await apiFetch("/api/auth/set-password", {
        method: "POST",
        body: JSON.stringify({ newPassword }),
      });
      toast("Password set!", "success");
      setNewPassword("");
      setHasPassword(true);
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Failed";
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
      title: "Disconnect Google",
      message: "This will remove Gmail and Calendar access. You can reconnect anytime.",
      confirmLabel: "Disconnect",
      danger: true,
    });
    if (!ok) return;
    try {
      await fetch(`${API_BASE}/api/auth/google`, { method: "DELETE", headers: authHeaders() });
      setGoogleConnected(false);
      setGmailPushEnabled(false);
      setGmailPushExpiresAt(null);
      toast("Google disconnected", "info");
    } catch {
      toast("Failed to disconnect", "error");
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
        const body = await res.json().catch(() => ({ error: "Request failed" }));
        toast(body.error || "Failed to enable real-time sync", "error");
        return;
      }
      const data = (await res.json()) as { expiration?: string };
      setGmailPushEnabled(true);
      if (data.expiration) {
        setGmailPushExpiresAt(new Date(Number(data.expiration)).toISOString());
      }
      toast("Real-time email sync enabled", "success");
    } catch {
      toast("Failed to enable real-time sync", "error");
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
        const body = await res.json().catch(() => ({ error: "Request failed" }));
        toast(body.error || "Failed to disable real-time sync", "error");
        return;
      }
      setGmailPushEnabled(false);
      setGmailPushExpiresAt(null);
      toast("Real-time email sync disabled. Polling fallback still active.", "info");
    } catch {
      toast("Failed to disable real-time sync", "error");
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
        setBriefingTime(d.briefingTime ?? "07:30");
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
      toast("Failed to save preference", "error");
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
      toast("Failed to save preference", "error");
    }
  };

  const updateDailyBriefing = async (enabled: boolean) => {
    setDailyBriefingEnabled(enabled);
    try {
      await apiFetch("/api/automations", {
        method: "PATCH",
        body: JSON.stringify({ dailyBriefing: enabled }),
      });
      toast(enabled ? "Daily briefing enabled" : "Daily briefing disabled", "success");
    } catch {
      setDailyBriefingEnabled(!enabled);
      toast("Failed to save briefing setting", "error");
    }
  };

  const updateBriefingTime = async (value: string) => {
    setBriefingTime(value);
    try {
      await apiFetch("/api/automations", {
        method: "PATCH",
        body: JSON.stringify({ briefingTime: value, timezone: profile.timezone }),
      });
      toast("Briefing time saved", "success");
    } catch {
      toast("Failed to save briefing time", "error");
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
      toast(`Failed to update: ${err instanceof Error ? err.message : "error"}`, "error");
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
      toast(enabled ? "Autonomous agent enabled" : "Autonomous agent disabled", "success");
    } catch {
      setAgentEnabled(!enabled);
      toast("Failed to update", "error");
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
      toast("Failed to update interval", "error");
    }
  };

  const [runningAgent, setRunningAgent] = useState(false);
  const runAgentNow = async () => {
    setRunningAgent(true);
    try {
      await apiFetch<{ triggered: boolean }>("/api/automations/run-now", { method: "POST" });
      toast("Agent triggered — check Inbox for results", "success");
    } catch {
      toast("Failed to trigger agent", "error");
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
      toast("Failed to update mode", "error");
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

  const integrations: Integration[] = [
    {
      name: "Google",
      description: "Gmail, Calendar — read emails, manage events",
      connected: googleConnected,
      connectUrl: `${API_BASE}/api/auth/google?token=${typeof window !== "undefined" ? localStorage.getItem("eve-token") || "" : ""}`,
      statusUrl: `${API_BASE}/api/auth/google/status`,
    },
    {
      name: "Slack",
      description: slackConnected
        ? `Connected via ${slackMode === "bot_token" ? "bot token" : "webhook"} — ask EVE to send, list, or read Slack messages`
        : "Configured by admin via SLACK_BOT_TOKEN or SLACK_WEBHOOK_URL env var",
      connected: slackConnected,
      connectUrl: slackConnected ? undefined : "slack-admin-only",
      statusUrl: `${API_BASE}/api/slack/status`,
    },
    {
      name: "Notion",
      description: "Search pages, create documents, access databases",
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
        toast("Test message sent to Slack", "success");
      } else {
        const body = await res.json().catch(() => ({}));
        toast(body.error || "Failed to send test message", "error");
      }
    } catch {
      toast("Failed to send test message", "error");
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
    toast(data.briefing || "Briefing generated — check your Notes page.", "success");
  };

  const clearAllData = async () => {
    const ok = await confirm({
      title: "Clear All Data",
      message:
        "This will delete all conversations, tasks, notes, contacts, and reminders. This cannot be undone.",
      confirmLabel: "Delete Everything",
      danger: true,
    });
    if (!ok) return;
    try {
      await fetch(`${API_BASE}/api/user/me/data`, { method: "DELETE", headers: authHeaders() });
      localStorage.removeItem("eve-profile");
      localStorage.removeItem("eve-pinned-chats");
      toast("All data cleared", "info");
    } catch {
      toast("Failed to clear data", "error");
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
      toast("Data exported", "success");
    } catch {
      toast("Export failed", "error");
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
          <h2 className="text-sm font-semibold text-stone-300 mb-3">Operator Profile</h2>
          <div className="bg-stone-950/35 border border-stone-700/45 rounded-xl p-5 space-y-4">
            <div>
              <label htmlFor="profile-name" className="block text-sm text-stone-400 mb-1">
                Display Name
              </label>
              <input
                id="profile-name"
                type="text"
                value={profile.name}
                onChange={(e) => setProfile((p) => ({ ...p, name: e.target.value }))}
                placeholder="Your name"
                className="w-full bg-stone-900 border border-stone-700 rounded-lg px-4 py-2.5 text-sm focus:outline-none focus:border-amber-300 transition placeholder-stone-500"
              />
            </div>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
              <div>
                <label htmlFor="profile-lang" className="block text-sm text-stone-400 mb-1">
                  Language
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
                  <option value="auto">Auto-detect</option>
                  <option value="en">English</option>
                  <option value="ko">Korean</option>
                </select>
              </div>
              <div>
                <label htmlFor="profile-tz" className="block text-sm text-stone-400 mb-1">
                  Timezone
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
                {profileSaved ? "Saved!" : "Save Profile"}
              </button>
            </div>
          </div>
        </section>

        {/* Security */}
        <section className="mb-8">
          <h2 className="text-sm font-semibold text-stone-300 mb-3">Access Security</h2>
          <div className="bg-stone-950/35 border border-stone-700/45 rounded-xl p-5 space-y-4">
            {hasPassword ? (
              <>
                <div>
                  <label htmlFor="current-pw" className="block text-sm text-stone-400 mb-1">
                    Current Password
                  </label>
                  <input
                    id="current-pw"
                    type="password"
                    value={currentPassword}
                    onChange={(e) => setCurrentPassword(e.target.value)}
                    placeholder="Current password"
                    className="w-full bg-stone-900 border border-stone-700 rounded-lg px-4 py-2.5 text-sm focus:outline-none focus:border-amber-300 transition placeholder-stone-500"
                  />
                </div>
                <div>
                  <label htmlFor="new-pw" className="block text-sm text-stone-400 mb-1">
                    New Password
                  </label>
                  <input
                    id="new-pw"
                    type="password"
                    value={newPassword}
                    onChange={(e) => setNewPassword(e.target.value)}
                    placeholder="At least 6 characters"
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
                    {passwordLoading ? "Changing..." : "Change Password"}
                  </button>
                </div>
              </>
            ) : (
              <>
                <p className="text-sm text-stone-400">
                  You signed in with Google. Set a password to also log in with email.
                  <br />
                  <span className="text-stone-500">
                    Set a password below to enable email login.
                  </span>
                </p>
                <div>
                  <label htmlFor="set-pw" className="block text-sm text-stone-400 mb-1">
                    New Password
                  </label>
                  <input
                    id="set-pw"
                    type="password"
                    value={newPassword}
                    onChange={(e) => setNewPassword(e.target.value)}
                    placeholder="At least 6 characters"
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
                    {passwordLoading ? "Setting..." : "Set Password"}
                  </button>
                </div>
              </>
            )}
          </div>
        </section>

        {/* Notifications */}
        <section className="mb-8">
          <h2 className="text-sm font-semibold text-stone-300 mb-3">Signal Cadence</h2>
          <div className="mb-4 bg-stone-950/35 border border-stone-700/45 rounded-xl p-4 space-y-4">
            <div className="flex items-start justify-between gap-4">
              <div>
                <h3 className="font-medium">Morning Briefing</h3>
                <p className="text-sm text-stone-400">
                  EVE sends one daily briefing at your local time, even if you stay signed in.
                </p>
                <p className="mt-1 text-xs text-stone-500">
                  Timezone: {profile.timezone}. Change it in Profile above.
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
                Send at
              </label>
              <input
                id="briefing-time"
                type="time"
                value={briefingTime}
                disabled={!dailyBriefingEnabled}
                onChange={(e) => updateBriefingTime(e.target.value)}
                className="bg-stone-900 border border-stone-700 rounded px-2 py-1 text-sm text-stone-200 disabled:opacity-50"
              />
              <span className="text-xs text-stone-500">Default is 07:30.</span>
            </div>
          </div>
          <div className="bg-stone-950/35 border border-stone-700/45 rounded-xl p-4 flex items-center justify-between">
            <div>
              <h3 className="font-medium">Push Notifications</h3>
              <p className="text-sm text-stone-400">
                {pushStatus === "unsupported"
                  ? "Not supported in this browser"
                  : pushStatus === "granted"
                    ? "Enabled — you'll receive alerts for reminders, briefings, and emails"
                    : pushStatus === "denied"
                      ? "Blocked by browser — update in browser settings"
                      : "Get notified about reminders, briefings, and important emails"}
              </p>
            </div>
            {pushStatus === "unsupported" || pushStatus === "denied" ? (
              <span className="text-sm text-stone-500 bg-stone-900 px-3 py-1.5 rounded-lg border border-stone-700">
                {pushStatus === "denied" ? "Blocked" : "Unavailable"}
              </span>
            ) : pushStatus === "granted" ? (
              <button
                type="button"
                onClick={disablePush}
                className="text-sm text-stone-400 hover:text-red-400 bg-stone-900 hover:bg-stone-700 px-4 py-2 rounded-lg font-medium transition border border-stone-700"
              >
                Disable
              </button>
            ) : (
              <button
                type="button"
                onClick={enablePush}
                className="bg-amber-300 hover:bg-amber-200 text-stone-950 px-4 py-2 rounded-lg text-sm font-medium transition"
              >
                Enable
              </button>
            )}
          </div>

          {/* Granular Notification Preferences */}
          <div className="mt-4 bg-stone-950/35 border border-stone-700/45 rounded-xl p-4 space-y-3">
            <div>
              <h3 className="font-medium">Which notifications do you want?</h3>
              <p className="text-xs text-stone-500 mt-0.5">
                Disabled categories are suppressed for both push and in-app notifications
              </p>
            </div>
            <div className="space-y-2">
              {[
                {
                  key: "notifyEmailUrgent" as const,
                  label: "Urgent email alerts",
                  desc: "Incoming mail that EVE flags as time-sensitive",
                },
                {
                  key: "notifyMeeting" as const,
                  label: "Meeting reminders",
                  desc: "Upcoming calendar events and scrum reminders",
                },
                {
                  key: "notifyTaskDue" as const,
                  label: "Task due soon or overdue",
                  desc: "Deadline reminders for your tasks",
                },
                {
                  key: "notifyAgentProposal" as const,
                  label: "Agent proposals",
                  desc: "When EVE wants your approval for an action",
                },
                {
                  key: "notifyDailyBriefing" as const,
                  label: "Daily briefing",
                  desc: "Morning summary of your day",
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
              <p className="text-sm font-medium text-stone-200 mb-1">Quiet hours</p>
              <p className="text-xs text-stone-500 mb-3">
                Suppress push notifications during this window (leave empty to disable)
              </p>
              <div className="flex items-center gap-3">
                <input
                  type="time"
                  value={notifPrefs.quietHoursStart || ""}
                  onChange={(e) => updateNotifPref("quietHoursStart", e.target.value || null)}
                  className="bg-stone-900 border border-stone-700 rounded px-2 py-1 text-sm text-stone-200"
                />
                <span className="text-stone-500 text-sm">to</span>
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

        {/* Decision Agent */}
        <section className="mb-8">
          <h2 className="text-sm font-semibold text-stone-300 mb-3">Decision Agent</h2>
          <div className="bg-stone-950/35 border border-stone-700/45 rounded-xl p-5 space-y-4">
            <div className="flex items-center justify-between">
              <div>
                <h3 className="font-medium">Execution boundary</h3>
                <p className="text-sm text-stone-400">
                  EVE watches tasks, calendar, and mail in the background, then prepares the next
                  decision without crossing approval limits.
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
                  <div className="text-sm text-stone-400 mb-2">Agent mode</div>
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
                      Safe internal actions like reminders, task updates, and email classification
                      can run automatically. Email replies, calendar changes, and destructive
                      actions require approval unless explicitly pre-approved where allowed.
                    </p>
                  )}
                </div>

                {/* Pre-approved tools — skip approval for specific MEDIUM-risk tools */}
                {agentMode === "AUTO" && preApprovableTools.length > 0 && (
                  <div>
                    <label className="block text-sm text-stone-400 mb-2">
                      Always allow (skip approval)
                    </label>
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
                              {enabled ? "Auto" : "Ask first"}
                            </span>
                          </button>
                        );
                      })}
                    </div>
                    <p className="text-[10px] text-stone-500 mt-2">
                      Enabled tools run without asking. Email replies and destructive actions always
                      require approval and cannot be pre-approved here.
                    </p>
                  </div>
                )}

                {/* Check Interval */}
                <div>
                  <label htmlFor="agent-interval" className="block text-sm text-stone-400 mb-1">
                    Check interval
                  </label>
                  <select
                    id="agent-interval"
                    value={agentInterval}
                    onChange={(e) => updateAgentInterval(Number(e.target.value))}
                    className="bg-stone-900 border border-stone-700 rounded-lg px-4 py-2 text-sm focus:outline-none focus:border-amber-300 transition"
                  >
                    <option value={3}>Every 3 min</option>
                    <option value={5}>Every 5 min (default)</option>
                    <option value={10}>Every 10 min</option>
                    <option value={15}>Every 15 min</option>
                    <option value={30}>Every 30 min</option>
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
                      {autoMarkReadEnabled ? "On" : "Off"}
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
                    {runningAgent ? "Running..." : "Run Agent Now"}
                  </button>
                  <p className="text-[10px] text-stone-500 mt-1">
                    Trigger the agent immediately without waiting for the next interval
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
                {agentLogsLoading ? "Loading..." : "View recent activity"}
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
          <h2 className="text-sm font-semibold text-stone-300 mb-3">Integrations</h2>
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
                        Connected
                      </span>
                      {int.name === "Google" && (
                        <button
                          type="button"
                          onClick={disconnectGoogle}
                          className="text-xs text-stone-500 hover:text-red-400 transition"
                        >
                          Disconnect
                        </button>
                      )}
                      {int.name === "Slack" && (
                        <button
                          type="button"
                          onClick={testSlack}
                          disabled={slackTesting}
                          className="text-xs text-amber-300 hover:text-amber-200 disabled:opacity-50 transition"
                        >
                          {slackTesting ? "Sending..." : "Send test"}
                        </button>
                      )}
                    </div>
                  ) : int.connectUrl?.endsWith("-admin-only") ? (
                    <span className="text-sm text-stone-500 bg-stone-900 px-3 py-1.5 rounded-lg border border-stone-700">
                      Admin only
                    </span>
                  ) : int.connectUrl?.endsWith("-coming-soon") ? (
                    <span className="text-sm text-stone-500 bg-stone-900 px-3 py-1.5 rounded-lg border border-stone-700">
                      Coming Soon
                    </span>
                  ) : int.connectUrl ? (
                    <a
                      href={int.connectUrl}
                      className="bg-amber-300 hover:bg-amber-200 text-stone-950 px-4 py-2 rounded-lg text-sm font-medium transition"
                    >
                      Connect
                    </a>
                  ) : (
                    <span className="text-sm text-stone-500 bg-stone-900 px-3 py-1.5 rounded-lg border border-stone-700">
                      Coming Soon
                    </span>
                  )}
                </div>
              ))
            )}
          </div>

          {googleConnected && (
            <div className="mt-4 bg-stone-950/35 border border-stone-700/45 rounded-xl p-4 flex items-center justify-between">
              <div>
                <h3 className="font-medium">Real-time email sync</h3>
                <p className="text-sm text-stone-400">
                  {gmailPushConfigured
                    ? gmailPushEnabled
                      ? gmailPushExpiresAt
                        ? `Gmail push active until ${new Date(gmailPushExpiresAt).toLocaleString()}. Auto-renews before expiry.`
                        : "Gmail push active. Auto-renews before expiry."
                      : "Subscribe to Gmail push notifications for instant delivery. Without this, EVE polls every minute."
                    : "Admin has not configured a Pub/Sub topic on the server. Contact the administrator to enable."}
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
                    {gmailPushLoading ? "…" : "Disable"}
                  </button>
                ) : (
                  <button
                    type="button"
                    onClick={enableGmailPush}
                    disabled={gmailPushLoading}
                    className="bg-amber-300 hover:bg-amber-200 disabled:opacity-50 text-stone-950 px-4 py-2 rounded-lg text-sm font-medium transition"
                  >
                    {gmailPushLoading ? "…" : "Enable"}
                  </button>
                )
              ) : (
                <span className="text-sm text-stone-500 bg-stone-900 px-3 py-1.5 rounded-lg border border-stone-700">
                  Unavailable
                </span>
              )}
            </div>
          )}
        </section>

        {/* Immediate Runs */}
        <section className="mb-8">
          <h2 className="text-sm font-semibold text-stone-300 mb-3">Immediate Runs</h2>
          <div className="space-y-3">
            <div className="bg-stone-950/35 border border-stone-700/45 rounded-xl p-4 flex items-center justify-between">
              <div>
                <h3 className="font-medium">Daily Briefing</h3>
                <p className="text-sm text-stone-400">
                  Generate a summary of your tasks, calendar, and emails
                </p>
              </div>
              <button
                type="button"
                onClick={generateBriefing}
                className="bg-stone-900 hover:bg-stone-700 text-stone-100 px-4 py-2 rounded-lg text-sm font-medium transition border border-stone-700"
              >
                Generate Now
              </button>
            </div>
          </div>
        </section>

        {/* Capabilities */}
        <section className="mb-8">
          <h2 className="text-sm font-semibold text-stone-300 mb-3">Execution Surface</h2>
          <div className="bg-stone-950/35 border border-stone-700/45 rounded-xl p-4 space-y-4">
            <div>
              <p className="text-xs text-amber-300 font-medium mb-2">Productivity</p>
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-1.5 text-sm text-stone-400">
                <p>Tasks — priorities, due dates, status tracking</p>
                <p>Notes — markdown, categories, search</p>
                <p>Reminders — timed alerts, snooze, presets</p>
                <p>Contacts — CRM, tags, avatar, search</p>
                <p>Document Writer — reports, proposals, drafts</p>
                <p>Daily Briefing — auto-generated summary</p>
              </div>
            </div>
            <div>
              <p className="text-xs text-green-400 font-medium mb-2">Communication</p>
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-1.5 text-sm text-stone-400">
                <p>Email — read, send, classify by priority</p>
                <p>Calendar — events, conflicts, scheduling</p>
                <p>Slack — messages, channels, threads</p>
                <p>Notion — pages, databases, search</p>
                <p>iMessage — send/read texts via macOS</p>
              </div>
            </div>
            <div>
              <p className="text-xs text-rose-300 font-medium mb-2">Meeting & Scheduling</p>
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-1.5 text-sm text-stone-400">
                <p>Auto-join — Google Meet, Zoom links</p>
                <p>Meeting Summary — key points, action items</p>
                <p>Calendar Conflicts — auto-detection</p>
              </div>
            </div>
            <div>
              <p className="text-xs text-teal-300 font-medium mb-2">macOS Native</p>
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-1.5 text-sm text-stone-400">
                <p>Clipboard — read/write copy-paste</p>
                <p>File Search — Spotlight search</p>
                <p>File Organizer — auto-sort Downloads</p>
                <p>Screenshot — capture screen</p>
                <p>System Info — battery, Wi-Fi, apps</p>
                <p>Web Search — research, news</p>
              </div>
            </div>
            <p className="text-xs text-stone-600 mt-1">
              Signal intake, approval workflows, memory, and connected work surfaces
            </p>
          </div>
        </section>

        {/* Data Management */}
        <section className="mb-8">
          <h2 className="text-sm font-semibold text-stone-300 mb-3">Data</h2>
          <div className="space-y-3">
            <Link
              href="/settings/status"
              className="flex items-center justify-between rounded-xl border border-stone-700/45 bg-stone-950/35 p-4 transition hover:border-stone-700 hover:bg-stone-950"
            >
              <div className="min-w-0">
                <h3 className="font-medium">EVE status</h3>
                <p className="text-sm text-stone-400">
                  Check deployment, push, reminders, briefing, and integrations
                </p>
              </div>
              <span className="ml-4 shrink-0 text-sm font-medium text-stone-400">Open →</span>
            </Link>
            <Link
              href="/settings/email-feedback"
              className="flex items-center justify-between rounded-xl border border-stone-700/45 bg-stone-950/35 p-4 transition hover:border-stone-700 hover:bg-stone-950"
            >
              <div className="min-w-0">
                <h3 className="font-medium">Email classification corrections</h3>
                <p className="text-sm text-stone-400">
                  {emailFeedbackCount === null
                    ? "Loading corrections..."
                    : `${emailFeedbackCount} corrections recorded`}
                </p>
              </div>
              <span className="ml-4 shrink-0 text-sm font-medium text-stone-400">Review →</span>
            </Link>
            <div className="bg-stone-950/35 border border-stone-700/45 rounded-xl p-4 flex items-center justify-between">
              <div>
                <h3 className="font-medium">Export Data</h3>
                <p className="text-sm text-stone-400">Download all your data as JSON</p>
              </div>
              <button
                type="button"
                onClick={exportData}
                className="bg-stone-900 hover:bg-stone-700 text-stone-100 px-4 py-2 rounded-lg text-sm font-medium transition border border-stone-700"
              >
                Export
              </button>
            </div>
          </div>
        </section>

        {/* Data Reset */}
        <section className="mb-8">
          <h2 className="text-sm font-semibold text-red-300 mb-3">Data Reset</h2>
          <div className="bg-stone-950 border border-red-900/50 rounded-lg p-4 flex items-center justify-between">
            <div>
              <h3 className="font-medium">Delete All Data</h3>
              <p className="text-sm text-stone-400">
                Permanently delete all conversations, tasks, notes, contacts, and reminders
              </p>
            </div>
            <button
              type="button"
              onClick={clearAllData}
              className="bg-red-600/20 hover:bg-red-600 text-red-400 hover:text-white px-4 py-2 rounded-lg text-sm font-medium transition border border-red-900/50"
            >
              Delete All
            </button>
          </div>
        </section>

        {/* About */}
        <section>
          <h2 className="text-sm font-semibold text-stone-300 mb-3">About</h2>
          <div className="bg-stone-950/35 border border-stone-700/45 rounded-xl p-4">
            <p className="text-sm text-stone-400">
              <span className="text-amber-300 font-medium">EVE</span> · Decision OS for Work
            </p>
            <p className="text-sm text-stone-500 mt-1">
              Built for operators who need fewer scattered tabs and clearer next decisions.
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
