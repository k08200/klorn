"use client";

import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { Suspense, useEffect, useState } from "react";
import AuthScreen from "../../components/auth-screen";
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
      const msg = err instanceof Error ? err.message : "문제가 발생했습니다.";
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
      <main className="flex min-h-screen items-center justify-center bg-[#10100d]">
        <div className="h-5 w-5 animate-spin rounded-full border-2 border-amber-300 border-t-transparent" />
      </main>
    );
  }

  return (
    <AuthScreen
      eyebrow={mode === "login" ? "Welcome back" : "Create account"}
      title={mode === "login" ? "결정 큐로 돌아가기" : "Jigeum 시작하기"}
      description={
        mode === "login"
          ? "메일, 캘린더, 작업 신호를 다시 연결하고 오늘 승인해야 할 항목부터 확인하세요."
          : "팀의 업무 신호를 결정 카드로 정리할 계정을 만듭니다."
      }
      footer={
        <Link href="/" className="transition hover:text-stone-300">
          홈으로 돌아가기
        </Link>
      }
    >
      <div className="mb-5 grid grid-cols-2 rounded-md border border-stone-700/70 bg-black/20 p-1">
        <button
          type="button"
          onClick={() => setMode("login")}
          className={`h-9 rounded px-3 text-sm font-medium transition ${
            mode === "login" ? "bg-stone-100 text-stone-950" : "text-stone-500 hover:text-stone-200"
          }`}
        >
          로그인
        </button>
        <button
          type="button"
          onClick={() => setMode("register")}
          className={`h-9 rounded px-3 text-sm font-medium transition ${
            mode === "register"
              ? "bg-stone-100 text-stone-950"
              : "text-stone-500 hover:text-stone-200"
          }`}
        >
          가입
        </button>
      </div>

      <form onSubmit={handleSubmit} className="space-y-4">
        {mode === "register" && (
          <div>
            <label htmlFor="name" className="mb-1.5 block text-xs font-medium text-stone-400">
              이름
            </label>
            <input
              id="name"
              type="text"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="이름"
              className="w-full rounded-md border border-stone-700 bg-stone-950 px-4 py-3 text-sm text-stone-100 outline-none transition placeholder:text-stone-600 focus:border-amber-300 focus:ring-1 focus:ring-amber-300/25"
            />
          </div>
        )}

        <div>
          <label htmlFor="email" className="mb-1.5 block text-xs font-medium text-stone-400">
            이메일
          </label>
          <input
            id="email"
            type="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            placeholder="you@example.com"
            required
            className="w-full rounded-md border border-stone-700 bg-stone-950 px-4 py-3 text-sm text-stone-100 outline-none transition placeholder:text-stone-600 focus:border-amber-300 focus:ring-1 focus:ring-amber-300/25"
          />
        </div>

        <div>
          <div className="mb-1.5 flex items-center justify-between gap-3">
            <label htmlFor="password" className="block text-xs font-medium text-stone-400">
              비밀번호
            </label>
            {mode === "login" && (
              <Link
                href="/reset-password"
                className="text-xs text-stone-500 transition hover:text-amber-300"
              >
                비밀번호 재설정
              </Link>
            )}
          </div>
          <input
            id="password"
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            placeholder={mode === "register" ? "8자 이상" : "비밀번호"}
            required
            minLength={mode === "register" ? 8 : undefined}
            className="w-full rounded-md border border-stone-700 bg-stone-950 px-4 py-3 text-sm text-stone-100 outline-none transition placeholder:text-stone-600 focus:border-amber-300 focus:ring-1 focus:ring-amber-300/25"
          />
        </div>

        <button
          type="submit"
          disabled={loading || !email || !password}
          className="flex h-11 w-full items-center justify-center rounded-md bg-amber-300 text-sm font-semibold text-stone-950 shadow-sm shadow-amber-300/20 transition hover:bg-amber-200 disabled:cursor-not-allowed disabled:bg-stone-800 disabled:text-stone-500"
        >
          {loading ? (
            <span className="flex items-center justify-center gap-2">
              <span className="h-3.5 w-3.5 animate-spin rounded-full border-2 border-stone-950 border-t-transparent" />
              {mode === "login" ? "로그인 중..." : "계정 생성 중..."}
            </span>
          ) : mode === "login" ? (
            "결정 큐 열기"
          ) : (
            "계정 만들기"
          )}
        </button>
      </form>

      <div className="my-5 flex items-center gap-3">
        <div className="h-px flex-1 bg-stone-800/80" />
        <span className="text-xs text-stone-600">또는</span>
        <div className="h-px flex-1 bg-stone-800/80" />
      </div>

      <a
        href={`${API_BASE}/api/auth/google/login`}
        className="flex h-11 w-full items-center justify-center gap-3 rounded-md border border-stone-300 bg-white text-sm font-medium text-stone-800 transition hover:bg-stone-100"
      >
        <svg aria-hidden="true" className="h-4 w-4" viewBox="0 0 24 24">
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
        <span className="rounded bg-stone-200 px-1.5 py-0.5 text-[10px] font-normal text-stone-500">
          베타
        </span>
      </a>
      <p className="mt-3 text-center text-[11px] leading-5 text-stone-600">
        Google 로그인은 검토 중입니다. 이메일 가입은 바로 사용할 수 있어요.
      </p>

      <div className="mt-5 border-t border-stone-800/80 pt-4 text-center text-xs text-stone-500">
        {mode === "login" ? "아직 계정이 없다면" : "이미 계정이 있다면"}{" "}
        <button
          type="button"
          onClick={() => setMode(mode === "login" ? "register" : "login")}
          className="font-medium text-amber-300 transition hover:text-amber-200"
        >
          {mode === "login" ? "가입으로 전환" : "로그인으로 전환"}
        </button>
      </div>
    </AuthScreen>
  );
}
