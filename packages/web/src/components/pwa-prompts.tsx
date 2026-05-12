"use client";

import { useEffect, useState } from "react";

interface BeforeInstallPromptEvent extends Event {
  prompt(): Promise<void>;
  userChoice: Promise<{ outcome: "accepted" | "dismissed" }>;
}

const INSTALL_DISMISSED_KEY = "jigeum-install-dismissed";
const LEGACY_KEY_PREFIX = "ev" + "e";
const LEGACY_INSTALL_DISMISSED_KEY = `${LEGACY_KEY_PREFIX}-install-dismissed`;

export default function PwaPrompts() {
  const [installPrompt, setInstallPrompt] = useState<BeforeInstallPromptEvent | null>(null);
  const [showInstall, setShowInstall] = useState(false);
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
      {/* Offline indicator */}
      {offline && (
        <div className="fixed top-0 left-0 right-0 z-[100] bg-amber-400 text-stone-950 text-center py-1.5 text-xs font-medium pt-[calc(env(safe-area-inset-top)+0.375rem)]">
          오프라인 상태예요. 저장된 화면은 볼 수 있지만 실시간 신호는 잠시 멈출 수 있어요.
        </div>
      )}

      {/* Update available banner */}
      {updateAvailable && (
        <div className="fixed bottom-20 left-1/2 z-[100] flex max-w-[92vw] -translate-x-1/2 items-center gap-3 rounded-xl border border-stone-700 bg-stone-950 px-4 py-3 shadow-2xl shadow-black/60 animate-slide-up">
          <div className="text-sm text-stone-200">새 Jigeum 빌드가 준비됐어요</div>
          <button
            type="button"
            onClick={handleUpdate}
            className="px-3 py-1 text-xs font-medium bg-amber-300 hover:bg-amber-200 text-stone-950 rounded-lg transition whitespace-nowrap"
          >
            새로고침
          </button>
          <button
            type="button"
            onClick={() => setUpdateAvailable(false)}
            className="text-stone-500 hover:text-stone-300 transition text-sm"
          >
            나중에
          </button>
        </div>
      )}

      {/* Install prompt */}
      {showInstall && (
        <div className="fixed bottom-20 left-1/2 z-[100] flex max-w-[92vw] -translate-x-1/2 items-center gap-3 rounded-xl border border-amber-300/20 bg-stone-950 px-4 py-3 shadow-2xl shadow-black/60 animate-slide-up sm:max-w-md">
          <div className="flex h-9 w-9 shrink-0 items-center justify-center overflow-hidden rounded-lg bg-[#f5f0e8]">
            <img src="/brand/mark.svg" alt="" className="h-9 w-9" />
          </div>
          <div className="min-w-0 flex-1">
            <p className="text-sm font-medium text-stone-200">Jigeum 설치</p>
            <p className="text-xs text-stone-500">홈 화면에서 결정함을 바로 열 수 있어요</p>
          </div>
          <button
            type="button"
            onClick={handleInstall}
            className="px-3 py-1.5 text-xs font-medium bg-white text-stone-950 hover:bg-stone-200 rounded-lg transition whitespace-nowrap"
          >
            설치
          </button>
          <button
            type="button"
            onClick={dismissInstall}
            className="text-stone-500 hover:text-stone-300 transition text-lg leading-none"
          >
            x
          </button>
        </div>
      )}
    </>
  );
}
