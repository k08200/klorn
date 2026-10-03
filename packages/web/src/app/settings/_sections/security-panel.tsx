"use client";

import { useEffect, useState } from "react";
import { useToast } from "../../../components/toast";
import Button from "../../../components/ui/button";
import { apiFetch } from "../../../lib/api";
import { useAuth } from "../../../lib/auth";
import { useT } from "../../../lib/i18n";
import { captureClientError } from "../../../lib/sentry";
import { PANEL, SECTION_TITLE } from "./shared";

export function SecurityPanel() {
  const [currentPassword, setCurrentPassword] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [passwordLoading, setPasswordLoading] = useState(false);
  const [hasPassword, setHasPassword] = useState(true);
  const { user } = useAuth();
  const { toast } = useToast();
  const { t } = useT();

  useEffect(() => {
    // Check if user has a password set
    apiFetch<{ hasPassword: boolean }>("/api/auth/has-password")
      .then((d) => setHasPassword(d.hasPassword))
      .catch((err) => captureClientError(err, { scope: "settings.has-password" }));
  }, [user]);

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

  return (
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
  );
}
