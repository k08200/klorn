"use client";

import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { Suspense, useEffect, useState } from "react";
import { apiFetch } from "../../lib/api";
import { useAuth } from "../../lib/auth";

function VerifyEmailContent() {
  const searchParams = useSearchParams();
  const token = searchParams.get("token");
  const { user, token: authToken } = useAuth();
  const [status, setStatus] = useState<"loading" | "success" | "error" | "pending">("loading");

  useEffect(() => {
    if (token) {
      // Redirected from email link — API handles verification via GET redirect
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
      <div className="flex items-center justify-center h-screen">
        <div className="w-5 h-5 border-2 border-amber-300 border-t-transparent rounded-full animate-spin" />
      </div>
    );
  }

  return (
    <main className="flex items-center justify-center min-h-[calc(100vh-3rem)] px-4">
      <div className="w-full max-w-sm text-center">
        {status === "success" ? (
          <>
            <h1 className="text-xl font-bold mb-3">Verification email sent!</h1>
            <p className="text-stone-400 text-sm mb-6">
              Check your inbox and click the verification link.
            </p>
            <Link href="/inbox" className="text-sm text-amber-300 hover:text-amber-200">
              Go to Inbox
            </Link>
          </>
        ) : status === "pending" ? (
          <>
            <h1 className="text-xl font-bold mb-3">Verify your email</h1>
            <p className="text-stone-400 text-sm mb-6">
              Please verify your email address to unlock all features.
            </p>
            <button
              type="button"
              onClick={resend}
              className="bg-amber-300 hover:bg-amber-200 text-stone-950 px-6 py-2.5 rounded-lg text-sm font-semibold transition-colors"
            >
              Resend Verification Email
            </button>
          </>
        ) : (
          <>
            <h1 className="text-xl font-bold mb-3">Verification Failed</h1>
            <p className="text-stone-400 text-sm mb-6">Invalid or expired link.</p>
            <Link href="/login" className="text-sm text-amber-300 hover:text-amber-200">
              Back to login
            </Link>
          </>
        )}
      </div>
    </main>
  );
}

export default function VerifyEmailPage() {
  return (
    <Suspense>
      <VerifyEmailContent />
    </Suspense>
  );
}
