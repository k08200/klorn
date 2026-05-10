"use client";

import { useSearchParams } from "next/navigation";
import { Suspense, useEffect, useRef } from "react";
import { useAuth } from "../../../lib/auth";

function CallbackHandler() {
  const searchParams = useSearchParams();
  const { loginWithToken } = useAuth();
  const handled = useRef(false);

  useEffect(() => {
    console.log("[callback] useEffect fired, handled:", handled.current);
    if (handled.current) return;
    handled.current = true;

    const token = searchParams.get("token");
    console.log("[callback] token present:", !!token);
    if (token) {
      loginWithToken(token).catch((err) => {
        console.error("[callback] loginWithToken failed:", err);
        window.location.href = "/login?error=google_failed";
      });
    } else {
      window.location.href = "/login?error=google_failed";
    }
  }, [searchParams, loginWithToken]);

  return (
    <div className="flex items-center justify-center h-screen">
      <div className="w-5 h-5 border-2 border-amber-300 border-t-transparent rounded-full animate-spin" />
    </div>
  );
}

export default function AuthCallbackPage() {
  return (
    <Suspense>
      <CallbackHandler />
    </Suspense>
  );
}
