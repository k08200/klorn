"use client";

import { useSearchParams } from "next/navigation";
import { Suspense, useEffect, useRef } from "react";
import AuthStatus from "../../../components/auth/auth-status";
import { API_BASE } from "../../../lib/api";
import { useAuth } from "../../../lib/auth";
import { useT } from "../../../lib/i18n";
import { takeLoginBinding } from "../../../lib/login-binding";

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
      // The nonce this browser kept when it started the sign-in: the code
      // redeems only with it (lib/login-binding.ts, login CSRF).
      const nonce = takeLoginBinding();
      fetch(`${API_BASE}/api/auth/exchange-code`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        // `web`: this is the browser callback, so a native app's unbound
        // relay code is refused here (api routes/auth.ts /exchange-code).
        body: JSON.stringify(nonce ? { code, nonce, web: true } : { code, web: true }),
      })
        .then((r) => (r.ok ? r.json() : Promise.reject(r.status)))
        .then((data: { token: string }) => loginWithToken(data.token))
        .catch((status: unknown) => {
          // 403: started in another browser, or before this page could bind it.
          window.location.href =
            status === 403 ? "/login?error=session_expired" : "/login?error=google_failed";
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
