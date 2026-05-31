"use client";

import Image from "next/image";
import { useEffect, useState } from "react";

interface BeforeInstallPromptEvent extends Event {
  prompt(): Promise<void>;
  userChoice: Promise<{ outcome: "accepted" | "dismissed" }>;
}

const INSTALL_DISMISSED_KEY = "klorn-install-dismissed";
const IOS_INSTALL_DISMISSED_KEY = "klorn-ios-install-dismissed";
const LEGACY_KEY_PREFIX = "ev" + "e";
const LEGACY_INSTALL_DISMISSED_KEY = `${LEGACY_KEY_PREFIX}-install-dismissed`;

// iOS Safari never fires `beforeinstallprompt`, and push notifications on iOS
// require the page to run as an installed PWA (display-mode: standalone). So
// iOS users who never install never get push, and they never see the regular
// install banner either. This is the single biggest cause of "I never get the
// morning briefing on my phone." Detect iOS Safari running in browser mode
// and surface manual Add-to-Home-Screen instructions.
function isIosSafariBrowser(): boolean {
  if (typeof window === "undefined") return false;
  const ua = window.navigator.userAgent;
  const isIos = /iPad|iPhone|iPod/.test(ua) && !(window as { MSStream?: unknown }).MSStream;
  if (!isIos) return false;
  const isStandalone =
    window.matchMedia?.("(display-mode: standalone)").matches ||
    (window.navigator as { standalone?: boolean }).standalone === true;
  if (isStandalone) return false;
  // In-app browsers (Chrome iOS, Firefox iOS, Line, KakaoTalk) cannot install
  // PWAs at all — instructions would be wrong. Restrict to actual Safari.
  const isCriOs = /CriOS|FxiOS|EdgiOS|GSA|FBAN|FBAV|Line|KAKAOTALK/.test(ua);
  return !isCriOs;
}

export default function PwaPrompts() {
  const [installPrompt, setInstallPrompt] = useState<BeforeInstallPromptEvent | null>(null);
  const [showInstall, setShowInstall] = useState(false);
  const [showIosInstall, setShowIosInstall] = useState(false);
  const [offline, setOffline] = useState(false);
  const [updateAvailable, setUpdateAvailable] = useState(false);

  // Install prompt
  useEffect(() => {
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

  // iOS Safari install instructions — separate flow since beforeinstallprompt
  // never fires on iOS. Show only in real Safari, not in-app browsers.
  useEffect(() => {
    if (!isIosSafariBrowser()) return;
    let dismissedAt = 0;
    try {
      dismissedAt = Number(localStorage.getItem(IOS_INSTALL_DISMISSED_KEY) || 0);
    } catch {
      // ignore — proceed to show
    }
    const oneWeek = 7 * 24 * 60 * 60 * 1000;
    if (dismissedAt && Date.now() - dismissedAt < oneWeek) return;
    setShowIosInstall(true);
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

  const dismissIosInstall = () => {
    setShowIosInstall(false);
    try {
      localStorage.setItem(IOS_INSTALL_DISMISSED_KEY, String(Date.now()));
    } catch {
      // localStorage unavailable (private mode); banner just won't re-suppress
    }
  };

  const handleUpdate = () => {
    setUpdateAvailable(false);
    window.location.reload();
  };

  return (
    <>
      {/* Offline indicator */}
      {offline && (
        <div
          className="fixed top-0 left-0 right-0 z-[100] bg-amber-400 text-stone-950 text-center py-1.5 text-xs font-medium pt-[calc(env(safe-area-inset-top)+0.375rem)]"
          role="status"
          aria-live="polite"
        >
          You are offline. Saved screens still work, but live signals may pause.
        </div>
      )}

      {/* Update available banner */}
      {updateAvailable && (
        <div
          className="fixed bottom-20 left-1/2 z-[100] flex max-w-[92vw] -translate-x-1/2 items-center gap-3 rounded-xl border border-stone-700 bg-stone-950 px-4 py-3 shadow-2xl shadow-black/60 animate-slide-up"
          role="region"
          aria-label="App update available"
        >
          <div className="text-sm text-stone-200">A new Klorn build is ready.</div>
          <button
            type="button"
            onClick={handleUpdate}
            className="min-h-10 px-3 py-1 text-xs font-medium bg-amber-300 hover:bg-amber-200 text-stone-950 rounded-lg transition whitespace-nowrap"
          >
            Refresh
          </button>
          <button
            type="button"
            onClick={() => setUpdateAvailable(false)}
            className="min-h-10 px-2 text-stone-500 hover:text-stone-300 transition text-sm"
            aria-label="Dismiss update prompt"
          >
            Later
          </button>
        </div>
      )}

      {/* Install prompt */}
      {showInstall && (
        <div
          className="fixed bottom-20 left-1/2 z-[100] flex max-w-[92vw] -translate-x-1/2 items-center gap-3 rounded-xl border border-amber-300/20 bg-stone-950 px-4 py-3 shadow-2xl shadow-black/60 animate-slide-up sm:max-w-md"
          role="region"
          aria-label="Install Klorn"
        >
          <div className="flex h-9 w-9 shrink-0 items-center justify-center overflow-hidden rounded-lg bg-[#f5f0e8]">
            <Image
              src="/brand/mark.svg?v=navy1"
              alt=""
              width={36}
              height={36}
              className="h-9 w-9"
            />
          </div>
          <div className="min-w-0 flex-1">
            <p className="text-sm font-medium text-stone-200">Install Klorn</p>
            <p className="text-xs text-stone-500">Open the decision queue from your home screen.</p>
          </div>
          <button
            type="button"
            onClick={handleInstall}
            className="min-h-10 px-3 py-1.5 text-xs font-medium bg-white text-stone-950 hover:bg-stone-200 rounded-lg transition whitespace-nowrap"
          >
            Install
          </button>
          <button
            type="button"
            onClick={dismissInstall}
            className="min-h-10 min-w-10 text-stone-500 hover:text-stone-300 transition text-lg leading-none"
            aria-label="Dismiss install prompt"
          >
            x
          </button>
        </div>
      )}

      {/* iOS Safari install instructions — push notifications require PWA on iOS */}
      {showIosInstall && (
        <div
          className="fixed bottom-20 left-1/2 z-[100] w-[min(94vw,420px)] -translate-x-1/2 rounded-2xl border border-amber-300/25 bg-stone-950 px-4 py-3.5 shadow-2xl shadow-black/60 animate-slide-up pb-safe"
          role="region"
          aria-label="Install Klorn on iPhone for push notifications"
        >
          <div className="flex items-start gap-3">
            <div className="flex h-9 w-9 shrink-0 items-center justify-center overflow-hidden rounded-lg bg-[#f5f0e8]">
              <Image
                src="/brand/mark.svg?v=navy1"
                alt=""
                width={36}
                height={36}
                className="h-9 w-9"
              />
            </div>
            <div className="min-w-0 flex-1">
              <p className="text-sm font-medium text-stone-100">
                Get the morning briefing on iPhone
              </p>
              <p className="mt-0.5 text-xs text-stone-400">
                iOS only delivers Klorn push from an installed app. Add to Home Screen to enable it.
              </p>
            </div>
            <button
              type="button"
              onClick={dismissIosInstall}
              className="-mr-1 -mt-0.5 text-lg leading-none text-stone-500 transition hover:text-stone-200"
              aria-label="Dismiss iOS install prompt"
            >
              ×
            </button>
          </div>
          <ol className="mt-3 space-y-1.5 text-xs text-stone-300">
            <li className="flex items-center gap-2">
              <span className="flex h-5 w-5 shrink-0 items-center justify-center rounded-full border border-stone-700 text-[10px] font-semibold text-stone-400">
                1
              </span>
              <span>
                Tap the Share icon{" "}
                <span aria-hidden="true" className="text-amber-200">
                  ⎋
                </span>{" "}
                in Safari's toolbar
              </span>
            </li>
            <li className="flex items-center gap-2">
              <span className="flex h-5 w-5 shrink-0 items-center justify-center rounded-full border border-stone-700 text-[10px] font-semibold text-stone-400">
                2
              </span>
              <span>Scroll down and choose "Add to Home Screen"</span>
            </li>
            <li className="flex items-center gap-2">
              <span className="flex h-5 w-5 shrink-0 items-center justify-center rounded-full border border-stone-700 text-[10px] font-semibold text-stone-400">
                3
              </span>
              <span>Open Klorn from the new home-screen icon, then allow notifications</span>
            </li>
          </ol>
        </div>
      )}
    </>
  );
}
