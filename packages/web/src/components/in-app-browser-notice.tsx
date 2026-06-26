"use client";

import { useEffect, useState } from "react";
import { detectInAppBrowser } from "../lib/in-app-browser";

// Shown on the login / connect surfaces when the page is running inside an
// embedded in-app browser (KakaoTalk, Naver, Instagram, ...). Google blocks
// OAuth there with `403: disallowed_useragent`, so we tell the user to reopen
// the page in a real browser and give them a one-tap copy of the URL.
export default function InAppBrowserNotice() {
  // Detect on the client only — `navigator` is undefined during SSR, and a
  // client-only initial value of null matches the server render (no hydration
  // mismatch). The banner appears after mount if a WebView is detected.
  const [appName, setAppName] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    setAppName(detectInAppBrowser());
  }, []);

  useEffect(() => {
    if (!copied) return;
    const timer = setTimeout(() => setCopied(false), 2000);
    return () => clearTimeout(timer);
  }, [copied]);

  if (!appName) return null;

  const copyLink = async () => {
    try {
      await navigator.clipboard.writeText(window.location.href);
      setCopied(true);
    } catch {
      // Clipboard API is blocked in some WebViews — the instructions below
      // still let the user open the menu manually, so fail quietly here.
      setCopied(false);
    }
  };

  return (
    <div
      role="alert"
      className="mb-4 rounded-md border border-rose-400/30 bg-rose-500/10 px-3 py-3 text-xs leading-5 text-rose-100"
    >
      <p className="font-semibold text-rose-50">Open in your browser to sign in</p>
      <p className="mt-1 text-rose-100/90">
        You&apos;re in {appName}&apos;s in-app browser, where Google blocks sign-in (error{" "}
        <span className="font-mono">403: disallowed_useragent</span>). Tap the menu (⋮ or ···) and
        choose <span className="font-medium text-rose-50">Open in browser</span> — Chrome or Safari
        — then sign in there.
      </p>
      <button
        type="button"
        onClick={copyLink}
        className="mt-2 inline-flex h-9 items-center rounded-md border border-rose-300/40 bg-rose-200/10 px-3 text-xs font-medium text-rose-50 transition hover:bg-rose-200/20"
      >
        {copied ? "Link copied" : "Copy link"}
      </button>
    </div>
  );
}
