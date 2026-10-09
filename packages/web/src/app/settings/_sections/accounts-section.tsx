"use client";

import { Suspense, useEffect, useState } from "react";
import { useConfirm } from "../../../components/confirm-dialog";
import { GoogleConnectRedirect } from "../../../components/google-connect-redirect";
import { ICloudImapSection } from "../../../components/icloud-imap-section";
import InAppBrowserNotice from "../../../components/in-app-browser-notice";
import { LinkedInboxesSection } from "../../../components/linked-inboxes-section";
import { NaverImapSection } from "../../../components/naver-imap-section";
import { OAuthErrorBanner } from "../../../components/oauth-error-banner";
import { OnboardingReturn } from "../../../components/onboarding-return";
import { OutlookInboxesSection } from "../../../components/outlook-inboxes-section";
import { ListSkeleton } from "../../../components/skeleton";
import { useToast } from "../../../components/toast";
import Button from "../../../components/ui/button";
import StatusChip from "../../../components/ui/status-chip";
import { API_BASE, apiFetch, authHeaders, startGoogleConnect } from "../../../lib/api";
import { useT } from "../../../lib/i18n";
import { captureClientError } from "../../../lib/sentry";
import { PANEL, PRIMARY_BTN, SECTION_TITLE } from "./shared";

interface Integration {
  name: string;
  description: string;
  connected: boolean;
  connectUrl?: string;
  statusUrl: string;
}

export function AccountsSection() {
  const [googleConnected, setGoogleConnected] = useState(false);
  const [notionConnected, setNotionConnected] = useState(false);
  const [loading, setLoading] = useState(true);
  const [gmailPushConfigured, setGmailPushConfigured] = useState(false);
  const [gmailPushEnabled, setGmailPushEnabled] = useState(false);
  const [gmailPushExpiresAt, setGmailPushExpiresAt] = useState<string | null>(null);
  const [gmailPushLoading, setGmailPushLoading] = useState(false);
  const { toast } = useToast();
  const { confirm } = useConfirm();
  const { t } = useT();

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

  return (
    <>
      <Suspense>
        <GoogleConnectRedirect />
      </Suspense>
      {/* ONBOARDING_V2: a connect the first run started returns there. */}
      <Suspense>
        <OnboardingReturn />
      </Suspense>

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
                <Button variant="secondary" onClick={disableGmailPush} disabled={gmailPushLoading}>
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
    </>
  );
}
