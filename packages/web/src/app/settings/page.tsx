"use client";

import Link from "next/link";
import { Suspense, useEffect, useState } from "react";
import AuthGuard from "../../components/auth-guard";
import { useConfirm } from "../../components/confirm-dialog";
import { FeedbackPolicyPanel } from "../../components/feedback-policy-panel";
import { GitHubSection } from "../../components/github-section";
import { GoogleConnectRedirect } from "../../components/google-connect-redirect";
import { NaverImapSection } from "../../components/naver-imap-section";
import { OAuthErrorBanner } from "../../components/oauth-error-banner";
import { ListSkeleton } from "../../components/skeleton";
import { TelegramSection } from "../../components/telegram-section";
import { useToast } from "../../components/toast";
import { API_BASE, apiFetch, authHeaders, startGoogleConnect } from "../../lib/api";
import { useAuth } from "../../lib/auth";
import {
  fetchVapidKey,
  getOrCreatePushSubscription,
  getSwRegistration,
  registerSubscriptionWithServer,
  unregisterPushSubscription,
} from "../../lib/push";
import { captureClientError } from "../../lib/sentry";
import {
  type AgentMode,
  type AgentModeOption,
  type ApiAgentModeOption,
  agentModeClasses,
  agentModeDescription,
  agentModeLabel,
  agentModeToast,
  DEFAULT_AGENT_MODE_OPTIONS,
  normalizeAgentMode,
  normalizeAgentModeOptions,
  TIMEZONES,
} from "./agent-mode-helpers";

const PROFILE_KEY = "klorn-profile";
const LEGACY_KEY_PREFIX = "ev" + "e";
const LEGACY_PROFILE_KEY = `${LEGACY_KEY_PREFIX}-profile`;
const PINNED_CHATS_KEY = "klorn-pinned-chats";
const LEGACY_PINNED_CHATS_KEY = `${LEGACY_KEY_PREFIX}-pinned-chats`;

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
  const [alwaysAllowedTools, setAlwaysAllowedTools] = useState<string[]>([]);
  const [autoMarkReadEnabled, setAutoMarkReadEnabled] = useState(false);
  const [proactiveActionsEnabled, setProactiveActionsEnabled] = useState(false);
  const [phoneEscalationEnabled, setPhoneEscalationEnabled] = useState(false);
  const [preApprovableTools, setPreApprovableTools] = useState<string[]>([]);
  const [notifPrefs, setNotifPrefs] = useState({
    notifyEmailUrgent: true,
    notifyMeeting: true,
    notifyTaskDue: true,
    notifyAgentProposal: true,
    notifyDailyBriefing: true,
    notifyEmailCandidate: true,
    quietHoursStart: "" as string | null,
    quietHoursEnd: "" as string | null,
  });
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
  const [gmailPushConfigured, setGmailPushConfigured] = useState(false);
  const [gmailPushEnabled, setGmailPushEnabled] = useState(false);
  const [gmailPushExpiresAt, setGmailPushExpiresAt] = useState<string | null>(null);
  const [gmailPushLoading, setGmailPushLoading] = useState(false);
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
          const publicKey = await fetchVapidKey();
          if (!publicKey) return;
          const reg = await getSwRegistration();
          const sub = await getOrCreatePushSubscription(reg, publicKey);
          await registerSubscriptionWithServer(sub).catch(() => {});
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
      const stored = localStorage.getItem(PROFILE_KEY) || localStorage.getItem(LEGACY_PROFILE_KEY);
      if (stored) {
        localStorage.setItem(PROFILE_KEY, stored);
        localStorage.removeItem(LEGACY_PROFILE_KEY);
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
    localStorage.setItem(PROFILE_KEY, JSON.stringify(profile));
    try {
      await apiFetch("/api/automations", {
        method: "PATCH",
        body: JSON.stringify({ timezone: profile.timezone }),
      });
    } catch {
      // Profile still saves locally; automation timezone can be retried later.
    }
    setProfileSaved(true);
    toast("Profile saved.", "success");
    setTimeout(() => setProfileSaved(false), 2000);
  };

  const enablePush = async () => {
    if (!("Notification" in window)) {
      toast("This browser does not support notifications.", "error");
      return;
    }
    const permission = await Notification.requestPermission();
    setPushStatus(permission as "granted" | "denied" | "default");
    if (permission === "granted") {
      try {
        const publicKey = await fetchVapidKey();
        if (publicKey) {
          const reg = await getSwRegistration();
          const sub = await getOrCreatePushSubscription(reg, publicKey);
          await registerSubscriptionWithServer(sub);
          toast("macOS notifications enabled.", "success");
        }
      } catch (err) {
        console.error("[PUSH-SETTINGS] Error:", err);
        toast("Push registration failed.", "error");
      }
    } else if (permission === "denied") {
      toast("Notifications are blocked. Allow them in browser settings.", "error");
    }
  };

  const disablePush = async () => {
    await unregisterPushSubscription();
    setPushStatus("default");
    toast("Push notifications disabled.", "info");
  };

  const changePassword = async () => {
    if (!currentPassword || !newPassword) return;
    if (newPassword.length < 6) {
      toast("Password must be at least 6 characters.", "error");
      return;
    }
    setPasswordLoading(true);
    try {
      await apiFetch("/api/auth/change-password", {
        method: "POST",
        body: JSON.stringify({ currentPassword, newPassword }),
      });
      toast("Password changed.", "success");
      setCurrentPassword("");
      setNewPassword("");
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Failed.";
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
      toast("Password must be at least 6 characters.", "error");
      return;
    }
    setPasswordLoading(true);
    try {
      await apiFetch("/api/auth/set-password", {
        method: "POST",
        body: JSON.stringify({ newPassword }),
      });
      toast("Password set.", "success");
      setNewPassword("");
      setHasPassword(true);
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Failed.";
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
      message: "Remove Gmail and Calendar access. You can reconnect at any time.",
      confirmLabel: "Disconnect",
      danger: true,
    });
    if (!ok) return;
    try {
      const res = await fetch(`${API_BASE}/api/auth/google`, {
        method: "DELETE",
        headers: authHeaders(),
      });
      // fetch only rejects on network failure, not on 4xx/5xx — without this
      // guard a failed disconnect still flipped the UI to "disconnected" and
      // toasted success while the server kept the Google grant.
      if (!res.ok) {
        const body = await res.json().catch(() => ({ error: "Request failed." }));
        toast(body.error || "Could not disconnect Google.", "error");
        return;
      }
      setGoogleConnected(false);
      setGmailPushEnabled(false);
      setGmailPushExpiresAt(null);
      toast("Google disconnected.", "info");
    } catch {
      toast("Could not disconnect Google.", "error");
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
        const body = await res.json().catch(() => ({ error: "Request failed." }));
        toast(body.error || "Could not enable real-time sync.", "error");
        return;
      }
      const data = (await res.json()) as { expiration?: string };
      setGmailPushEnabled(true);
      if (data.expiration) {
        setGmailPushExpiresAt(new Date(Number(data.expiration)).toISOString());
      }
      toast("Real-time mail sync enabled.", "success");
    } catch {
      toast("Could not enable real-time sync.", "error");
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
        const body = await res.json().catch(() => ({ error: "Request failed." }));
        toast(body.error || "Could not disable real-time sync.", "error");
        return;
      }
      setGmailPushEnabled(false);
      setGmailPushExpiresAt(null);
      toast("Real-time mail sync disabled. Scheduled checks will continue.", "info");
    } catch {
      toast("Could not disable real-time sync.", "error");
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
      notifyEmailCandidate?: boolean;
      timezone?: string;
      quietHoursStart?: string | null;
      quietHoursEnd?: string | null;
      proactiveActions?: boolean;
      phoneEscalationEnabled?: boolean;
    }>("/api/automations")
      .then((d) => {
        setProactiveActionsEnabled(d.proactiveActions ?? false);
        setPhoneEscalationEnabled(d.phoneEscalationEnabled ?? false);
        setAgentEnabled(d.autonomousAgent ?? false);
        setAgentMode(normalizeAgentMode(d.agentMode));
        setAgentModeOptions(normalizeAgentModeOptions(d.agentModes));
        setAgentInterval(d.agentIntervalMin ?? 5);
        setDailyBriefingEnabled(d.dailyBriefing ?? true);
        setBriefingTime(d.briefingTime ?? "06:00");
        setAlwaysAllowedTools(Array.isArray(d.alwaysAllowedTools) ? d.alwaysAllowedTools : []);
        setPreApprovableTools(Array.isArray(d.preApprovableTools) ? d.preApprovableTools : []);
        setAutoMarkReadEnabled(d.autoMarkReadEnabled ?? false);
        if (d.timezone) setProfile((p) => ({ ...p, timezone: d.timezone ?? p.timezone }));
        setNotifPrefs({
          notifyEmailUrgent: d.notifyEmailUrgent ?? true,
          notifyMeeting: d.notifyMeeting ?? true,
          notifyTaskDue: d.notifyTaskDue ?? true,
          notifyAgentProposal: d.notifyAgentProposal ?? true,
          notifyDailyBriefing: d.notifyDailyBriefing ?? true,
          notifyEmailCandidate: d.notifyEmailCandidate ?? true,
          quietHoursStart: d.quietHoursStart ?? null,
          quietHoursEnd: d.quietHoursEnd ?? null,
        });
      })
      .catch((err) => captureClientError(err, { scope: "settings.load-automation-config" }));
  }, []);

  const updateAutoMarkRead = async (value: boolean) => {
    if (value) {
      const ok = await confirm({
        title: "Auto-mark Gmail as read?",
        message:
          "After Klorn sends an approved auto-mode reply, the original Gmail thread can be marked as read. Keep this off if unread mail is part of your fallback workflow.",
        confirmLabel: "Turn on",
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
      toast("Could not save setting.", "error");
    }
  };

  const updatePhoneEscalation = async (value: boolean) => {
    setPhoneEscalationEnabled(value);
    try {
      await apiFetch("/api/automations", {
        method: "PATCH",
        body: JSON.stringify({ phoneEscalationEnabled: value }),
      });
      toast(value ? "Phone escalation enabled." : "Phone escalation disabled.", "success");
    } catch {
      setPhoneEscalationEnabled(!value);
      toast("Could not save setting.", "error");
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
      toast("Could not save setting.", "error");
    }
  };

  const updateDailyBriefing = async (enabled: boolean) => {
    setDailyBriefingEnabled(enabled);
    try {
      await apiFetch("/api/automations", {
        method: "PATCH",
        body: JSON.stringify({ dailyBriefing: enabled }),
      });
      toast(enabled ? "Daily briefing enabled." : "Daily briefing disabled.", "success");
    } catch {
      setDailyBriefingEnabled(!enabled);
      toast("Could not save briefing setting.", "error");
    }
  };

  const updateBriefingTime = async (value: string) => {
    setBriefingTime(value);
    try {
      await apiFetch("/api/automations", {
        method: "PATCH",
        body: JSON.stringify({ briefingTime: value, timezone: profile.timezone }),
      });
      toast("Briefing time saved.", "success");
    } catch {
      toast("Could not save briefing time.", "error");
    }
  };

  const toggleAlwaysAllowedTool = async (tool: string) => {
    const isEnabling = !alwaysAllowedTools.includes(tool);
    if (isEnabling) {
      const ok = await confirm({
        title: "Allow this tool to run automatically?",
        message: `${tool} can run without a separate approval when Auto mode decides it is within policy. Mail replies and destructive actions still require approval.`,
        confirmLabel: "Allow tool",
      });
      if (!ok) return;
    }
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
      if (Array.isArray(updated.alwaysAllowedTools))
        setAlwaysAllowedTools(updated.alwaysAllowedTools);
    } catch (err) {
      setAlwaysAllowedTools(previous);
      toast(`Update failed: ${err instanceof Error ? err.message : "Error"}`, "error");
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
      setAgentLogs(Array.isArray(data.logs) ? data.logs : []);
    } catch {
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
    } catch {
      setLearnedPatterns([]);
      setPatternsLoaded(true);
    }
    setPatternsLoading(false);
  };

  const toggleAgent = async (enabled: boolean) => {
    setAgentEnabled(enabled);
    try {
      await apiFetch("/api/automations", {
        method: "PATCH",
        body: JSON.stringify({ autonomousAgent: enabled }),
      });
      toast(enabled ? "Decision agent enabled." : "Decision agent disabled.", "success");
    } catch {
      setAgentEnabled(!enabled);
      toast("Could not update.", "error");
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
      toast("Could not save check interval.", "error");
    }
  };

  const [runningAgent, setRunningAgent] = useState(false);
  const runAgentNow = async () => {
    setRunningAgent(true);
    try {
      await apiFetch<{ triggered: boolean }>("/api/automations/run-now", { method: "POST" });
      toast("Agent run started. Check the decision queue for results.", "success");
    } catch {
      toast("Could not run the agent.", "error");
    } finally {
      setRunningAgent(false);
    }
  };

  const toggleAgentMode = async (mode: AgentMode) => {
    if (mode === "AUTO" && agentMode !== "AUTO") {
      const ok = await confirm({
        title: "Switch to Auto mode?",
        message:
          "Klorn can run low-risk internal actions automatically. External replies, calendar changes, destructive work, and anything outside policy still require approval.",
        confirmLabel: "Use Auto mode",
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
      toast("Could not save mode.", "error");
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

  const integrations: Integration[] = [
    {
      name: "Google",
      description: "Reads Gmail and Calendar signals and connects them to meeting prep.",
      connected: googleConnected,
      connectUrl: "google-oauth-start",
      statusUrl: `${API_BASE}/api/auth/google/status`,
    },
    {
      name: "Slack",
      description: slackConnected
        ? `Connected via ${slackMode === "bot_token" ? "bot token" : "webhook"}`
        : "An admin must set SLACK_BOT_TOKEN or SLACK_WEBHOOK_URL.",
      connected: slackConnected,
      connectUrl: slackConnected ? undefined : "slack-admin-only",
      statusUrl: `${API_BASE}/api/slack/status`,
    },
    {
      name: "Notion",
      description: "Prepares page search, document drafts, and database access.",
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
        toast("Slack test message sent.", "success");
      } else {
        const body = await res.json().catch(() => ({}));
        toast(body.error || "Could not send test message.", "error");
      }
    } catch {
      toast("Could not send test message.", "error");
    } finally {
      setSlackTesting(false);
    }
  };

  const generateBriefing = async () => {
    try {
      const res = await fetch(`${API_BASE}/api/briefing/generate`, {
        method: "POST",
        headers: authHeaders(),
        body: JSON.stringify({}),
      });
      // Without these guards a 5xx (or a Render dyno HTML body) either threw an
      // unhandled rejection or fell through to a fake "success" toast.
      if (!res.ok) {
        const body = await res.json().catch(() => ({ error: "Request failed." }));
        toast(body.error || "Could not generate briefing.", "error");
        return;
      }
      const data = await res.json();
      toast(data.briefing || "Briefing generated. Review it on the briefing screen.", "success");
    } catch {
      toast("Could not generate briefing.", "error");
    }
  };

  const clearAllData = async () => {
    const ok = await confirm({
      title: "Delete workspace data",
      message:
        "Delete all decision threads, tasks, memories, contacts, and reminders. This cannot be undone.",
      confirmLabel: "Delete workspace",
      danger: true,
    });
    if (!ok) return;
    try {
      const res = await fetch(`${API_BASE}/api/user/me/data`, {
        method: "DELETE",
        headers: authHeaders(),
      });
      // Don't falsely tell the user their data was deleted (and wipe local
      // profile state) when the server-side delete actually failed.
      if (!res.ok) {
        const body = await res.json().catch(() => ({ error: "Request failed." }));
        toast(body.error || "Could not delete workspace data.", "error");
        return;
      }
      localStorage.removeItem(PROFILE_KEY);
      localStorage.removeItem(PINNED_CHATS_KEY);
      toast("Workspace data deleted.", "info");
    } catch {
      toast("Could not delete workspace data.", "error");
    }
  };

  const exportData = async () => {
    try {
      const res = await fetch(`${API_BASE}/api/user/me/export`, { headers: authHeaders() });
      // Without this guard a 500's error JSON gets written into the downloaded
      // export file and the user is told the export succeeded.
      if (!res.ok) {
        const body = await res.json().catch(() => ({ error: "Request failed." }));
        toast(body.error || "Data export failed.", "error");
        return;
      }
      const data = await res.json();
      const blob = new Blob([JSON.stringify(data, null, 2)], { type: "application/json" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `klorn-export-${new Date().toISOString().slice(0, 10)}.json`;
      a.click();
      URL.revokeObjectURL(url);
      toast("Data exported.", "success");
    } catch {
      toast("Data export failed.", "error");
    }
  };

  return (
    <AuthGuard>
      <Suspense>
        <GoogleConnectRedirect />
      </Suspense>
      <main className="mx-auto max-w-4xl px-4 pb-28 pt-6 sm:px-6 md:py-10">
        <header className="mb-6 rounded-2xl border border-stone-700/45 bg-stone-950/35 p-5 shadow-sm shadow-black/20">
          <p className="text-xs font-semibold uppercase tracking-[0.24em] text-amber-300">
            Control panel
          </p>
          <h1 className="mt-3 text-2xl font-semibold tracking-tight text-stone-50 md:text-3xl">
            Klorn execution boundaries and access
          </h1>
          <p className="mt-2 max-w-3xl text-sm leading-6 text-stone-400">
            Tune profile, notifications, execution mode, and data access in one compact place.
          </p>
        </header>

        {/* Profile */}
        <section className="mb-8">
          <h2 className="text-sm font-semibold text-stone-300 mb-3">Operator profile</h2>
          <div className="bg-stone-950/35 border border-stone-700/45 rounded-xl p-5 space-y-4">
            <div>
              <label htmlFor="profile-name" className="block text-sm text-stone-400 mb-1">
                Display name
              </label>
              <input
                id="profile-name"
                type="text"
                value={profile.name}
                onChange={(e) => setProfile((p) => ({ ...p, name: e.target.value }))}
                placeholder="Name"
                className="w-full bg-stone-900 border border-stone-700 rounded-lg px-4 py-2.5 text-sm focus:outline-none focus:border-amber-300 transition placeholder-stone-500"
              />
            </div>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
              <div>
                <label htmlFor="profile-lang" className="block text-sm text-stone-400 mb-1">
                  Response language
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
                  Time zone
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
                {profileSaved ? "Saved" : "Save profile"}
              </button>
            </div>
          </div>
        </section>

        {/* Security */}
        <section className="mb-8">
          <h2 className="text-sm font-semibold text-stone-300 mb-3">Access security</h2>
          <div className="bg-stone-950/35 border border-stone-700/45 rounded-xl p-5 space-y-4">
            {hasPassword ? (
              <>
                <div>
                  <label htmlFor="current-pw" className="block text-sm text-stone-400 mb-1">
                    Current password
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
                    New password
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
                    {passwordLoading ? "Changing..." : "Change password"}
                  </button>
                </div>
              </>
            ) : (
              <>
                <p className="text-sm text-stone-400">
                  You are signed in with Google. Set a password to also use email login.
                  <br />
                  <span className="text-stone-500">
                    Once saved, this account can sign in with email and password.
                  </span>
                </p>
                <div>
                  <label htmlFor="set-pw" className="block text-sm text-stone-400 mb-1">
                    New password
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
                    {passwordLoading ? "Saving..." : "Set password"}
                  </button>
                </div>
              </>
            )}
          </div>
        </section>

        {/* Notifications */}
        <section className="mb-8">
          <h2 className="text-sm font-semibold text-stone-300 mb-3">Signal rhythm</h2>
          <div className="mb-4 bg-stone-950/35 border border-stone-700/45 rounded-xl p-4 space-y-4">
            <div className="flex items-start justify-between gap-4">
              <div>
                <h3 className="font-medium">Morning briefing</h3>
                <p className="text-sm text-stone-400">
                  Sends one daily decision briefing in your time zone, even when you are away.
                </p>
                <p className="mt-1 text-xs text-stone-500">
                  Time zone: {profile.timezone}. Change it in the profile section above.
                </p>
              </div>
              <button
                type="button"
                onClick={() => updateDailyBriefing(!dailyBriefingEnabled)}
                className={`relative inline-flex min-h-11 min-w-14 shrink-0 items-center rounded-full transition-colors ${
                  dailyBriefingEnabled ? "bg-amber-300" : "bg-stone-700"
                }`}
                role="switch"
                aria-checked={dailyBriefingEnabled}
                aria-label="Toggle morning briefing"
              >
                <span
                  className={`absolute left-1 h-6 w-6 rounded-full bg-white transition-transform ${
                    dailyBriefingEnabled ? "translate-x-6" : ""
                  }`}
                />
              </button>
            </div>
            <div className="flex items-center gap-3 border-t border-stone-800 pt-3">
              <label htmlFor="briefing-time" className="text-sm font-medium text-stone-200">
                Delivery time
              </label>
              <input
                id="briefing-time"
                type="time"
                value={briefingTime}
                disabled={!dailyBriefingEnabled}
                onChange={(e) => updateBriefingTime(e.target.value)}
                className="min-h-11 rounded border border-stone-700 bg-stone-900 px-3 py-2 text-sm text-stone-200 disabled:opacity-50"
              />
              <span className="text-xs text-stone-500">Default is 06:00.</span>
            </div>
          </div>
          <div className="bg-stone-950/35 border border-stone-700/45 rounded-xl p-4 flex items-center justify-between">
            <div>
              <h3 className="font-medium">Push notifications</h3>
              <p className="text-sm text-stone-400">
                {pushStatus === "unsupported"
                  ? "This browser does not support push notifications."
                  : pushStatus === "granted"
                    ? "On - receive reminders, briefings, and important mail alerts."
                    : pushStatus === "denied"
                      ? "Blocked by the browser. Allow notifications in browser settings."
                      : "Receive reminders, briefings, and important mail alerts."}
              </p>
            </div>
            {pushStatus === "unsupported" || pushStatus === "denied" ? (
              <span className="text-sm text-stone-500 bg-stone-900 px-3 py-1.5 rounded-lg border border-stone-700">
                {pushStatus === "denied" ? "Blocked" : "Unsupported"}
              </span>
            ) : pushStatus === "granted" ? (
              <button
                type="button"
                onClick={disablePush}
                className="min-h-11 rounded-lg border border-stone-700 bg-stone-900 px-4 py-2 text-sm font-medium text-stone-400 transition hover:bg-stone-700 hover:text-red-400"
              >
                Turn off
              </button>
            ) : (
              <button
                type="button"
                onClick={enablePush}
                className="min-h-11 rounded-lg bg-amber-300 px-4 py-2 text-sm font-medium text-stone-950 transition hover:bg-amber-200"
              >
                Turn on
              </button>
            )}
          </div>

          {/* Granular Notification Preferences */}
          <div className="mt-4 bg-stone-950/35 border border-stone-700/45 rounded-xl p-4 space-y-3">
            <div>
              <h3 className="font-medium">Which signals are worth interrupting you?</h3>
              <p className="text-xs text-stone-500 mt-0.5">
                Disabled categories stay quiet across push and in-app notifications.
              </p>
            </div>
            <div className="space-y-2">
              {[
                {
                  key: "notifyEmailUrgent" as const,
                  label: "Urgent mail",
                  desc: "New mail Klorn considers time-sensitive",
                },
                {
                  key: "notifyMeeting" as const,
                  label: "Meeting reminders",
                  desc: "Upcoming meetings and standup reminders",
                },
                {
                  key: "notifyTaskDue" as const,
                  label: "Due and overdue",
                  desc: "Task due-date reminders",
                },
                {
                  key: "notifyAgentProposal" as const,
                  label: "Agent proposals",
                  desc: "When Klorn needs approval before acting",
                },
                {
                  key: "notifyDailyBriefing" as const,
                  label: "Daily briefing",
                  desc: "Your daily decision briefing",
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
                Pause push notifications during this window. Leave blank for no limit.
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
            <div className="pt-3 border-t border-stone-800">
              <div className="flex items-start justify-between gap-4">
                <div>
                  <p className="text-sm font-medium text-stone-200">Phone escalation</p>
                  <p className="text-xs text-stone-500 mt-1">
                    Calls you once when an urgent notification goes unacknowledged for 5 minutes.
                    Max 3 calls/day. Quiet hours always win. Requires a verified phone number and
                    server-side Twilio setup.
                  </p>
                </div>
                <button
                  type="button"
                  onClick={() => updatePhoneEscalation(!phoneEscalationEnabled)}
                  className={`relative inline-flex min-h-11 min-w-14 shrink-0 items-center rounded-full transition-colors ${
                    phoneEscalationEnabled ? "bg-amber-300" : "bg-stone-700"
                  }`}
                  role="switch"
                  aria-checked={phoneEscalationEnabled}
                  aria-label="Toggle phone escalation"
                >
                  <span
                    className={`absolute left-1 h-6 w-6 rounded-full bg-white transition-transform ${
                      phoneEscalationEnabled ? "translate-x-6" : ""
                    }`}
                  />
                </button>
              </div>
            </div>
          </div>
        </section>

        {/* Decision Agent */}
        <section className="mb-8">
          <h2 className="text-sm font-semibold text-stone-300 mb-3">Decision agent</h2>
          <div className="bg-stone-950/35 border border-stone-700/45 rounded-xl p-5 space-y-4">
            <div className="flex items-center justify-between">
              <div>
                <h3 className="font-medium">Execution boundary</h3>
                <p className="text-sm text-stone-400">
                  Let Klorn watch work, calendar, and mail in the background within approval limits.
                </p>
              </div>
              <button
                type="button"
                onClick={() => toggleAgent(!agentEnabled)}
                className={`relative inline-flex min-h-11 min-w-14 items-center rounded-full transition-colors ${
                  agentEnabled ? "bg-amber-300" : "bg-stone-700"
                }`}
                role="switch"
                aria-checked={agentEnabled}
                aria-label="Toggle execution boundary"
              >
                <span
                  className={`absolute left-1 h-6 w-6 rounded-full bg-white transition-transform ${
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
                        className={`min-h-16 min-w-0 rounded-lg border px-3 py-2.5 text-sm transition ${agentModeClasses(
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
                    <p className="text-[10px] text-stone-400 mt-2">
                      Klorn quietly prepares drafts and approval-ready work, then queues it.
                    </p>
                  )}
                  {agentMode === "AUTO" && (
                    <p className="text-[10px] text-emerald-200/75 mt-2">
                      Low-risk internal work can run automatically. Replies, calendar changes, and
                      destructive work still require explicit approval.
                    </p>
                  )}
                </div>

                {/* Pre-approved tools — skip approval for specific MEDIUM-risk tools */}
                {agentMode === "AUTO" && preApprovableTools.length > 0 && (
                  <div>
                    <label className="block text-sm text-stone-400 mb-2">
                      Always-allowed tools
                    </label>
                    <div className="space-y-2">
                      {preApprovableTools.map((tool) => {
                        const enabled = alwaysAllowedTools.includes(tool);
                        return (
                          <button
                            key={tool}
                            type="button"
                            onClick={() => toggleAlwaysAllowedTool(tool)}
                            className={`flex min-h-11 w-full items-center justify-between rounded-lg border px-3 py-2 text-sm transition ${
                              enabled
                                ? "bg-amber-600/15 border-amber-500/40 text-amber-200"
                                : "bg-stone-900 border-stone-700 text-stone-400 hover:border-stone-600"
                            }`}
                            aria-pressed={enabled}
                          >
                            <span className="font-mono text-xs">{tool}</span>
                            <span className="text-[10px] opacity-80">
                              {enabled ? "Run within policy" : "Review first"}
                            </span>
                          </button>
                        );
                      })}
                    </div>
                    <p className="text-[10px] text-stone-500 mt-2">
                      Enabled tools still run only within policy. Mail replies and destructive work
                      cannot be pre-approved here.
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
                    className="min-h-11 rounded-lg border border-stone-700 bg-stone-900 px-4 py-2 text-sm transition focus:border-amber-300 focus:outline-none"
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
                    className={`flex min-h-11 w-full items-center justify-between rounded-lg border px-3 py-2 text-sm transition ${
                      autoMarkReadEnabled
                        ? "bg-emerald-500/15 border-emerald-400/40 text-emerald-200"
                        : "bg-stone-900 border-stone-700 text-stone-400 hover:border-stone-600"
                    }`}
                    aria-pressed={autoMarkReadEnabled}
                  >
                    <span>Auto-mark Gmail as read</span>
                    <span className="text-[10px] opacity-80">
                      {autoMarkReadEnabled ? "On" : "Off"}
                    </span>
                  </button>
                  <p className="text-[10px] text-stone-500 mt-1">
                    In auto mode, Klorn can mark the original Gmail thread as read after sending a
                    reply. Default is off so unread mail remains a fallback.
                  </p>
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
                          next
                            ? "Proactive alerts on — Klorn will notify you about unanswered emails, overdue tasks, and upcoming meetings."
                            : "Proactive alerts off.",
                          "success",
                        );
                      } catch {
                        setProactiveActionsEnabled(!next);
                        toast("Could not save setting.", "error");
                      }
                    }}
                    className={`flex min-h-11 w-full items-center justify-between rounded-lg border px-3 py-2 text-sm transition ${
                      proactiveActionsEnabled
                        ? "bg-amber-300/15 border-amber-300/40 text-amber-200"
                        : "bg-stone-900 border-stone-700 text-stone-400 hover:border-stone-600"
                    }`}
                    aria-pressed={proactiveActionsEnabled}
                  >
                    <span>Proactive alerts</span>
                    <span className="text-[10px] opacity-80">
                      {proactiveActionsEnabled ? "On" : "Off"}
                    </span>
                  </button>
                  <p className="text-[10px] text-stone-500 mt-1">
                    Klorn watches for unanswered emails, overdue tasks, upcoming meetings, and
                    follow-up opportunities — and alerts you before they slip.
                  </p>
                </div>

                <FeedbackPolicyPanel />

                {/* Run Now Button */}
                <div>
                  <button
                    type="button"
                    onClick={runAgentNow}
                    disabled={runningAgent}
                    className="min-h-11 rounded-lg bg-amber-300 px-4 py-2 text-sm font-medium text-stone-950 transition hover:bg-amber-200 disabled:opacity-50"
                  >
                    {runningAgent ? "Running..." : "Run agent now"}
                  </button>
                  <p className="text-[10px] text-stone-500 mt-1">
                    Check signals now without waiting for the next cycle.
                  </p>
                </div>
              </div>
            )}

            {/* Agent Activity Log */}
            <div>
              <button
                type="button"
                onClick={loadAgentLogs}
                className="inline-flex min-h-11 items-center text-sm text-amber-300 transition hover:text-amber-200"
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
                        <span className="text-xs text-stone-500 ml-3.5">Tool: {log.tool}</span>
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
                className="inline-flex min-h-11 items-center text-sm text-amber-300 transition hover:text-amber-200 disabled:opacity-50"
              >
                {patternsLoading
                  ? "Analyzing..."
                  : patternsLoaded
                    ? "Refresh learned patterns"
                    : "What has Klorn learned about you?"}
              </button>
              {patternsLoaded && (
                <div className="mt-3">
                  {learnedPatterns.length === 0 ? (
                    <p className="text-xs text-stone-500">
                      Not enough data yet — patterns emerge after a few days of use.
                    </p>
                  ) : (
                    <div className="space-y-2">
                      {learnedPatterns.slice(0, 8).map((p, i) => {
                        const confidenceLabel =
                          p.confidence >= 0.8 ? "HIGH" : p.confidence >= 0.5 ? "MED" : "LOW";
                        const typeColor =
                          p.type === "rejection"
                            ? "border-red-400/20 bg-red-400/5 text-red-300"
                            : p.type === "temporal"
                              ? "border-blue-400/20 bg-blue-400/5 text-blue-300"
                              : p.type === "tool_preference"
                                ? "border-emerald-400/20 bg-emerald-400/5 text-emerald-300"
                                : "border-amber-300/20 bg-amber-300/5 text-amber-300";
                        return (
                          <div
                            key={i}
                            className="bg-stone-900/60 border border-stone-700/40 rounded-lg px-3 py-2 text-sm flex items-start gap-2"
                          >
                            <span
                              className={`shrink-0 rounded border px-1 py-0.5 text-[10px] font-medium ${typeColor}`}
                            >
                              {confidenceLabel}
                            </span>
                            <span className="text-stone-300 flex-1">{p.description}</span>
                            <span className="shrink-0 text-[11px] text-stone-500">
                              {p.evidence}×
                            </span>
                          </div>
                        );
                      })}
                    </div>
                  )}
                </div>
              )}
            </div>
          </div>
        </section>

        {/* Integrations */}
        <section className="mb-8">
          <h2 className="text-sm font-semibold text-stone-300 mb-3">Connections</h2>
          <Suspense>
            <OAuthErrorBanner />
          </Suspense>
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
                      Admin setup
                    </span>
                  ) : int.connectUrl?.endsWith("-coming-soon") ? (
                    <span className="text-sm text-stone-500 bg-stone-900 px-3 py-1.5 rounded-lg border border-stone-700">
                      Coming soon
                    </span>
                  ) : int.connectUrl === "google-oauth-start" ? (
                    <button
                      type="button"
                      onClick={() => {
                        void startGoogleConnect();
                      }}
                      className="bg-amber-300 hover:bg-amber-200 text-stone-950 px-4 py-2 rounded-lg text-sm font-medium transition"
                    >
                      Connect
                    </button>
                  ) : int.connectUrl ? (
                    <a
                      href={int.connectUrl}
                      className="bg-amber-300 hover:bg-amber-200 text-stone-950 px-4 py-2 rounded-lg text-sm font-medium transition"
                    >
                      Connect
                    </a>
                  ) : (
                    <span className="text-sm text-stone-500 bg-stone-900 px-3 py-1.5 rounded-lg border border-stone-700">
                      Coming soon
                    </span>
                  )}
                </div>
              ))
            )}
          </div>

          {googleConnected && (
            <div className="mt-4 bg-stone-950/35 border border-stone-700/45 rounded-xl p-4 flex items-center justify-between">
              <div>
                <h3 className="font-medium">Real-time mail sync</h3>
                <p className="text-sm text-stone-400">
                  {gmailPushConfigured
                    ? gmailPushEnabled
                      ? gmailPushExpiresAt
                        ? `Gmail push is active until ${new Date(gmailPushExpiresAt).toLocaleString()}. It renews automatically before expiration.`
                        : "Gmail push is active and renews automatically before expiration."
                      : "Subscribe to Gmail push so mail signals arrive immediately. If off, Klorn checks every minute."
                    : "The server Pub/Sub topic is not configured yet. Ask an admin to enable it."}
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
                    {gmailPushLoading ? "..." : "Turn off"}
                  </button>
                ) : (
                  <button
                    type="button"
                    onClick={enableGmailPush}
                    disabled={gmailPushLoading}
                    className="bg-amber-300 hover:bg-amber-200 disabled:opacity-50 text-stone-950 px-4 py-2 rounded-lg text-sm font-medium transition"
                  >
                    {gmailPushLoading ? "..." : "Turn on"}
                  </button>
                )
              ) : (
                <span className="text-sm text-stone-500 bg-stone-900 px-3 py-1.5 rounded-lg border border-stone-700">
                  Unavailable
                </span>
              )}
            </div>
          )}

          {/* Telegram channel */}
          <TelegramSection />

          {/* GitHub notifications source */}
          <GitHubSection />
        </section>

        {/* Naver Mail (IMAP) */}
        <section className="mb-8">
          <NaverImapSection />
        </section>

        {/* Manual Runs */}
        <section className="mb-8">
          <h2 className="text-sm font-semibold text-stone-300 mb-3">Manual runs</h2>
          <div className="space-y-3">
            <div className="bg-stone-950/35 border border-stone-700/45 rounded-xl p-4 flex items-center justify-between">
              <div>
                <h3 className="font-medium">Daily briefing</h3>
                <p className="text-sm text-stone-400">
                  Build a priority briefing from tasks, calendar, and mail signals.
                </p>
              </div>
              <button
                type="button"
                onClick={generateBriefing}
                className="bg-stone-900 hover:bg-stone-700 text-stone-100 px-4 py-2 rounded-lg text-sm font-medium transition border border-stone-700"
              >
                Generate briefing
              </button>
            </div>
          </div>
        </section>

        {/* Data Management */}
        <section className="mb-8">
          <h2 className="text-sm font-semibold text-stone-300 mb-3">Workspace data</h2>
          <div className="space-y-3">
            <div className="bg-stone-950/35 border border-stone-700/45 rounded-xl p-4 flex items-center justify-between">
              <div>
                <h3 className="font-medium">Export workspace data</h3>
                <p className="text-sm text-stone-400">
                  Download decision threads, signals, memory, and execution history as JSON.
                </p>
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

        {/* Workspace Reset */}
        <section className="mb-8">
          <h2 className="text-sm font-semibold text-red-300 mb-3">Workspace reset</h2>
          <div className="bg-stone-950 border border-red-900/50 rounded-lg p-4 flex items-center justify-between">
            <div>
              <h3 className="font-medium">Delete workspace data</h3>
              <p className="text-sm text-stone-400">
                Permanently delete decision threads, tasks, memories, contacts, and reminders.
              </p>
            </div>
            <button
              type="button"
              onClick={clearAllData}
              className="bg-red-600/20 hover:bg-red-600 text-red-400 hover:text-white px-4 py-2 rounded-lg text-sm font-medium transition border border-red-900/50"
            >
              Delete workspace
            </button>
          </div>
        </section>

        {/* About */}
        <section>
          <h2 className="text-sm font-semibold text-stone-300 mb-3">About</h2>
          <div className="bg-stone-950/35 border border-stone-700/45 rounded-xl p-4">
            <p className="text-sm text-stone-400">
              <span className="text-amber-300 font-medium">Klorn</span> · Decision OS
            </p>
            <p className="text-sm text-stone-500 mt-1">
              Built to reduce scattered tabs and make the next decision clearer.
            </p>
            <p className="text-xs text-stone-600 mt-3">v0.2.0 — MVP</p>
          </div>
        </section>
      </main>
    </AuthGuard>
  );
}
