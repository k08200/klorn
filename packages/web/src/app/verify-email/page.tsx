"use client";

import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { Suspense, useEffect, useState } from "react";
import AuthScreen from "../../components/auth-screen";
import { apiFetch } from "../../lib/api";
import { useAuth } from "../../lib/auth";

function VerifyEmailContent() {
  const searchParams = useSearchParams();
  const token = searchParams.get("token");
  const { user, token: authToken } = useAuth();
  const [status, setStatus] = useState<"loading" | "success" | "error" | "pending">("loading");

  useEffect(() => {
    if (token) {
      // Redirected from email link; the API handles verification through GET redirect.
      setStatus("success");
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
      setStatus("success");
    } catch {
      setStatus("error");
    }
  };

  if (status === "loading") {
    return (
      <div className="flex h-screen items-center justify-center bg-[#10100d]">
        <div className="h-5 w-5 animate-spin rounded-full border-2 border-amber-300 border-t-transparent" />
      </div>
    );
  }

  return (
    <AuthScreen
      eyebrow="Email verification"
      title={
        status === "success"
          ? "Verification email sent"
          : status === "pending"
            ? "Verify your email"
            : "Verification failed"
      }
      description={
        status === "success"
          ? "Open the verification link in your inbox to unlock your Jigeum workspace."
          : status === "pending"
            ? "Verify your account email to unlock every workspace feature."
            : "The link is expired or invalid. Sign in again and request a new verification email."
      }
      footer={
        <Link href="/login" className="transition hover:text-stone-300">
          Back to login
        </Link>
      }
    >
      <div className="space-y-4">
        <div className="rounded-md border border-stone-700/60 bg-black/20 p-4">
          <p className="text-xs font-medium uppercase tracking-[0.16em] text-stone-500">
            Next step
          </p>
          <p className="mt-2 text-sm leading-6 text-stone-300">
            {status === "success"
              ? "Open the Jigeum verification email and follow the link. You can return to the decision queue after verification."
              : status === "pending"
                ? "If the email is missing, send a fresh verification link."
                : "Return to login, check your account state, then request a new verification email."}
          </p>
        </div>

        {status === "success" ? (
          <Link
            href="/inbox"
            className="flex h-11 w-full items-center justify-center rounded-md bg-amber-300 text-sm font-semibold text-stone-950 transition hover:bg-amber-200"
          >
            Open decision queue
          </Link>
        ) : status === "pending" ? (
          <button
            type="button"
            onClick={resend}
            className="flex h-11 w-full items-center justify-center rounded-md bg-amber-300 text-sm font-semibold text-stone-950 transition hover:bg-amber-200"
          >
            Resend verification email
          </button>
        ) : (
          <Link
            href="/login"
            className="flex h-11 w-full items-center justify-center rounded-md border border-stone-700 bg-stone-900/70 text-sm font-semibold text-stone-100 transition hover:border-stone-500"
          >
            Back to login
          </Link>
        )}
      </div>
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
