"use client";

import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { Suspense, useEffect, useState } from "react";
import { useToast } from "../../components/toast";
import { API_BASE } from "../../lib/api";
import { useAuth } from "../../lib/auth";

export default function LoginPage() {
  return (
    <Suspense>
      <LoginForm />
    </Suspense>
  );
}

function LoginForm() {
  const [mode, setMode] = useState<"login" | "register">("login");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [name, setName] = useState("");
  const [loading, setLoading] = useState(false);
  const { login, register, user, loading: authLoading } = useAuth();
  const { toast } = useToast();
  const router = useRouter();
  const searchParams = useSearchParams();

  useEffect(() => {
    if (!authLoading && user) {
      router.push("/inbox");
    }
  }, [user, authLoading, router]);

  // Surface redirect feedback from Google OAuth and email verification.
  useEffect(() => {
    const error = searchParams.get("error");
    const verified = searchParams.get("verified");
    if (error) {
      const message =
        error === "google_failed"
          ? "Google 로그인에 실패했습니다. 다시 시도해 주세요."
          : error === "session_expired"
            ? "세션이 만료되었습니다. 다시 로그인해 주세요."
            : error;
      toast(message, "error");
    }
    if (verified) {
      toast("이메일 인증이 완료되었습니다. 로그인할 수 있어요.", "success");
    }
  }, [searchParams, toast]);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!email || !password) return;

    setLoading(true);
    try {
      if (mode === "login") {
        await login(email, password);
        toast("다시 오신 것을 환영합니다.", "success");
      } else {
        await register(email, password, name || undefined);
        toast("계정을 만들었습니다.", "success");
        router.push("/inbox");
        return;
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Something went wrong";
      const match = msg.match(/API \d+: (.+)/);
      const parsed = match
        ? (() => {
            try {
              return JSON.parse(match[1]).error;
            } catch {
              return match[1];
            }
          })()
        : msg;
      toast(parsed, "error");
    }
    setLoading(false);
  };

  if (authLoading) {
    return (
      <main className="flex items-center justify-center min-h-[calc(100vh-3rem)]">
        <div className="w-5 h-5 border-2 border-amber-300 border-t-transparent rounded-full animate-spin" />
      </main>
    );
  }

  return (
    <main className="flex items-center justify-center min-h-[calc(100vh-3rem)] px-4">
      <div className="w-full max-w-sm">
        {/* Logo */}
        <div className="text-center mb-8">
          <h1 className="text-2xl font-bold">
            <span className="text-amber-300">EVE</span>
          </h1>
          <p className="text-stone-500 text-xs mt-1.5">업무 결정을 위한 Decision OS</p>
        </div>

        {/* Form */}
        <form onSubmit={handleSubmit} className="space-y-3">
          {mode === "register" && (
            <div>
              <label htmlFor="name" className="block text-xs font-medium text-stone-400 mb-1.5">
                이름
              </label>
              <input
                id="name"
                type="text"
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="이름"
                className="w-full bg-stone-950 border border-stone-800 rounded-lg px-4 py-2.5 text-sm focus:outline-none focus:border-amber-300 focus:ring-1 focus:ring-amber-300/25 transition placeholder-stone-500"
              />
            </div>
          )}

          <div>
            <label htmlFor="email" className="block text-xs font-medium text-stone-400 mb-1.5">
              이메일
            </label>
            <input
              id="email"
              type="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              placeholder="you@example.com"
              required
              className="w-full bg-stone-950 border border-stone-800 rounded-lg px-4 py-2.5 text-sm focus:outline-none focus:border-amber-300 focus:ring-1 focus:ring-amber-300/25 transition placeholder-stone-500"
            />
          </div>

          <div>
            <label htmlFor="password" className="block text-xs font-medium text-stone-400 mb-1.5">
              비밀번호
            </label>
            <input
              id="password"
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              placeholder={mode === "register" ? "8자 이상" : "비밀번호"}
              required
              minLength={mode === "register" ? 8 : undefined}
              className="w-full bg-stone-950 border border-stone-800 rounded-lg px-4 py-2.5 text-sm focus:outline-none focus:border-amber-300 focus:ring-1 focus:ring-amber-300/25 transition placeholder-stone-500"
            />
          </div>

          <button
            type="submit"
            disabled={loading || !email || !password}
            className="w-full bg-amber-300 hover:bg-amber-200 disabled:bg-stone-900 disabled:text-stone-500 disabled:cursor-not-allowed text-stone-950 py-2.5 rounded-lg text-sm font-semibold transition-colors shadow-sm shadow-amber-300/20"
          >
            {loading ? (
              <span className="flex items-center justify-center gap-2">
                <span className="w-3.5 h-3.5 border-2 border-white border-t-transparent rounded-full animate-spin" />
                {mode === "login" ? "로그인 중..." : "계정 생성 중..."}
              </span>
            ) : mode === "login" ? (
              "로그인"
            ) : (
              "계정 만들기"
            )}
          </button>
        </form>

        {/* Toggle mode + forgot password */}
        <div className="text-center mt-4 space-y-2">
          <button
            type="button"
            onClick={() => setMode(mode === "login" ? "register" : "login")}
            className="text-xs text-stone-500 hover:text-amber-300 transition-colors"
          >
            {mode === "login" ? "계정이 없나요? 가입하기" : "이미 계정이 있나요? 로그인"}
          </button>
          {mode === "login" && (
            <div>
              <Link
                href="/reset-password"
                className="text-xs text-stone-600 hover:text-amber-300 transition-colors"
              >
                비밀번호를 잊으셨나요?
              </Link>
            </div>
          )}
        </div>

        {/* Divider */}
        <div className="flex items-center gap-3 my-5">
          <div className="flex-1 h-px bg-stone-800/80" />
          <span className="text-xs text-stone-600">또는</span>
          <div className="flex-1 h-px bg-stone-800/80" />
        </div>

        {/* Google login button */}
        <a
          href={`${API_BASE}/api/auth/google/login`}
          className="flex items-center justify-center gap-3 w-full bg-white hover:bg-stone-100 text-stone-800 py-2.5 rounded-lg text-sm font-medium transition-colors border border-stone-300"
        >
          <svg aria-hidden="true" className="w-4 h-4" viewBox="0 0 24 24">
            <path
              fill="#4285F4"
              d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92a5.06 5.06 0 0 1-2.2 3.32v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.1z"
            />
            <path
              fill="#34A853"
              d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z"
            />
            <path
              fill="#FBBC05"
              d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.93l2.85-2.22.81-.62z"
            />
            <path
              fill="#EA4335"
              d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z"
            />
          </svg>
          Google로 계속하기
          <span className="text-[10px] text-stone-500 bg-stone-200 px-1.5 py-0.5 rounded font-normal">
            베타
          </span>
        </a>
        <p className="text-[10px] text-stone-600 text-center mt-1.5">
          Google 로그인은 검토 중입니다. 이메일 가입은 바로 사용할 수 있어요.
        </p>

        {/* Back to home */}
        <div className="text-center mt-5">
          <Link href="/" className="text-xs text-stone-600 hover:text-stone-400 transition-colors">
            홈으로 돌아가기
          </Link>
        </div>
      </div>
    </main>
  );
}
