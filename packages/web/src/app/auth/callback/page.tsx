"use client";

import { useSearchParams } from "next/navigation";
import { Suspense, useEffect, useRef } from "react";
import { API_BASE } from "../../../lib/api";
import { useAuth } from "../../../lib/auth";

function CallbackHandler() {
  const searchParams = useSearchParams();
  const { loginWithToken } = useAuth();
  const handled = useRef(false);

  useEffect(() => {
    if (handled.current) return;
    handled.current = true;

    const code = searchParams.get("code");
    const token = searchParams.get("token"); // legacy: direct JWT (backward-compat)

    if (code) {
      fetch(`${API_BASE}/api/auth/exchange-code`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ code }),
      })
        .then((r) => (r.ok ? r.json() : Promise.reject(r.status)))
        .then((data: { token: string }) => loginWithToken(data.token))
        .catch(() => {
          window.location.href = "/login?error=google_failed";
        });
    } else if (token) {
      loginWithToken(token).catch(() => {
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
