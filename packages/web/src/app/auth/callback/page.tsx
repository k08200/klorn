"use client";

import { useSearchParams } from "next/navigation";
import { Suspense, useEffect, useRef } from "react";
import AuthStatus from "../../../components/auth/auth-status";
import { API_BASE } from "../../../lib/api";
import { useAuth } from "../../../lib/auth";
import { useT } from "../../../lib/i18n";

function CallbackHandler() {
  const searchParams = useSearchParams();
  const { loginWithToken } = useAuth();
  const { t } = useT();
  const handled = useRef(false);

  useEffect(() => {
    if (handled.current) return;
    handled.current = true;

    // The server only ever emits ?code= (exchange-code flow); the old direct
    // ?token= JWT-in-URL path is dead server-side and was residual attack
    // surface (browser history/Referer) — removed, security audit 2026-07-20.
    const code = searchParams.get("code");

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
    } else {
      window.location.href = "/login?error=google_failed";
    }
  }, [searchParams, loginWithToken]);

  return <AuthStatus label={t("auth.signingIn")} />;
}

export default function AuthCallbackPage() {
  return (
    <Suspense>
      <CallbackHandler />
    </Suspense>
  );
}
