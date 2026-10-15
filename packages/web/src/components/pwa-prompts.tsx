"use client";

import { useEffect, useState } from "react";
import { useT } from "../lib/i18n";
import { isNativePlatform } from "../lib/native/capacitor";
import { isNativeShell } from "../lib/native/shell";
import Button from "./ui/button";

interface BeforeInstallPromptEvent extends Event {
  prompt(): Promise<void>;
  userChoice: Promise<{ outcome: "accepted" | "dismissed" }>;
}

const INSTALL_DISMISSED_KEY = "klorn-install-dismissed";
const LEGACY_KEY_PREFIX = "ev" + "e";
const LEGACY_INSTALL_DISMISSED_KEY = `${LEGACY_KEY_PREFIX}-install-dismissed`;

// Floating cards sit above the phone tab bar (62px + home indicator) and at
// the corner on desktop, so they never sit on top of the bar's targets.
const FLOATING =
  "fixed left-1/2 z-[100] flex w-[min(92vw,28rem)] -translate-x-1/2 items-center gap-3 rounded-card border border-line bg-surface-panel px-4 py-3 shadow-l3 animate-slide-up motion-reduce:animate-none bottom-[calc(62px+env(safe-area-inset-bottom)+12px)] md:bottom-6";

/**
 * App-wide PWA chrome: offline notice, "new version" refresh, and the
 * Chromium install prompt. The iPhone home-screen install hint is NOT here —
 * it is an inline card (IosInstallHint) so it never covers content on phones.
 */
export default function PwaPrompts() {
  const { t } = useT();
  const [installPrompt, setInstallPrompt] = useState<BeforeInstallPromptEvent | null>(null);
  const [showInstall, setShowInstall] = useState(false);
  const [offline, setOffline] = useState(false);
  const [updateAvailable, setUpdateAvailable] = useState(false);

  // Install prompt
  useEffect(() => {
    // Already running as the installed native app — never prompt to install.
    if (isNativePlatform() || isNativeShell()) return;
    const handler = (e: Event) => {
      e.preventDefault();
      setInstallPrompt(e as BeforeInstallPromptEvent);
      // Only show if not dismissed before
      const dismissed =
        localStorage.getItem(INSTALL_DISMISSED_KEY) ||
        localStorage.getItem(LEGACY_INSTALL_DISMISSED_KEY);
      if (dismissed) {
        localStorage.setItem(INSTALL_DISMISSED_KEY, dismissed);
        localStorage.removeItem(LEGACY_INSTALL_DISMISSED_KEY);
      }
      if (!dismissed) {
        setShowInstall(true);
      }
    };
    window.addEventListener("beforeinstallprompt", handler);
    return () => window.removeEventListener("beforeinstallprompt", handler);
  }, []);

  // Offline detection
  useEffect(() => {
    const goOffline = () => setOffline(true);
    const goOnline = () => setOffline(false);
    setOffline(!navigator.onLine);
    window.addEventListener("offline", goOffline);
    window.addEventListener("online", goOnline);
    return () => {
      window.removeEventListener("offline", goOffline);
      window.removeEventListener("online", goOnline);
    };
  }, []);

  // Service worker update detection
  useEffect(() => {
    if (!("serviceWorker" in navigator)) return;
    navigator.serviceWorker.ready.then((reg) => {
      reg.addEventListener("updatefound", () => {
        const newWorker = reg.installing;
        if (!newWorker) return;
        newWorker.addEventListener("statechange", () => {
          if (newWorker.state === "installed" && navigator.serviceWorker.controller) {
            setUpdateAvailable(true);
          }
        });
      });
    });
  }, []);

  const handleInstall = async () => {
    if (!installPrompt) return;
    await installPrompt.prompt();
    const { outcome } = await installPrompt.userChoice;
    if (outcome === "accepted") {
      setShowInstall(false);
    }
    setInstallPrompt(null);
  };

  const dismissInstall = () => {
    setShowInstall(false);
    localStorage.setItem(INSTALL_DISMISSED_KEY, "1");
    localStorage.removeItem(LEGACY_INSTALL_DISMISSED_KEY);
  };

  const handleUpdate = () => {
    setUpdateAvailable(false);
    window.location.reload();
  };

  return (
    <>
      {offline && (
        <div
          className="fixed inset-x-0 top-0 z-[100] border-b border-state-warn-line bg-state-warn-bg px-4 pb-1.5 pt-[calc(env(safe-area-inset-top)+0.375rem)] text-center text-label text-state-warn-ink"
          role="status"
          aria-live="polite"
        >
          {t("pwa.offline")}
        </div>
      )}

      {updateAvailable && (
        <section className={FLOATING} aria-label={t("pwa.update.region")}>
          <p className="min-w-0 flex-1 text-body text-ink">{t("pwa.update.ready")}</p>
          <Button size="sm" onClick={handleUpdate}>
            {t("pwa.update.refresh")}
          </Button>
          <Button variant="ghost" size="sm" onClick={() => setUpdateAvailable(false)}>
            {t("pwa.update.later")}
          </Button>
        </section>
      )}

      {showInstall && (
        <section className={FLOATING} aria-label={t("pwa.install.title")}>
          <img src="/brand/mark.svg?v=matte2" alt="" className="h-9 w-9 shrink-0" />
          <div className="min-w-0 flex-1">
            <p className="text-label text-ink">{t("pwa.install.title")}</p>
            <p className="text-caption text-ink-mid">{t("pwa.install.body")}</p>
          </div>
          <Button size="sm" onClick={handleInstall}>
            {t("pwa.install.action")}
          </Button>
          <Button
            variant="ghost"
            size="icon"
            aria-label={t("pwa.install.dismiss")}
            onClick={dismissInstall}
          >
            <CloseGlyph />
          </Button>
        </section>
      )}
    </>
  );
}

export function CloseGlyph() {
  return (
    <svg
      viewBox="0 0 16 16"
      aria-hidden="true"
      className="h-4 w-4"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.75"
      strokeLinecap="round"
    >
      <path d="M4 4l8 8M12 4l-8 8" />
    </svg>
  );
}
