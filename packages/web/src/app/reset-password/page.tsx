"use client";

import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { Suspense, useState } from "react";
import { useToast } from "../../components/toast";
import { apiFetch } from "../../lib/api";

export default function ResetPasswordPage() {
  return (
    <Suspense>
      <ResetPasswordForm />
    </Suspense>
  );
}

function ResetPasswordForm() {
  const searchParams = useSearchParams();
  const token = searchParams.get("token");

  // Without a token, show the reset-link request form.
  if (!token) {
    return <ForgotPasswordForm />;
  }

  return <NewPasswordForm token={token} />;
}

function ForgotPasswordForm() {
  const [email, setEmail] = useState("");
  const [loading, setLoading] = useState(false);
  const [sent, setSent] = useState(false);
  const { toast } = useToast();

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!email) return;
    setLoading(true);
    try {
      await apiFetch("/api/auth/forgot-password", {
        method: "POST",
        body: JSON.stringify({ email }),
      });
      setSent(true);
    } catch {
      toast("재설정 링크를 보내지 못했습니다.", "error");
    }
    setLoading(false);
  };

  if (sent) {
    return (
      <main className="flex items-center justify-center min-h-[calc(100vh-3rem)] px-4">
        <div className="w-full max-w-sm text-center">
          <h1 className="text-xl font-bold mb-3">메일을 확인하세요</h1>
          <p className="text-stone-400 text-sm mb-6">
            해당 이메일 계정이 있다면 비밀번호 재설정 링크를 보냈습니다.
          </p>
          <Link href="/login" className="text-sm text-amber-300 hover:text-amber-200">
            로그인으로 돌아가기
          </Link>
        </div>
      </main>
    );
  }

  return (
    <main className="flex items-center justify-center min-h-[calc(100vh-3rem)] px-4">
      <div className="w-full max-w-sm">
        <div className="text-center mb-8">
          <h1 className="text-xl font-bold">비밀번호 재설정</h1>
          <p className="text-stone-500 text-xs mt-1.5">
            이메일을 입력하면 재설정 링크를 보내드립니다
          </p>
        </div>

        <form onSubmit={handleSubmit} className="space-y-3">
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

          <button
            type="submit"
            disabled={loading || !email}
            className="w-full bg-amber-300 hover:bg-amber-200 disabled:bg-stone-900 disabled:text-stone-500 disabled:cursor-not-allowed text-stone-950 py-2.5 rounded-lg text-sm font-semibold transition-colors"
          >
            {loading ? "전송 중..." : "재설정 링크 보내기"}
          </button>
        </form>

        <div className="text-center mt-4">
          <Link
            href="/login"
            className="text-xs text-stone-500 hover:text-amber-300 transition-colors"
          >
            로그인으로 돌아가기
          </Link>
        </div>
      </div>
    </main>
  );
}

function NewPasswordForm({ token }: { token: string }) {
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [loading, setLoading] = useState(false);
  const [done, setDone] = useState(false);
  const { toast } = useToast();

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (password !== confirm) {
      toast("비밀번호가 일치하지 않습니다.", "error");
      return;
    }
    setLoading(true);
    try {
      await apiFetch("/api/auth/reset-password", {
        method: "POST",
        body: JSON.stringify({ token, newPassword: password }),
      });
      setDone(true);
    } catch (err) {
      toast(err instanceof Error ? err.message : "재설정에 실패했습니다.", "error");
    }
    setLoading(false);
  };

  if (done) {
    return (
      <main className="flex items-center justify-center min-h-[calc(100vh-3rem)] px-4">
        <div className="w-full max-w-sm text-center">
          <h1 className="text-xl font-bold mb-3">비밀번호 재설정 완료</h1>
          <p className="text-stone-400 text-sm mb-6">비밀번호가 정상적으로 변경되었습니다.</p>
          <Link href="/login" className="text-sm text-amber-300 hover:text-amber-200">
            로그인
          </Link>
        </div>
      </main>
    );
  }

  return (
    <main className="flex items-center justify-center min-h-[calc(100vh-3rem)] px-4">
      <div className="w-full max-w-sm">
        <div className="text-center mb-8">
          <h1 className="text-xl font-bold">새 비밀번호</h1>
          <p className="text-stone-500 text-xs mt-1.5">새 비밀번호를 입력하세요</p>
        </div>

        <form onSubmit={handleSubmit} className="space-y-3">
          <div>
            <label htmlFor="password" className="block text-xs font-medium text-stone-400 mb-1.5">
              새 비밀번호
            </label>
            <input
              id="password"
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              placeholder="6자 이상"
              required
              minLength={6}
              className="w-full bg-stone-950 border border-stone-800 rounded-lg px-4 py-2.5 text-sm focus:outline-none focus:border-amber-300 focus:ring-1 focus:ring-amber-300/25 transition placeholder-stone-500"
            />
          </div>

          <div>
            <label htmlFor="confirm" className="block text-xs font-medium text-stone-400 mb-1.5">
              비밀번호 확인
            </label>
            <input
              id="confirm"
              type="password"
              value={confirm}
              onChange={(e) => setConfirm(e.target.value)}
              placeholder="비밀번호 다시 입력"
              required
              minLength={6}
              className="w-full bg-stone-950 border border-stone-800 rounded-lg px-4 py-2.5 text-sm focus:outline-none focus:border-amber-300 focus:ring-1 focus:ring-amber-300/25 transition placeholder-stone-500"
            />
          </div>

          <button
            type="submit"
            disabled={loading || !password || !confirm}
            className="w-full bg-amber-300 hover:bg-amber-200 disabled:bg-stone-900 disabled:text-stone-500 disabled:cursor-not-allowed text-stone-950 py-2.5 rounded-lg text-sm font-semibold transition-colors"
          >
            {loading ? "재설정 중..." : "비밀번호 재설정"}
          </button>
        </form>
      </div>
    </main>
  );
}
