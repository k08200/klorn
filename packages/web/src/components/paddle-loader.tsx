"use client";
import Script from "next/script";
import { useCallback, useEffect, useRef, useState } from "react";
import { useT } from "../lib/i18n";

declare global {
  interface Window {
    Paddle?: {
      Environment: { set: (env: string) => void };
      Initialize: (opts: { token: string; eventCallback?: (ev: { name: string }) => void }) => void;
    };
  }
}

/** How long after load the overlay gets to announce itself before we warn. */
const BLOCKED_CHECK_DELAY_MS = 6000;

/**
 * Loads Paddle.js and initializes it with the client-side token. Required for
 * the hosted checkout: our API returns the default-payment-link URL with a
 * `_ptxn` transaction param, and Paddle.js on THIS page is what detects it and
 * opens the checkout overlay (Paddle launch 2026-07-20). Renders nothing when
 * the token env is absent (e.g. local dev without Paddle).
 *
 * paddle.com is on common ad-blocker lists, so for some customers the script
 * (or its overlay iframe) never loads. Without detection that is a silently
 * dead upgrade button — click, navigation to `?_ptxn=...`, nothing (observed
 * 2026-08-13: worked in an extension-free incognito window, did nothing in the
 * same browser's normal window). When the script errors, or a `_ptxn` landing
 * produces no checkout event, we say so instead of staying blank.
 */
export function PaddleLoader({ onCheckoutCompleted }: { onCheckoutCompleted?: () => void }) {
  const { t } = useT();
  const token = process.env.NEXT_PUBLIC_PADDLE_CLIENT_TOKEN;
  const env = process.env.NEXT_PUBLIC_PADDLE_ENV;

  // Paddle can emit checkout.completed more than once for one purchase (a
  // reopened overlay re-announces a completed transaction). Handling it twice
  // means two navigations racing each other, so the handler is one-shot.
  const handled = useRef(false);
  // Any checkout.* event proves the overlay actually opened (or was closed by
  // the customer on purpose) — either way it was not blocked.
  const sawCheckoutEvent = useRef(false);
  const [blocked, setBlocked] = useState(false);

  const init = useCallback(() => {
    if (!window.Paddle || !token) return;
    if (env === "sandbox") window.Paddle.Environment.set("sandbox");
    window.Paddle.Initialize({
      token,
      eventCallback: (ev) => {
        sawCheckoutEvent.current = true;
        if (ev.name === "checkout.completed" && onCheckoutCompleted && !handled.current) {
          handled.current = true;
          // Give the webhook a beat to land before refetching plan state.
          setTimeout(onCheckoutCompleted, 1500);
        }
      },
    });
  }, [token, env, onCheckoutCompleted]);

  useEffect(() => {
    if (!token) return;
    if (!new URLSearchParams(window.location.search).has("_ptxn")) return;
    const timer = setTimeout(() => {
      // A _ptxn landing that produced no checkout.* event within the window
      // means the overlay never opened — the blocked case.
      if (!sawCheckoutEvent.current) setBlocked(true);
    }, BLOCKED_CHECK_DELAY_MS);
    return () => clearTimeout(timer);
  }, [token]);

  if (!token) return null;
  return (
    <>
      <Script
        src="https://cdn.paddle.com/paddle/v2/paddle.js"
        onLoad={init}
        onError={() => {
          // Warn only when a checkout was actually attempted (_ptxn landing).
          // A blocked script during plain browsing shouldn't nag — the customer
          // may never open checkout, and the timer below covers them if they do.
          if (new URLSearchParams(window.location.search).has("_ptxn")) setBlocked(true);
        }}
      />
      {blocked && (
        <div
          role="alert"
          className="fixed inset-x-4 top-4 z-50 mx-auto max-w-xl rounded-xl border border-state-warn-line bg-state-warn-bg p-4 text-sm text-amber-900 shadow-lg"
        >
          <p className="font-semibold">{t("paddle.blocked.title")}</p>
          <p className="mt-1">{t("paddle.blocked.body")}</p>
          <button
            type="button"
            onClick={() => setBlocked(false)}
            className="mt-2 rounded-lg border border-state-warn-line px-3 py-1.5 font-medium hover:bg-amber-100"
          >
            {t("common.dismiss")}
          </button>
        </div>
      )}
    </>
  );
}
