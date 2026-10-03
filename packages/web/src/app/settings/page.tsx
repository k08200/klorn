"use client";

import Link from "next/link";
import { Suspense, useEffect, useState } from "react";
import { ApiKeysSection } from "../../components/api-keys-section";
import AppearanceSection from "../../components/appearance-section";
import AuthGuard from "../../components/auth-guard";
import { ByokKeysSection } from "../../components/byok-keys-section";
import { useConfirm } from "../../components/confirm-dialog";
import { FeedbackPolicyPanel } from "../../components/feedback-policy-panel";
import { GoogleConnectRedirect } from "../../components/google-connect-redirect";
import { ICloudImapSection } from "../../components/icloud-imap-section";
import InAppBrowserNotice from "../../components/in-app-browser-notice";
import { LinkedInboxesSection } from "../../components/linked-inboxes-section";
import { NaverImapSection } from "../../components/naver-imap-section";
import { OAuthErrorBanner } from "../../components/oauth-error-banner";
import { OutlookInboxesSection } from "../../components/outlook-inboxes-section";
import { RulesSection } from "../../components/rules-section";
import { ListSkeleton } from "../../components/skeleton";
import { SubscriptionSection } from "../../components/subscription-section";
import { TeamsSection } from "../../components/teams-section";
import { TelegramSection } from "../../components/telegram-section";
import { useToast } from "../../components/toast";
import Button from "../../components/ui/button";
import StatusChip from "../../components/ui/status-chip";
import Switch from "../../components/ui/switch";
import { API_BASE, apiFetch, authHeaders, startGoogleConnect } from "../../lib/api";
import { useAuth } from "../../lib/auth";
import { useT } from "../../lib/i18n";
import {
  fetchVapidKey,
  getOrCreatePushSubscription,
  getSwRegistration,
  registerSubscriptionWithServer,
  unregisterPushSubscription,
} from "../../lib/push";
import { captureClientError } from "../../lib/sentry";
import { toolLabelKey } from "../../lib/tool-labels";
import { track } from "../../lib/track";
import {
  type AgentMode,
  type AgentModeOption,
  type ApiAgentModeOption,
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

// v2 light-surface equivalents of agentModeClasses (the helper keeps the
// legacy dark palette; presentation-only mapping, same mode semantics).
function agentModeLightClasses(mode: AgentMode, active: boolean): string {
  if (!active) return "border-line bg-surface-panel/70 text-ink-mid hover:border-line-strong";
  if (mode === "SHADOW") return "border-line-strong bg-surface-hover text-ink-soft";
  if (mode === "AUTO") return "border-state-ok-line bg-state-ok-bg text-state-ok-ink";
  return "border-state-warn-line bg-state-warn-bg text-state-warn-ink";
}

// PRIMARY_BTN: kept only for the two spots ui/Button can't take over — an
// <a> styled as a button (Button only renders a <button> element) and the
// profile-save button, which swaps to a literal emerald "Saved" class that
// Button's variants don't model. Every other primary/secondary/danger
// button on this page now uses ui/Button directly.
const PRIMARY_BTN =
  "glow-primary ease-strong inline-flex min-h-10 items-center justify-center rounded-lg bg-accent-solid px-4 text-sm font-medium text-accent-solid-ink transition duration-150 hover:bg-accent-solid-hover active:scale-[0.97] disabled:cursor-not-allowed disabled:opacity-40";
const SECTION_TITLE = "mb-3 text-[11px] font-semibold uppercase tracking-wider text-ink-dim";
const PANEL = "panel-elevated rounded-2xl border border-line/70 bg-surface-panel";

export default function SettingsPage() {
  const [googleConnected, setGoogleConnected] = useState(false);
  const [notionConnected, setNotionConnected] = useState(false);
  const [loading, setLoading] = useState(true);
  const [profile, setProfile] = useState<UserProfile>({
    name: "",
    language: "en",
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
  // Reply tone and notification language were backend-supported and exposed in
  // the desktop app, but had no web UI — the same account showed different
  // settings depending on which client you opened.
  const [replyTone, setReplyTone] = useState("MATCH_ME");
  const [replyTones, setReplyTones] = useState<
    Array<{ tone: string; label: string; description: string }>
  >([]);
  // Ontology v2 auto mode: BASIC = notify important+meetings only, human
  // answers; AUTO = Klorn answers eligible mail per the guideline (send is
  // additionally server-flag-gated — the UI is honest about that below).
  const [attentionMode, setAttentionMode] = useState<"BASIC" | "AUTO">("BASIC");
  const [guidelineDraft, setGuidelineDraft] = useState("");
  const [guidelineDefault, setGuidelineDefault] = useState("");
  /// Last text the server is known to hold — used to put the box back when a
  /// CLEARING save fails, so an empty field can't read as "I cleared it" while
  /// the server still has the old guideline.
  const [guidelineSaved, setGuidelineSaved] = useState("");
  const [guidelineSaving, setGuidelineSaving] = useState(false);
  const [guidelineAdvice, setGuidelineAdvice] = useState<string | null>(null);
  const [adviceLoading, setAdviceLoading] = useState(false);
  const [notificationLanguage, setNotificationLanguage] = useState("en");
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
  const { t } = useT();

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
    // Persist language/timezone locally first so the UI preference always
    // sticks even if a server call below fails.
    localStorage.setItem(PROFILE_KEY, JSON.stringify(profile));
    // The storage event never fires in the writing tab — nudge the i18n
    // provider so the UI language flips immediately after Save.
    window.dispatchEvent(new Event("klorn-profile-updated"));

    // Name is server-owned (the load path reads it from user.name, not
    // localStorage), so a failed PATCH silently reverts the displayed name on
    // the next reload. Surface the failure instead of falsely toasting success.
    try {
      await apiFetch("/api/auth/me", {
        method: "PATCH",
        body: JSON.stringify({ name: profile.name }),
      });
    } catch (err) {
      captureClientError(err, { scope: "settings.save-profile-name" });
      toast(t("settings.toast.saveNameFailed"), "error");
      return;
    }
    try {
      await apiFetch("/api/automations", {
        method: "PATCH",
        body: JSON.stringify({ timezone: profile.timezone }),
      });
    } catch (err) {
      // Non-fatal: timezone is persisted locally and retried on the next save,
      // so we don't block the success toast — but log a signal rather than
      // swallow it (project rule; captureClientError consoles when Sentry off).
      captureClientError(err, { scope: "settings.save-profile-timezone" });
    }
    setProfileSaved(true);
    toast(t("settings.toast.profileSaved"), "success");
    setTimeout(() => setProfileSaved(false), 2000);
  };

  const enablePush = async () => {
    if (!("Notification" in window)) {
      toast(t("settings.toast.pushUnsupported"), "error");
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
          toast(t("settings.toast.pushEnabled"), "success");
        }
      } catch (err) {
        console.error("[PUSH-SETTINGS] Error:", err);
        toast(t("settings.toast.pushRegistrationFailed"), "error");
      }
    } else if (permission === "denied") {
      toast(t("settings.toast.pushBlocked"), "error");
    }
  };

  const disablePush = async () => {
    await unregisterPushSubscription();
    setPushStatus("default");
    // Retention analytics: turning push off entirely is the strongest churn
    // signal — track it so the dashboard surfaces mute rate.
    track("notif_muted", { scope: "all" });
    toast(t("settings.toast.pushDisabled"), "info");
  };

  const changePassword = async () => {
    if (!currentPassword || !newPassword) return;
    if (newPassword.length < 6) {
      toast(t("settings.toast.passwordMinLength"), "error");
      return;
    }
    setPasswordLoading(true);
    try {
      await apiFetch("/api/auth/change-password", {
        method: "POST",
        body: JSON.stringify({ currentPassword, newPassword }),
      });
      toast(t("settings.toast.passwordChanged"), "success");
      setCurrentPassword("");
      setNewPassword("");
    } catch (err) {
      const msg = err instanceof Error ? err.message : t("settings.toast.genericFailed");
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
      toast(t("settings.toast.passwordMinLength"), "error");
      return;
    }
    setPasswordLoading(true);
    try {
      await apiFetch("/api/auth/set-password", {
        method: "POST",
        body: JSON.stringify({ newPassword }),
      });
      toast(t("settings.toast.passwordSet"), "success");
      setNewPassword("");
      setHasPassword(true);
    } catch (err) {
      const msg = err instanceof Error ? err.message : t("settings.toast.genericFailed");
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
      title: t("settings.confirm.disconnectGoogle.title"),
      message: t("settings.confirm.disconnectGoogle.message"),
      confirmLabel: t("settings.confirm.disconnectGoogle.confirmLabel"),
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
        const body = await res.json().catch(() => ({ error: t("settings.toast.requestFailed") }));
        toast(body.error || t("settings.toast.googleDisconnectFailed"), "error");
        return;
      }
      setGoogleConnected(false);
      setGmailPushEnabled(false);
      setGmailPushExpiresAt(null);
      toast(t("settings.toast.googleDisconnected"), "info");
    } catch {
      toast(t("settings.toast.googleDisconnectFailed"), "error");
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
        const body = await res.json().catch(() => ({ error: t("settings.toast.requestFailed") }));
        toast(body.error || t("settings.toast.gmailPushEnableFailed"), "error");
        return;
      }
      const data = (await res.json()) as { expiration?: string };
      setGmailPushEnabled(true);
      if (data.expiration) {
        setGmailPushExpiresAt(new Date(Number(data.expiration)).toISOString());
      }
      toast(t("settings.toast.gmailPushEnabled"), "success");
    } catch {
      toast(t("settings.toast.gmailPushEnableFailed"), "error");
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
        const body = await res.json().catch(() => ({ error: t("settings.toast.requestFailed") }));
        toast(body.error || t("settings.toast.gmailPushDisableFailed"), "error");
        return;
      }
      setGmailPushEnabled(false);
      setGmailPushExpiresAt(null);
      toast(t("settings.toast.gmailPushDisabled"), "info");
    } catch {
      toast(t("settings.toast.gmailPushDisableFailed"), "error");
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
      replyTone?: string;
      replyTones?: Array<{ tone: string; label: string; description: string }>;
      notificationLanguage?: string;
      notificationLanguages?: string[];
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
      attentionMode?: string;
      autoReplyGuideline?: string | null;
      autoReplyGuidelineDefault?: string;
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
        setReplyTone(d.replyTone ?? "MATCH_ME");
        if (Array.isArray(d.replyTones) && d.replyTones.length > 0) setReplyTones(d.replyTones);
        setAttentionMode(d.attentionMode === "AUTO" ? "AUTO" : "BASIC");
        setGuidelineDefault(d.autoReplyGuidelineDefault ?? "");
        setGuidelineDraft(d.autoReplyGuideline ?? d.autoReplyGuidelineDefault ?? "");
        setGuidelineSaved(d.autoReplyGuideline ?? d.autoReplyGuidelineDefault ?? "");
        setNotificationLanguage(d.notificationLanguage ?? "en");
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

  const updatePhoneEscalation = async (value: boolean) => {
    setPhoneEscalationEnabled(value);
    try {
      await apiFetch("/api/automations", {
        method: "PATCH",
        body: JSON.stringify({ phoneEscalationEnabled: value }),
      });
      toast(
        value
          ? t("settings.toast.phoneEscalationEnabled")
          : t("settings.toast.phoneEscalationDisabled"),
        "success",
      );
    } catch {
      setPhoneEscalationEnabled(!value);
      toast(t("settings.toast.settingSaveFailed"), "error");
    }
  };

  const updateNotifPref = async (key: keyof typeof notifPrefs, value: boolean | string | null) => {
    const next = { ...notifPrefs, [key]: value };
    setNotifPrefs(next);
    // Retention analytics: a category toggled OFF is a partial mute signal.
    if (value === false) track("notif_muted", { scope: key });
    try {
      await apiFetch("/api/automations", {
        method: "PATCH",
        body: JSON.stringify({ [key]: value }),
      });
    } catch {
      toast(t("settings.toast.settingSaveFailed"), "error");
    }
  };

  const updateReplyTone = async (tone: string) => {
    const previous = replyTone;
    setReplyTone(tone);
    try {
      await apiFetch("/api/automations", {
        method: "PATCH",
        body: JSON.stringify({ replyTone: tone }),
      });
    } catch {
      setReplyTone(previous);
      toast(t("settings.toast.replyToneFailed"), "error");
    }
  };

  const updateAttentionMode = async (mode: "BASIC" | "AUTO") => {
    const previous = attentionMode;
    setAttentionMode(mode);
    try {
      await apiFetch("/api/automations", {
        method: "PATCH",
        body: JSON.stringify({ attentionMode: mode }),
      });
    } catch {
      setAttentionMode(previous);
      toast(t("settings.toast.attentionModeFailed"), "error");
    }
  };

  const saveGuideline = async () => {
    setGuidelineSaving(true);
    try {
      await apiFetch("/api/automations", {
        method: "PATCH",
        body: JSON.stringify({ autoReplyGuideline: guidelineDraft }),
      });
      toast(t("settings.toast.guidelineSaved"), "success");
      // Empty save = reset to the founder default (server stores null).
      const landed = guidelineDraft.trim() ? guidelineDraft : guidelineDefault;
      if (!guidelineDraft.trim() && guidelineDefault) setGuidelineDraft(guidelineDefault);
      setGuidelineSaved(landed);
    } catch {
      // A failed CLEARING save must not leave an empty box implying the
      // guideline is gone — restore what the server still holds. A failed
      // edit keeps the user's text so they can retry without retyping.
      if (!guidelineDraft.trim() && guidelineSaved) setGuidelineDraft(guidelineSaved);
      toast(t("settings.toast.guidelineFailed"), "error");
    } finally {
      setGuidelineSaving(false);
    }
  };

  const requestGuidelineAdvice = async () => {
    setAdviceLoading(true);
    setGuidelineAdvice(null);
    try {
      const res = await apiFetch<{ advice?: string }>("/api/automations/guideline-advice", {
        method: "POST",
        body: JSON.stringify({ guideline: guidelineDraft }),
      });
      if (res.advice) {
        setGuidelineAdvice(res.advice);
      } else {
        toast(t("settings.toast.adviceFailed"), "error");
      }
    } catch {
      toast(t("settings.toast.adviceFailed"), "error");
    } finally {
      setAdviceLoading(false);
    }
  };

  const updateNotificationLanguage = async (language: string) => {
    const previous = notificationLanguage;
    setNotificationLanguage(language);
    try {
      await apiFetch("/api/automations", {
        method: "PATCH",
        body: JSON.stringify({ notificationLanguage: language }),
      });
    } catch {
      setNotificationLanguage(previous);
      toast(t("settings.toast.notifLanguageFailed"), "error");
    }
  };

  /** One click for "only the things that actually need me": urgent mail and
   *  calendar. Matches the desktop app's Essentials-only preset — reaching the
   *  same state on the web meant toggling five checkboxes in the right order. */
  const applyEssentialsOnly = async () => {
    const next = {
      ...notifPrefs,
      notifyEmailUrgent: true,
      notifyMeeting: true,
      notifyTaskDue: false,
      notifyAgentProposal: false,
      notifyDailyBriefing: false,
      notifyEmailCandidate: false,
    };
    const previous = notifPrefs;
    setNotifPrefs(next);
    try {
      await apiFetch("/api/automations", {
        method: "PATCH",
        body: JSON.stringify({
          notifyEmailUrgent: true,
          notifyMeeting: true,
          notifyTaskDue: false,
          notifyAgentProposal: false,
          notifyDailyBriefing: false,
          notifyEmailCandidate: false,
        }),
      });
    } catch {
      setNotifPrefs(previous);
      toast(t("settings.toast.presetFailed"), "error");
    }
  };

  const updateDailyBriefing = async (enabled: boolean) => {
    setDailyBriefingEnabled(enabled);
    try {
      await apiFetch("/api/automations", {
        method: "PATCH",
        body: JSON.stringify({ dailyBriefing: enabled }),
      });
      toast(
        enabled ? t("settings.toast.briefingEnabled") : t("settings.toast.briefingDisabled"),
        "success",
      );
    } catch {
      setDailyBriefingEnabled(!enabled);
      toast(t("settings.toast.briefingSaveFailed"), "error");
    }
  };

  const updateBriefingTime = async (value: string) => {
    setBriefingTime(value);
    try {
      await apiFetch("/api/automations", {
        method: "PATCH",
        body: JSON.stringify({ briefingTime: value, timezone: profile.timezone }),
      });
      toast(t("settings.toast.briefingTimeSaved"), "success");
    } catch {
      toast(t("settings.toast.briefingTimeSaveFailed"), "error");
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

  const [runningAgent, setRunningAgent] = useState(false);
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
      apiFetch<{ configured: boolean }>("/api/notion/status")
        .then((d) => setNotionConnected(d.configured))
        .catch((err) => captureClientError(err, { scope: "settings.notion-status" })),
    ]).finally(() => setLoading(false));
  }, []);

  const integrations: Integration[] = [
    {
      name: "Google",
      description: t("settings.integration.google.desc"),
      connected: googleConnected,
      connectUrl: "google-oauth-start",
      statusUrl: `${API_BASE}/api/auth/google/status`,
    },
    {
      name: "Notion",
      description: t("settings.integration.notion.desc"),
      connected: notionConnected,
      connectUrl: notionConnected ? undefined : "notion-coming-soon",
      statusUrl: `${API_BASE}/api/notion/status`,
    },
  ];

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
        const body = await res.json().catch(() => ({ error: t("settings.toast.requestFailed") }));
        toast(body.error || t("settings.toast.briefingGenerateFailed"), "error");
        return;
      }
      const data = await res.json();
      toast(data.briefing || t("settings.toast.briefingGenerated"), "success");
    } catch {
      toast(t("settings.toast.briefingGenerateFailed"), "error");
    }
  };

  const clearAllData = async () => {
    const ok = await confirm({
      title: t("settings.confirm.deleteWorkspace.title"),
      message: t("settings.confirm.deleteWorkspace.message"),
      confirmLabel: t("settings.confirm.deleteWorkspace.confirmLabel"),
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
        const body = await res.json().catch(() => ({ error: t("settings.toast.requestFailed") }));
        toast(body.error || t("settings.toast.deleteWorkspaceFailed"), "error");
        return;
      }
      localStorage.removeItem(PROFILE_KEY);
      localStorage.removeItem(PINNED_CHATS_KEY);
      toast(t("settings.toast.workspaceDeleted"), "info");
    } catch {
      toast(t("settings.toast.deleteWorkspaceFailed"), "error");
    }
  };

  const deleteAccount = async () => {
    const ok = await confirm({
      title: t("settings.confirm.deleteAccount.title"),
      message: t("settings.confirm.deleteAccount.message"),
      confirmLabel: t("settings.confirm.deleteAccount.confirmLabel"),
      danger: true,
    });
    if (!ok) return;
    try {
      const res = await fetch(`${API_BASE}/api/auth/account`, {
        method: "DELETE",
        headers: authHeaders(),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({ error: t("settings.toast.requestFailed") }));
        toast(body.error || t("settings.toast.deleteAccountFailed"), "error");
        return;
      }
      // Wipe local session and leave the app entirely.
      localStorage.clear();
      window.location.href = "/login?deleted=1";
    } catch {
      toast(t("settings.toast.deleteAccountFailed"), "error");
    }
  };

  const exportData = async () => {
    try {
      const res = await fetch(`${API_BASE}/api/user/me/export`, { headers: authHeaders() });
      // Without this guard a 500's error JSON gets written into the downloaded
      // export file and the user is told the export succeeded.
      if (!res.ok) {
        const body = await res.json().catch(() => ({ error: t("settings.toast.requestFailed") }));
        toast(body.error || t("settings.toast.exportFailed"), "error");
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
      toast(t("settings.toast.exported"), "success");
    } catch {
      toast(t("settings.toast.exportFailed"), "error");
    }
  };

  return (
    <AuthGuard>
      <Suspense>
        <GoogleConnectRedirect />
      </Suspense>
      <div className="mx-auto max-w-4xl px-4 pb-28 pt-3 sm:px-6 md:py-10">
        {/* Flat v2 header — plain text on the canvas, no boxed hero. */}
        <header className="mb-8">
          <h1 className="text-[28px] font-semibold leading-none tracking-[-0.02em] text-ink">
            {t("settings.title")}
          </h1>
          <p className="mt-2 text-sm text-ink-mid">{t("settings.subtitle")}</p>
        </header>

        <SubscriptionSection />

        <TeamsSection
          wrapper={(children) => (
            <section className="mb-8">
              <h2 className={SECTION_TITLE}>{t("settings.section.teams")}</h2>
              <div className={`${PANEL} p-5`}>{children}</div>
            </section>
          )}
        />

        {/* Rules — tier pins in the user's own words */}
        <section className="mb-8">
          <h2 className={SECTION_TITLE}>{t("settings.section.rules")}</h2>
          <div className={`${PANEL} p-5`}>
            <RulesSection />
          </div>
        </section>

        {/* Profile */}
        <section className="mb-8">
          <h2 className={SECTION_TITLE}>{t("settings.section.appearance")}</h2>
          <div className={`${PANEL} p-5`}>
            <AppearanceSection />
          </div>
        </section>

        <section className="mb-8">
          <h2 className={SECTION_TITLE}>{t("settings.profile")}</h2>
          <div className={`${PANEL} p-5 space-y-4`}>
            <div>
              <label htmlFor="profile-name" className="block text-sm text-ink-mid mb-1">
                {t("settings.displayName")}
              </label>
              <input
                id="profile-name"
                type="text"
                value={profile.name}
                onChange={(e) => setProfile((p) => ({ ...p, name: e.target.value }))}
                placeholder={t("settings.namePlaceholder")}
                className="w-full bg-surface-raised border border-line rounded-lg px-4 py-2.5 text-sm focus:outline-none focus:border-accent-muted transition placeholder-ink-dim"
              />
            </div>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
              <div>
                <label htmlFor="profile-lang" className="block text-sm text-ink-mid mb-1">
                  {t("settings.language")}
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
                  className="w-full bg-surface-raised border border-line rounded-lg px-4 py-2.5 text-sm focus:outline-none focus:border-accent-muted transition"
                >
                  {/* Language names name themselves — "English"/"한국어" do not
                      change with the picked UI locale. */}
                  <option value="en">English</option>
                  <option value="ko">한국어</option>
                  <option value="ja">日本語</option>
                  <option value="zh">中文（简体）</option>
                  <option value="es">Español</option>
                  <option value="fr">Français</option>
                  <option value="de">Deutsch</option>
                </select>
              </div>
              <div>
                <label htmlFor="profile-tz" className="block text-sm text-ink-mid mb-1">
                  {t("settings.timezone")}
                </label>
                <select
                  id="profile-tz"
                  value={profile.timezone}
                  onChange={(e) => setProfile((p) => ({ ...p, timezone: e.target.value }))}
                  className="w-full bg-surface-raised border border-line rounded-lg px-4 py-2.5 text-sm focus:outline-none focus:border-accent-muted transition"
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
                className={
                  profileSaved
                    ? "ease-strong inline-flex min-h-10 items-center justify-center rounded-lg border border-state-ok-line bg-state-ok-bg px-4 text-sm font-medium text-state-ok-ink transition duration-150 active:scale-[0.97]"
                    : PRIMARY_BTN
                }
              >
                {profileSaved ? t("settings.saved") : t("settings.saveProfile")}
              </button>
            </div>
          </div>
        </section>

        {/* Security */}
        <section className="mb-8">
          <h2 className={SECTION_TITLE}>{t("settings.security")}</h2>
          <div className={`${PANEL} p-5 space-y-4`}>
            {hasPassword ? (
              <>
                <div>
                  <label htmlFor="current-pw" className="block text-sm text-ink-mid mb-1">
                    {t("settings.currentPassword")}
                  </label>
                  <input
                    id="current-pw"
                    type="password"
                    value={currentPassword}
                    onChange={(e) => setCurrentPassword(e.target.value)}
                    placeholder={t("settings.currentPassword")}
                    className="w-full bg-surface-raised border border-line rounded-lg px-4 py-2.5 text-sm focus:outline-none focus:border-accent-muted transition placeholder-ink-dim"
                  />
                </div>
                <div>
                  <label htmlFor="new-pw" className="block text-sm text-ink-mid mb-1">
                    {t("settings.newPassword")}
                  </label>
                  <input
                    id="new-pw"
                    type="password"
                    value={newPassword}
                    onChange={(e) => setNewPassword(e.target.value)}
                    placeholder={t("settings.newPasswordPlaceholder")}
                    minLength={6}
                    className="w-full bg-surface-raised border border-line rounded-lg px-4 py-2.5 text-sm focus:outline-none focus:border-accent-muted transition placeholder-ink-dim"
                  />
                </div>
                <div className="flex justify-end">
                  <Button
                    onClick={changePassword}
                    disabled={passwordLoading || !currentPassword || !newPassword}
                  >
                    {passwordLoading ? t("settings.changing") : t("settings.changePassword")}
                  </Button>
                </div>
              </>
            ) : (
              <>
                <p className="text-sm text-ink-mid">
                  {t("settings.oauthNoPassword.line1")}
                  <br />
                  <span className="text-ink-dim">{t("settings.oauthNoPassword.line2")}</span>
                </p>
                <div>
                  <label htmlFor="set-pw" className="block text-sm text-ink-mid mb-1">
                    {t("settings.newPassword")}
                  </label>
                  <input
                    id="set-pw"
                    type="password"
                    value={newPassword}
                    onChange={(e) => setNewPassword(e.target.value)}
                    placeholder={t("settings.newPasswordPlaceholder")}
                    minLength={6}
                    className="w-full bg-surface-raised border border-line rounded-lg px-4 py-2.5 text-sm focus:outline-none focus:border-accent-muted transition placeholder-ink-dim"
                  />
                </div>
                <div className="flex justify-end">
                  <Button onClick={setPasswordForOAuth} disabled={passwordLoading || !newPassword}>
                    {passwordLoading ? t("settings.saving") : t("settings.setPassword")}
                  </Button>
                </div>
              </>
            )}
          </div>
        </section>

        {/* Replies — register + the language Klorn's own notifications use.
            Both are backend settings the desktop app already exposed; the web
            had no picker, so the same account read differently per client. */}
        <section className="mb-8">
          <h2 className={SECTION_TITLE}>{t("settings.section.replies")}</h2>
          <div className={`${PANEL} divide-y divide-line-soft`}>
            <div className="p-5 space-y-3">
              <div>
                <label htmlFor="reply-tone" className="font-medium block">
                  {t("settings.field.replyTone")}
                </label>
                <p className="text-sm text-ink-mid">{t("settings.field.replyToneDesc")}</p>
              </div>
              <select
                id="reply-tone"
                value={replyTone}
                onChange={(e) => updateReplyTone(e.target.value)}
                className="min-h-11 w-full rounded-lg border border-line-strong bg-surface-panel px-3 py-2 text-sm text-ink focus:outline-none focus-visible:ring-2 focus-visible:ring-accent/35"
              >
                {(replyTones.length > 0
                  ? replyTones
                  : [
                      {
                        tone: "MATCH_ME",
                        label: t("settings.replyTone.matchMe.label"),
                        description: t("settings.replyTone.matchMe.desc"),
                      },
                      {
                        tone: "FORMAL",
                        label: t("settings.replyTone.formal.label"),
                        description: t("settings.replyTone.formal.desc"),
                      },
                      {
                        tone: "FRIENDLY",
                        label: t("settings.replyTone.friendly.label"),
                        description: t("settings.replyTone.friendly.desc"),
                      },
                      {
                        tone: "CASUAL",
                        label: t("settings.replyTone.casual.label"),
                        description: t("settings.replyTone.casual.desc"),
                      },
                    ]
                ).map((option) => (
                  <option key={option.tone} value={option.tone}>
                    {option.label} — {option.description}
                  </option>
                ))}
              </select>
            </div>
            <div className="p-5 space-y-3">
              <div>
                <label htmlFor="notification-language" className="font-medium block">
                  {t("settings.field.notificationLanguage")}
                </label>
                <p className="text-sm text-ink-mid">
                  {t("settings.field.notificationLanguageDesc")}
                </p>
              </div>
              <select
                id="notification-language"
                value={notificationLanguage}
                onChange={(e) => updateNotificationLanguage(e.target.value)}
                className="min-h-11 w-full rounded-lg border border-line-strong bg-surface-panel px-3 py-2 text-sm text-ink focus:outline-none focus-visible:ring-2 focus-visible:ring-accent/35"
              >
                {/* Language names name themselves, unaffected by UI locale. */}
                <option value="en">English</option>
                <option value="ko">한국어</option>
                <option value="ja">日本語</option>
                <option value="zh">中文（简体）</option>
                <option value="es">Español</option>
                <option value="fr">Français</option>
                <option value="de">Deutsch</option>
              </select>
            </div>
            <div className="p-5 space-y-3">
              <div>
                <span className="font-medium block">{t("settings.field.attentionMode")}</span>
                <p className="text-sm text-ink-mid">{t("settings.field.attentionModeDesc")}</p>
              </div>
              {/* aria-pressed toggles, not a role=radiogroup: the ARIA radio
                  pattern promises arrow-key navigation with a roving tabindex,
                  and claiming the role without it is worse for keyboard users
                  than not claiming it. Same pattern as the other pickers on
                  this page (always-allowed tools, auto-mark-read). */}
              <div className="grid grid-cols-2 gap-2">
                {(["BASIC", "AUTO"] as const).map((mode) => (
                  <button
                    key={mode}
                    type="button"
                    aria-pressed={attentionMode === mode}
                    onClick={() => updateAttentionMode(mode)}
                    className={`min-h-11 rounded-lg border px-3 py-2 text-left text-sm transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-accent/35 ${
                      attentionMode === mode
                        ? "border-accent/60 bg-accent/5 text-ink"
                        : "border-line-strong bg-surface-panel text-ink-mid hover:border-line-strong hover:text-ink"
                    }`}
                  >
                    <span className="font-medium block">
                      {mode === "BASIC"
                        ? t("settings.attentionMode.basic.label")
                        : t("settings.attentionMode.auto.label")}
                    </span>
                    <span className="text-xs text-ink-dim">
                      {mode === "BASIC"
                        ? t("settings.attentionMode.basic.desc")
                        : t("settings.attentionMode.auto.desc")}
                    </span>
                  </button>
                ))}
              </div>
              {attentionMode === "AUTO" && (
                <div className="space-y-2 pt-1">
                  <div>
                    <label htmlFor="auto-guideline" className="font-medium block text-sm">
                      {t("settings.field.autoGuideline")}
                    </label>
                    <p className="text-xs text-ink-dim">{t("settings.field.autoGuidelineDesc")}</p>
                  </div>
                  <textarea
                    id="auto-guideline"
                    value={guidelineDraft}
                    onChange={(e) => setGuidelineDraft(e.target.value)}
                    rows={5}
                    maxLength={2000}
                    className="w-full rounded-lg border border-line-strong bg-surface-panel px-3 py-2 text-sm text-ink focus:outline-none focus-visible:ring-2 focus-visible:ring-accent/35"
                  />
                  <div className="flex flex-wrap items-center gap-2">
                    <button
                      type="button"
                      onClick={saveGuideline}
                      disabled={guidelineSaving}
                      className="min-h-11 rounded-lg border border-accent/60 bg-accent/10 px-3 py-2 text-sm font-medium text-accent-deep hover:bg-accent/15 disabled:opacity-50 focus:outline-none focus-visible:ring-2 focus-visible:ring-accent/35"
                    >
                      {t("settings.action.saveGuideline")}
                    </button>
                    <button
                      type="button"
                      onClick={requestGuidelineAdvice}
                      disabled={adviceLoading || !guidelineDraft.trim()}
                      className="min-h-11 rounded-lg border border-line-strong bg-surface-panel px-3 py-2 text-sm text-ink-mid hover:text-ink disabled:opacity-50 focus:outline-none focus-visible:ring-2 focus-visible:ring-accent/35"
                    >
                      {adviceLoading
                        ? t("settings.action.guidelineAdviceLoading")
                        : t("settings.action.guidelineAdvice")}
                    </button>
                  </div>
                  {guidelineAdvice && (
                    <div className="rounded-lg border border-line bg-surface-raised p-3 text-sm text-ink-mid whitespace-pre-wrap">
                      {guidelineAdvice}
                    </div>
                  )}
                  <p className="text-xs text-ink-dim">{t("settings.autoMode.flagNote")}</p>
                </div>
              )}
            </div>
          </div>
        </section>

        {/* Notifications */}
        <section className="mb-8">
          <h2 className={SECTION_TITLE}>{t("settings.section.signalRhythm")}</h2>
          <div className={`${PANEL} divide-y divide-line-soft`}>
            <div className="p-5 space-y-4">
              <div className="flex items-start justify-between gap-4">
                <div>
                  <h3 className="font-medium">{t("settings.morningBriefing.title")}</h3>
                  <p className="text-sm text-ink-mid">{t("settings.morningBriefing.desc")}</p>
                  <p className="mt-1 text-xs text-ink-dim">
                    {t("settings.morningBriefing.timezoneNote", { timezone: profile.timezone })}
                  </p>
                </div>
                <Switch
                  checked={dailyBriefingEnabled}
                  onChange={(next) => updateDailyBriefing(next)}
                  label={t("settings.morningBriefing.title")}
                  hideLabel
                  className="shrink-0"
                />
              </div>
              <div className="flex items-center gap-3 border-t border-line-soft pt-3">
                <label htmlFor="briefing-time" className="text-sm font-medium text-ink">
                  {t("settings.field.deliveryTime")}
                </label>
                <input
                  id="briefing-time"
                  type="time"
                  value={briefingTime}
                  disabled={!dailyBriefingEnabled}
                  onChange={(e) => updateBriefingTime(e.target.value)}
                  className="min-h-11 rounded border border-line bg-surface-raised px-3 py-2 text-sm text-ink disabled:opacity-50"
                />
                <span className="text-xs text-ink-dim">
                  {t("settings.deliveryTime.defaultNote")}
                </span>
              </div>
            </div>
            <div className="p-5 flex items-center justify-between gap-4">
              <div>
                <h3 className="font-medium">{t("settings.pushNotifications.title")}</h3>
                <p className="text-sm text-ink-mid">
                  {pushStatus === "unsupported"
                    ? t("settings.pushNotifications.unsupported")
                    : pushStatus === "granted"
                      ? t("settings.pushNotifications.on")
                      : pushStatus === "denied"
                        ? t("settings.pushNotifications.blocked")
                        : t("settings.pushNotifications.off")}
                </p>
              </div>
              {pushStatus === "unsupported" || pushStatus === "denied" ? (
                <span className="text-sm text-ink-dim bg-surface-raised px-3 py-1.5 rounded-lg border border-line">
                  {pushStatus === "denied"
                    ? t("settings.pushNotifications.blockedChip")
                    : t("settings.pushNotifications.unsupportedChip")}
                </span>
              ) : pushStatus === "granted" ? (
                <Button variant="secondary" onClick={disablePush}>
                  {t("settings.turnOff")}
                </Button>
              ) : (
                <Button onClick={enablePush}>{t("settings.turnOn")}</Button>
              )}
            </div>

            {/* Granular Notification Preferences */}
            <div className="p-5 space-y-3">
              <fieldset className="space-y-2">
                <legend className="w-full">
                  <span className="block font-medium text-ink">
                    {t("settings.notifPrefs.legend")}
                  </span>
                  <span className="mt-0.5 block text-xs text-ink-mid">
                    {t("settings.notifPrefs.legendDesc")}
                  </span>
                </legend>
                <div className="flex flex-wrap items-center gap-2 pb-2">
                  <button
                    type="button"
                    onClick={applyEssentialsOnly}
                    aria-pressed={
                      notifPrefs.notifyEmailUrgent &&
                      notifPrefs.notifyMeeting &&
                      !notifPrefs.notifyTaskDue &&
                      !notifPrefs.notifyAgentProposal &&
                      !notifPrefs.notifyDailyBriefing &&
                      !notifPrefs.notifyEmailCandidate
                    }
                    className="ease-strong min-h-11 rounded-lg border border-line-strong px-3 py-2 text-sm text-ink-soft transition duration-150 hover:bg-surface-hover active:scale-[0.97] focus:outline-none focus-visible:ring-2 focus-visible:ring-accent/35 aria-pressed:border-accent aria-pressed:text-accent-deep"
                  >
                    {t("settings.notifPrefs.essentialsOnly")}
                  </button>
                  <span className="text-xs text-ink-mid">
                    {t("settings.notifPrefs.essentialsOnlyDesc")}
                  </span>
                </div>
                {[
                  {
                    key: "notifyEmailUrgent" as const,
                    label: t("settings.notifPrefs.urgentMail.label"),
                    desc: t("settings.notifPrefs.urgentMail.desc"),
                  },
                  {
                    key: "notifyMeeting" as const,
                    label: t("settings.notifPrefs.meeting.label"),
                    desc: t("settings.notifPrefs.meeting.desc"),
                  },
                  {
                    key: "notifyTaskDue" as const,
                    label: t("settings.notifPrefs.taskDue.label"),
                    desc: t("settings.notifPrefs.taskDue.desc"),
                  },
                  {
                    key: "notifyAgentProposal" as const,
                    label: t("settings.notifPrefs.agentProposal.label"),
                    desc: t("settings.notifPrefs.agentProposal.desc"),
                  },
                  {
                    key: "notifyDailyBriefing" as const,
                    label: t("settings.notifPrefs.dailyBriefing.label"),
                    desc: t("settings.notifPrefs.dailyBriefing.desc"),
                  },
                ].map((row) => (
                  <label
                    key={row.key}
                    className="flex items-start gap-3 py-2 cursor-pointer hover:bg-surface-hover rounded-lg px-2 transition"
                  >
                    <input
                      type="checkbox"
                      checked={notifPrefs[row.key]}
                      onChange={(e) => updateNotifPref(row.key, e.target.checked)}
                      className="mt-0.5 w-4 h-4 rounded border-line-strong bg-surface-raised text-accent-deep focus:outline-none focus-visible:ring-2 focus-visible:ring-accent/35 focus-visible:ring-offset-1 focus-visible:ring-offset-white"
                    />
                    <div className="flex-1">
                      <p className="text-sm font-medium text-ink">{row.label}</p>
                      <p className="text-xs text-ink-mid">{row.desc}</p>
                    </div>
                  </label>
                ))}
              </fieldset>
              <div className="pt-3 border-t border-line-soft">
                <p className="text-sm font-medium text-ink mb-1">
                  {t("settings.quietHours.title")}
                </p>
                <p className="text-xs text-ink-mid mb-3">{t("settings.quietHours.desc")}</p>
                <div className="flex items-center gap-3">
                  <label htmlFor="quiet-hours-start" className="sr-only">
                    {t("settings.quietHours.startSrLabel")}
                  </label>
                  <input
                    id="quiet-hours-start"
                    type="time"
                    aria-label={t("settings.quietHours.startAriaLabel")}
                    value={notifPrefs.quietHoursStart || ""}
                    onChange={(e) => updateNotifPref("quietHoursStart", e.target.value || null)}
                    className="min-h-11 rounded border border-line bg-surface-raised px-2 py-1 text-sm text-ink focus:outline-none focus-visible:border-accent focus-visible:ring-1 focus-visible:ring-accent/25"
                  />
                  <span className="text-ink-mid text-sm">{t("settings.quietHours.to")}</span>
                  <label htmlFor="quiet-hours-end" className="sr-only">
                    {t("settings.quietHours.endSrLabel")}
                  </label>
                  <input
                    id="quiet-hours-end"
                    type="time"
                    aria-label={t("settings.quietHours.endAriaLabel")}
                    value={notifPrefs.quietHoursEnd || ""}
                    onChange={(e) => updateNotifPref("quietHoursEnd", e.target.value || null)}
                    className="min-h-11 rounded border border-line bg-surface-raised px-2 py-1 text-sm text-ink focus:outline-none focus-visible:border-accent focus-visible:ring-1 focus-visible:ring-accent/25"
                  />
                </div>
              </div>
              <div className="pt-3 border-t border-line-soft">
                <div className="flex items-start justify-between gap-4">
                  <div>
                    <p className="text-sm font-medium text-ink">
                      {t("settings.phoneEscalation.title")}
                    </p>
                    <p className="text-xs text-ink-dim mt-1">
                      {t("settings.phoneEscalation.desc")}
                    </p>
                  </div>
                  <Switch
                    checked={phoneEscalationEnabled}
                    onChange={(next) => updatePhoneEscalation(next)}
                    label={t("settings.phoneEscalation.title")}
                    hideLabel
                    className="shrink-0"
                  />
                </div>
              </div>
            </div>
          </div>
        </section>

        {/* Decision Agent */}
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
                  <p className="text-[10px] text-ink-dim mt-1">
                    {t("settings.proactiveAlerts.desc")}
                  </p>
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
          </div>
        </section>

        {/* Integrations */}
        <section className="mb-8">
          <h2 className={SECTION_TITLE}>{t("settings.section.connections")}</h2>
          <InAppBrowserNotice />
          <Suspense>
            <OAuthErrorBanner />
          </Suspense>
          <div className={`${PANEL} divide-y divide-line-soft`}>
            {loading ? (
              <div className="p-4">
                <ListSkeleton count={2} />
              </div>
            ) : (
              integrations.map((int) => (
                <div key={int.name} className="flex items-center justify-between gap-4 p-4">
                  <div>
                    <h3 className="font-medium">{int.name}</h3>
                    <p className="text-sm text-ink-mid">{int.description}</p>
                  </div>
                  {int.connected ? (
                    <div className="flex items-center gap-3">
                      <StatusChip status="connected" />
                      {int.name === "Google" && (
                        // Compact inline chip: quiet danger tint that never inverts to
                        // solid red on hover, unlike Button's danger variant — kept
                        // local rather than forcing a visual change onto this row.
                        <button
                          type="button"
                          onClick={disconnectGoogle}
                          className="ease-strong inline-flex min-h-11 items-center rounded-lg border border-state-danger-line bg-state-danger-bg px-3 text-xs font-medium text-state-danger-ink transition duration-150 hover:bg-state-danger-bg active:scale-[0.97] focus:outline-none focus-visible:ring-2 focus-visible:ring-accent/35"
                        >
                          {t("settings.disconnect")}
                        </button>
                      )}
                    </div>
                  ) : int.connectUrl?.endsWith("-coming-soon") ? (
                    <span className="text-sm text-ink-dim bg-surface-raised px-3 py-1.5 rounded-lg border border-line">
                      {t("settings.chip.comingSoon")}
                    </span>
                  ) : int.connectUrl === "google-oauth-start" ? (
                    <Button
                      onClick={() => {
                        void startGoogleConnect();
                      }}
                    >
                      {t("settings.connect")}
                    </Button>
                  ) : int.connectUrl ? (
                    // Button renders a <button>; this is a same-page <a> navigation
                    // to an OAuth start URL, so it keeps the raw PRIMARY_BTN class.
                    <a href={int.connectUrl} className={PRIMARY_BTN}>
                      {t("settings.connect")}
                    </a>
                  ) : (
                    <span className="text-sm text-ink-dim bg-surface-raised px-3 py-1.5 rounded-lg border border-line">
                      {t("settings.chip.comingSoon")}
                    </span>
                  )}
                </div>
              ))
            )}
          </div>

          {googleConnected && (
            <div className={`mt-3 ${PANEL} p-4 flex items-center justify-between gap-4`}>
              <div>
                <h3 className="font-medium">{t("settings.realtimeSync.title")}</h3>
                <p className="text-sm text-ink-mid">
                  {gmailPushConfigured
                    ? gmailPushEnabled
                      ? gmailPushExpiresAt
                        ? t("settings.realtimeSync.activeUntil", {
                            date: new Date(gmailPushExpiresAt).toLocaleString("en-US"),
                          })
                        : t("settings.realtimeSync.active")
                      : t("settings.realtimeSync.subscribe")
                    : t("settings.realtimeSync.notConfigured")}
                </p>
              </div>
              {gmailPushConfigured ? (
                gmailPushEnabled ? (
                  <Button
                    variant="secondary"
                    onClick={disableGmailPush}
                    disabled={gmailPushLoading}
                  >
                    {gmailPushLoading ? "..." : t("settings.turnOff")}
                  </Button>
                ) : (
                  <Button onClick={enableGmailPush} disabled={gmailPushLoading}>
                    {gmailPushLoading ? "..." : t("settings.turnOn")}
                  </Button>
                )
              ) : (
                <span className="text-sm text-ink-dim bg-surface-raised px-3 py-1.5 rounded-lg border border-line">
                  {t("settings.realtimeSync.unavailable")}
                </span>
              )}
            </div>
          )}

          {/* Telegram channel */}
          <TelegramSection />
        </section>

        {/* Connected Google inboxes (multi-account, Pro) */}
        <section className="mb-8">
          <Suspense>
            <LinkedInboxesSection />
          </Suspense>
        </section>

        {/* Naver Mail (IMAP) */}
        <section className="mb-8">
          <NaverImapSection />
        </section>

        {/* iCloud Mail (IMAP, app-specific password) — renders nothing (no
            wrapper, no margin) while ICLOUD_INBOX_ENABLED is off server-side
            (the status probe 404s), so it carries its own mb-8 */}
        <ICloudImapSection />

        {/* Outlook inboxes (Graph OAuth) — renders nothing while
            OUTLOOK_INBOX_ENABLED is off server-side (the list probe 404s),
            so it carries its own mb-8. Needs Suspense (useSearchParams). */}
        <Suspense>
          <OutlookInboxesSection />
        </Suspense>

        {/* Bring your own LLM key */}
        <section className="mb-8">
          <ByokKeysSection />
        </section>

        {/* MCP API keys — machine credentials for the MCP endpoint */}
        <section className="mb-8">
          <h2 className={SECTION_TITLE}>{t("settings.section.apiKeys")}</h2>
          <div className={`${PANEL} p-5`}>
            <ApiKeysSection />
          </div>
        </section>

        {/* Manual Runs */}
        <section className="mb-8">
          <h2 className={SECTION_TITLE}>{t("settings.section.manualRuns")}</h2>
          <div className="space-y-3">
            <div className={`${PANEL} p-4 flex items-center justify-between gap-4`}>
              <div>
                <h3 className="font-medium">{t("settings.dailyBriefing")}</h3>
                <p className="text-sm text-ink-mid">
                  {t("settings.manualRuns.dailyBriefing.desc")}
                </p>
              </div>
              <Button variant="secondary" onClick={generateBriefing}>
                {t("settings.generateBriefing")}
              </Button>
            </div>
          </div>
        </section>

        {/* Data Management */}
        <section className="mb-8">
          <h2 className={SECTION_TITLE}>{t("settings.data")}</h2>
          <div className="space-y-3">
            <div className={`${PANEL} p-4 flex items-center justify-between gap-4`}>
              <div>
                <h3 className="font-medium">{t("settings.exportData")}</h3>
                <p className="text-sm text-ink-mid">{t("settings.exportWorkspace.desc")}</p>
              </div>
              <Button variant="secondary" onClick={exportData}>
                {t("settings.export")}
              </Button>
            </div>
          </div>
        </section>

        {/* Workspace Reset */}
        <section className="mb-8">
          <h2 className="mb-3 text-[11px] font-semibold uppercase tracking-wider text-state-danger-ink">
            {t("settings.dangerZone")}
          </h2>
          <div className="panel-elevated rounded-2xl border border-state-danger-line bg-surface-panel divide-y divide-state-danger-line">
            <div className="flex items-center justify-between gap-4 p-4">
              <div>
                <h3 className="font-medium">{t("settings.confirm.deleteWorkspace.title")}</h3>
                <p className="text-sm text-ink-mid">{t("settings.deleteWorkspace.desc")}</p>
              </div>
              <Button variant="danger" onClick={clearAllData}>
                {t("settings.deleteAll")}
              </Button>
            </div>
            <div className="flex items-center justify-between gap-4 p-4">
              <div>
                <h3 className="font-medium">{t("settings.deleteBtn")}</h3>
                <p className="text-sm text-ink-mid mt-0.5">{t("settings.deleteAccount.desc")}</p>
              </div>
              <Button variant="danger" onClick={deleteAccount}>
                {t("settings.deleteBtn")}
              </Button>
            </div>
          </div>
        </section>

        {/* About */}
        <section>
          <h2 className={SECTION_TITLE}>{t("settings.about")}</h2>
          <div className={`${PANEL} p-4`}>
            <p className="text-sm text-ink-mid">
              <span className="text-accent-deep font-medium">Klorn</span> ·{" "}
              {t("settings.about.tagline")}
            </p>
            <p className="text-sm text-ink-dim mt-1">{t("settings.about.desc")}</p>
            <p className="text-xs text-ink-mid mt-3">{t("settings.about.version")}</p>
            {/* The support address lived only inside the privacy, terms and
                refund pages — all three on a noindex subdomain a signed-in user
                has no reason to open. A paying account needs a way to reach a
                human from the app itself. k0820086@gmail.com is the pinned
                contact: klorn.ai has no MX record, so a @klorn.ai address would
                bounce. */}
            <p className="text-xs text-ink-mid mt-2">
              {t("settings.about.support")}{" "}
              <a
                href="mailto:k0820086@gmail.com"
                className="text-accent-deep underline underline-offset-2 hover:text-accent"
              >
                k0820086@gmail.com
              </a>
            </p>
          </div>
        </section>
      </div>
    </AuthGuard>
  );
}
