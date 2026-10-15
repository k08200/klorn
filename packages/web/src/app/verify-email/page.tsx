"use client";

import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { Suspense, useEffect, useRef, useState } from "react";
import AuthStatus from "../../components/auth/auth-status";
import AuthScreen from "../../components/auth-screen";
import Button from "../../components/ui/button";
import { API_BASE, apiFetch } from "../../lib/api";
import { useAuth } from "../../lib/auth";
import { useT } from "../../lib/i18n";

function VerifyEmailContent() {
  const { t } = useT();
  const searchParams = useSearchParams();
  const token = searchParams.get("token");
  const { user, token: authToken } = useAuth();
  const [status, setStatus] = useState<"loading" | "verifying" | "error" | "pending" | "sent">(
    "loading",
  );
  // The token branch navigates away with a SINGLE-USE token. `user` resolves
  // async (after /api/auth/me), which would otherwise re-run this effect and
  // fire a second navigation with the already-spent token (→ 400). Guard it.
  const navigatedRef = useRef(false);

  useEffect(() => {
    if (token) {
      if (navigatedRef.current) return;
      navigatedRef.current = true;
      // A real link means the token must be confirmed against the API before we
      // claim anything. GET /api/auth/verify-email verifies server-side, then
      // redirects to /login?verified=true (success) or returns a 400 for an
      // expired/invalid token. Hand the browser to that endpoint so the server
      // is the single source of truth — never show success from mere presence.
      setStatus("verifying");
      window.location.assign(
        `${API_BASE}/api/auth/verify-email?token=${encodeURIComponent(token)}`,
      );
    } else if (user) {
      setStatus("pending");
    } else {
      setStatus("error");
    }
  }, [token, user]);

  const resend = async () => {
    if (!authToken) return;
    try {
      await apiFetch("/api/auth/resend-verification", {
        method: "POST",
        headers: { Authorization: `Bearer ${authToken}` },
      });
      // A resend genuinely sends a new email — this success is confirmed by the
      // API call, unlike the old token-presence guess.
      setStatus("sent");
    } catch {
      setStatus("error");
    }
  };

  // While loading (no decision yet) or verifying a link token (browser is being
  // handed to the API), show a status — never a premature success claim.
  if (status === "loading" || status === "verifying") {
    return <AuthStatus label={status === "verifying" ? t("verifyEmail.verifying") : undefined} />;
  }

  return (
    <AuthScreen
      title={
        status === "sent"
          ? t("verifyEmail.title.sent")
          : status === "pending"
            ? t("verifyEmail.title.pending")
            : t("verifyEmail.title.error")
      }
      description={
        status === "sent"
          ? t("verifyEmail.description.sent")
          : status === "pending"
            ? t("verifyEmail.description.pending")
            : t("verifyEmail.description.error")
      }
    >
      <p className="rounded-card border border-line bg-surface-raised px-4 py-3 text-body text-ink-mid">
        {status === "sent"
          ? t("verifyEmail.nextStepBody.sent")
          : status === "pending"
            ? t("verifyEmail.nextStepBody.pending")
            : t("verifyEmail.nextStepBody.error")}
      </p>

      {status === "pending" || status === "sent" ? (
        <>
          <Button size="lg" className="mt-6 w-full" onClick={resend}>
            {status === "sent" ? t("verifyEmail.resendAgain") : t("verifyEmail.resendVerification")}
          </Button>
          <p className="mt-6 text-center">
            <Link
              href="/login"
              className="focus-ring inline-flex min-h-11 items-center rounded-control px-1 text-label text-accent-deep underline-offset-2 hover:underline"
            >
              {t("auth.backToLogin")}
            </Link>
          </p>
        </>
      ) : (
        <Link
          href="/login"
          className="focus-ring mt-6 flex h-11 w-full items-center justify-center rounded-control border border-line bg-surface-panel text-label text-ink transition-colors duration-120 ease-fluid hover:border-line-strong hover:bg-surface-hover"
        >
          {t("auth.backToLogin")}
        </Link>
      )}
    </AuthScreen>
  );
}

export default function VerifyEmailPage() {
  return (
    <Suspense>
      <VerifyEmailContent />
    </Suspense>
  );
}
