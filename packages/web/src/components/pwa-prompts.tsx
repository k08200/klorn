"use client";

import { useEffect, useState } from "react";

interface BeforeInstallPromptEvent extends Event {
  prompt(): Promise<void>;
  userChoice: Promise<{ outcome: "accepted" | "dismissed" }>;
}

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
      const dismissed = localStorage.getItem("eve-install-dismissed");
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
    localStorage.setItem("eve-install-dismissed", "1");
  };

  const handleUpdate = () => {
    setUpdateAvailable(false);
    window.location.reload();
  };

  return (
    <>
      {/* Offline indicator */}
      {offline && (
        <div className="fixed top-0 left-0 right-0 z-[100] bg-amber-600 text-white text-center py-1.5 text-xs font-medium pt-[calc(env(safe-area-inset-top)+0.375rem)]">
          You are offline. Some features may be unavailable.
        </div>
      )}

      {/* Update available banner */}
      {updateAvailable && (
        <div className="fixed bottom-20 left-1/2 -translate-x-1/2 z-[100] bg-stone-950 border border-stone-700 rounded-xl shadow-2xl shadow-black/60 px-4 py-3 flex items-center gap-3 animate-slide-up">
          <div className="text-sm text-stone-200">A new version of EVE is available</div>
          <button
            type="button"
            onClick={handleUpdate}
            className="px-3 py-1 text-xs font-medium bg-amber-300 hover:bg-amber-200 text-stone-950 rounded-lg transition whitespace-nowrap"
          >
            Update now
          </button>
          <button
            type="button"
            onClick={() => setUpdateAvailable(false)}
            className="text-stone-500 hover:text-stone-300 transition text-sm"
          >
            Later
          </button>
        </div>
      )}

      {/* Install prompt */}
      {showInstall && (
        <div className="fixed bottom-20 left-1/2 -translate-x-1/2 z-[100] bg-stone-950 border border-stone-700 rounded-xl shadow-2xl shadow-black/60 px-4 py-3 flex items-center gap-3 animate-slide-up max-w-sm">
          <div className="w-9 h-9 rounded-xl bg-gradient-to-br from-emerald-500 to-teal-600 flex items-center justify-center text-sm font-bold text-white shrink-0">
            E
          </div>
          <div className="min-w-0 flex-1">
            <p className="text-sm font-medium text-stone-200">Install EVE</p>
            <p className="text-xs text-stone-500">Add to home screen for quick access</p>
          </div>
          <button
            type="button"
            onClick={handleInstall}
            className="px-3 py-1.5 text-xs font-medium bg-white text-stone-950 hover:bg-stone-200 rounded-lg transition whitespace-nowrap"
          >
            Install
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
