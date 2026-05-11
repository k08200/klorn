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
            <h1 className="text-xl font-bold mb-3">인증 메일을 보냈습니다</h1>
            <p className="text-stone-400 text-sm mb-6">받은 편지함에서 인증 링크를 눌러 주세요.</p>
            <Link href="/inbox" className="text-sm text-amber-300 hover:text-amber-200">
              결정 큐 열기
            </Link>
          </>
        ) : status === "pending" ? (
          <>
            <h1 className="text-xl font-bold mb-3">이메일 인증이 필요합니다</h1>
            <p className="text-stone-400 text-sm mb-6">
              모든 기능을 사용하려면 이메일 주소를 인증해 주세요.
            </p>
            <button
              type="button"
              onClick={resend}
              className="bg-amber-300 hover:bg-amber-200 text-stone-950 px-6 py-2.5 rounded-lg text-sm font-semibold transition-colors"
            >
              인증 메일 다시 보내기
            </button>
          </>
        ) : (
          <>
            <h1 className="text-xl font-bold mb-3">인증에 실패했습니다</h1>
            <p className="text-stone-400 text-sm mb-6">링크가 만료되었거나 올바르지 않습니다.</p>
            <Link href="/login" className="text-sm text-amber-300 hover:text-amber-200">
              로그인으로 돌아가기
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
