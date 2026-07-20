"use client";
import Script from "next/script";
import { useCallback } from "react";

declare global {
  interface Window {
    Paddle?: {
      Environment: { set: (env: string) => void };
      Initialize: (opts: { token: string; eventCallback?: (ev: { name: string }) => void }) => void;
    };
  }
}

/**
 * Loads Paddle.js and initializes it with the client-side token. Required for
 * the hosted checkout: our API returns the default-payment-link URL with a
 * `_ptxn` transaction param, and Paddle.js on THIS page is what detects it and
 * opens the checkout overlay (Paddle launch 2026-07-20). Renders nothing when
 * the token env is absent (e.g. local dev without Paddle).
 */
export function PaddleLoader({ onCheckoutCompleted }: { onCheckoutCompleted?: () => void }) {
  const token = process.env.NEXT_PUBLIC_PADDLE_CLIENT_TOKEN;
  const env = process.env.NEXT_PUBLIC_PADDLE_ENV;

  const init = useCallback(() => {
    if (!window.Paddle || !token) return;
    if (env === "sandbox") window.Paddle.Environment.set("sandbox");
    window.Paddle.Initialize({
      token,
      eventCallback: (ev) => {
        if (ev.name === "checkout.completed" && onCheckoutCompleted) {
          // Give the webhook a beat to land before refetching plan state.
          setTimeout(onCheckoutCompleted, 1500);
        }
      },
    });
  }, [token, env, onCheckoutCompleted]);

  if (!token) return null;
  return <Script src="https://cdn.paddle.com/paddle/v2/paddle.js" onLoad={init} />;
}
